import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNodeParameters, loadPcdForFlattening, republishFlattenedMap, setNodeParameters,
  startMapping, stopMapping, subscribeMapInfo, subscribeOccupancyGrid,
} from '../../services/rosbridge'
import { WarningModal } from '../ui/WarningModal'
import { MapEditorModal } from '../ui/MapEditorModal'
import { Toast } from '../ui/Toast'
import { gridToCells, imageToCells, loadMapImage } from '../../lib/gridCodec'
import { todayPrefix } from '../../lib/dates'

const MAP_NAME_RE = /^[A-Za-z0-9_]+$/
// Display only, for the empty-state text. mapping_manager_node owns the real path and builds
// <maps_dir>/pcd/<name>.pcd itself, so nothing here is ever sent to the robot.
const PCD_DIR = '~/.htxgrrt/maps/pcd'
const PNG_DIR = '~/.htxgrrt/maps/png'

const FLATTENER = '/map_flattener'
// Where the editor gets its grid — NOT the /flattened_map Lichtblick renders during tuning.
// Volatile, published only in response to ~/republish_map, and kept off every Lichtblick
// layout on purpose. See handleOpenEditor for what happens if it ever ends up on one.
const EDITOR_MAP_TOPIC = '/editor_flattened_map'

// Backstop only, now that the map is not waited for but asked for. It has to cover the transfer
// of the whole grid over the websocket, which is tens of MB on a large site.
const GRID_FETCH_TIMEOUT_MS = 20000

const mapFileUrl = (filename) =>
  `${window.location.protocol}//${window.location.hostname}:3001/api/maps/${filename}`
const map2dZipUrl = (name) =>
  `${window.location.protocol}//${window.location.hostname}:3001/api/maps2d/${name}/download`

// The four the operator actually tunes. thres_point_count is the node's spelling (inherited
// from upstream pcd2pgm); do not "fix" it here or the set_parameters call silently no-ops.
const SLIDERS = [
  {
    name: 'thre_z_min', label: 'Height band — bottom', unit: 'm', min: -5, max: 5, step: 0.05,
    hint: 'Ignore everything below this height. Raise it to drop the floor; note the height is '
        + 'measured from where the robot started mapping, not from the ground.',
  },
  {
    name: 'thre_z_max', label: 'Height band — top', unit: 'm', min: -5, max: 5, step: 0.05,
    hint: 'Ignore everything above this height. Lower it to drop ceilings, pipes and lighting '
        + 'the robot can safely drive under.',
  },
  {
    name: 'thre_radius', label: 'Outlier search radius', unit: 'm', min: 0.01, max: 1, step: 0.01,
    hint: 'How far around each point to look for neighbours. Larger keeps more, and costs '
        + 'noticeably more time per rebuild.',
  },
  {
    name: 'thres_point_count', label: 'Min neighbours to keep', unit: '', min: 0, max: 200, step: 1,
    integer: true,
    hint: 'A point with fewer neighbours than this inside the radius is treated as noise and '
        + 'dropped. Raise it to clear speckle, lower it to keep thin walls.',
  },
]
const SLIDER_DEFAULTS = { thre_z_min: 0.1, thre_z_max: 1.45, thre_radius: 0.1, thres_point_count: 10 }

// A rebuild is seconds of RadiusOutlierRemoval and the node coalesces bursts anyway, so
// firing per-pixel-of-drag would only queue work the operator has already moved past.
const SLIDER_DEBOUNCE_MS = 350

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

function formatAgo(seconds) {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s ago`
  const min = Math.floor(seconds / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ago`
}

const SUB_VIEWS = [
  { key: 'maps3d', label: 'Manage 3D Maps' },
  { key: 'maps2d', label: 'Manage 2D Maps' },
]

// Where in the 2D flow the operator was. The tab itself is persisted by MappingPage, which owns
// it. Everything else about a half-finished 2D map lives on the robot and is read back from
// there rather than mirrored here, so these two are the whole of it.
const CREATING_KEY = 'tmms.mapping.creating'
const SELECTED_PCD_KEY = 'tmms.mapping.selectedPcd'

// props:
//   subView          'maps3d' | 'maps2d' — owned by MappingPage, which derives the Lichtblick
//                    layout from it and persists it
//   onSubViewChange  (key) => void
export function MappingToolWidget({ subView, onSubViewChange }) {
  const [mappingState, setMappingState] = useState({ mapping: false, mapName: null, startedAt: null, lastSavedAgoSeconds: null })
  const [lastFetchedAt, setLastFetchedAt] = useState(Date.now())
  const [nowTick, setNowTick] = useState(Date.now())

  const [maps, setMaps] = useState([])
  const [maps2d, setMaps2d] = useState([])
  // Seeded with today's YYMMDD_ so the operator only types the descriptive half.
  const [newMapName, setNewMapName] = useState(todayPrefix)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingRetry, setPendingRetry] = useState(null)
  const [toastMsg, setToastMsg] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [warningModal, setWarningModal] = useState({ open: false, title: '', body: '', onConfirm: null })

  // 2D create flow. `creating` and `selectedPcd` are browser state with nothing on the robot
  // to recover them from, so they are the two pieces that get persisted; loadedPcd and the
  // slider values are read back off map_flattener instead — see the mapInfo effect below.
  const [creating, setCreating] = useState(() => localStorage.getItem(CREATING_KEY) === '1')
  const [selectedPcd, setSelectedPcd] = useState(() => localStorage.getItem(SELECTED_PCD_KEY) ?? '')
  const [loadedPcd, setLoadedPcd] = useState(null)
  const [sliders, setSliders] = useState(SLIDER_DEFAULTS)
  const [mapInfo, setMapInfo] = useState(null)
  const [rebuilding, setRebuilding] = useState(false)

  const [editor, setEditor] = useState(null)   // null | { source }
  const [openingEditor, setOpeningEditor] = useState(false)

  const toastTimerRef = useRef(null)
  const fileInputRef = useRef(null)
  const upload2dInputRef = useRef(null)
  const sliderTimerRef = useRef(null)

  function showToast(message) {
    setToastMsg(message)
    clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 4000)
  }

  function fetchMappingState() {
    fetch('/api/mapping-state')
      .then((r) => r.json())
      .then((data) => { setMappingState(data); setLastFetchedAt(Date.now()) })
      .catch((err) => console.error('[MappingToolWidget] fetch mapping-state failed:', err))
  }

  function fetchMaps() {
    fetch('/api/maps')
      .then((r) => r.json())
      .then(setMaps)
      .catch((err) => console.error('[MappingToolWidget] fetch maps failed:', err))
  }

  const fetchMaps2d = useCallback(() => {
    fetch('/api/maps2d')
      .then((r) => r.json())
      .then(setMaps2d)
      .catch((err) => console.error('[MappingToolWidget] fetch maps2d failed:', err))
  }, [])

  useEffect(() => {
    fetchMappingState()
    const stateInterval = setInterval(fetchMappingState, 5000)
    const tickInterval = setInterval(() => setNowTick(Date.now()), 1000)
    return () => {
      clearInterval(stateInterval)
      clearInterval(tickInterval)
      clearTimeout(toastTimerRef.current)
      clearTimeout(sliderTimerRef.current)
    }
  }, [])

  useEffect(() => {
    fetchMaps()
    fetchMaps2d()
  }, [subView, fetchMaps2d])

  useEffect(() => { localStorage.setItem(CREATING_KEY, creating ? '1' : '0') }, [creating])
  useEffect(() => { localStorage.setItem(SELECTED_PCD_KEY, selectedPcd) }, [selectedPcd])

  // Pulls the thresholds back off the node, once, the first time it reports a cloud loaded.
  // Trusting SLIDER_DEFAULTS instead would put the defaults on screen beside a map that was
  // built from quite different values — a lie the operator has no way to spot. Set by
  // handleLoadPcd too, which has just pushed the panel's own values and has nothing to read
  // back.
  const slidersSyncedRef = useRef(false)
  const syncSlidersFromNode = useCallback(() => {
    if (slidersSyncedRef.current) return
    slidersSyncedRef.current = true
    getNodeParameters(FLATTENER, SLIDERS.map(({ name }) => name),
      (values) => setSliders((prev) => ({ ...prev, ...values })),
      (err) => console.error('[MappingToolWidget] get_parameters failed:', err))
  }, [])

  // Latched, so this fires once on subscribe with whatever the flattener last built — which is
  // also how a reload mid-session picks the state back up.
  //
  // `loaded` is the whole reason a refresh does not cost a re-load: the node still has the
  // cloud, and this message says which one, so the panel can come straight back to it. It is
  // empty when the flattener has been restarted, which correctly clears the panel instead of
  // offering an edit of a map nothing is holding any more.
  useEffect(() => {
    return subscribeMapInfo((info) => {
      setMapInfo(info)
      setRebuilding(false)
      setLoadedPcd(info.loaded || null)
      if (info.loaded) syncSlidersFromNode()
    })
  }, [syncSlidersFromNode])

  const liveLastSavedAgoSeconds = mappingState.lastSavedAgoSeconds == null
    ? null
    : mappingState.lastSavedAgoSeconds + Math.floor((nowTick - lastFetchedAt) / 1000)

  function postMappingState(body) {
    return fetch('/api/mapping-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) throw new Error(`backend sync failed (${r.status})`)
      return r.json()
    })
  }

  function syncBackendState(body, successMsg) {
    postMappingState(body)
      .then((data) => {
        setMappingState((prev) => ({ ...prev, ...data }))
        setLastFetchedAt(Date.now())
        setPendingRetry(null)
        setBusy(false)
        if (successMsg) showToast(successMsg)
      })
      .catch(() => {
        showToast('Robot updated, but UI state sync failed — use Retry state sync below.')
        setPendingRetry(body)
        setBusy(false)
      })
  }

  function handleRetrySync() {
    if (!pendingRetry) return
    setBusy(true)
    syncBackendState(pendingRetry)
  }

  // start_mapping/stop_mapping return success + message, and roslib delivers a rejected
  // request through the SUCCESS callback — a transport-level success carrying success: false.
  // So both handlers branch on res.success and show res.message rather than assuming the
  // callback firing means it worked.
  function doStartMapping(mapName) {
    setBusy(true)
    startMapping(mapName,
      (res) => {
        if (!res.success) { showToast(res.message || 'Start mapping failed'); setBusy(false); return }
        syncBackendState({ action: 'start', mapName }, `Mapping started: ${mapName}`)
      },
      (err) => { showToast(`start_mapping failed: ${err}`); setBusy(false) }
    )
  }

  function handleStartClick() {
    if (mappingState.mapping || !MAP_NAME_RE.test(newMapName)) return
    const exists = maps.some((m) => m.filename === `${newMapName}.pcd`)
    if (exists) {
      setWarningModal({
        open: true,
        title: `Map "${newMapName}" already exists`,
        body: 'Starting a new mapping session with this name will overwrite the existing map data. This cannot be undone.',
        onConfirm: () => {
          setWarningModal((w) => ({ ...w, open: false }))
          doStartMapping(newMapName)
        },
      })
    } else {
      doStartMapping(newMapName)
    }
  }

  // stop_mapping runs /map_save to completion before killing the launch, so this call is
  // held open for the entire PCD write. `saving` drives a visible state for that wait.
  function handleEndMapping() {
    setBusy(true)
    setSaving(true)
    stopMapping(
      (res) => {
        setSaving(false)
        // The session is over either way — mapping_manager tears the launch down even when
        // the save fails — so sync the backend regardless and report what actually happened.
        syncBackendState({ action: 'end' }, res.success ? 'Map saved — mapping ended.' : null)
        if (!res.success) showToast(res.message || 'Map save failed — session ended anyway')
        fetchMaps()
      },
      (err) => { setSaving(false); showToast(`stop_mapping failed: ${err}`); setBusy(false) }
    )
  }

  function doUpload(file) {
    setBusy(true)
    const formData = new FormData()
    formData.append('file', file)
    fetch('/api/maps', { method: 'POST', body: formData })
      .then((r) => {
        if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `upload failed (${r.status})`) })
        return r.json()
      })
      .then(({ filename, overwritten }) => {
        showToast(overwritten ? `Replaced ${filename}` : `Uploaded ${filename}`)
        fetchMaps()
        setBusy(false)
      })
      .catch((err) => { showToast(`Upload failed: ${err.message}`); setBusy(false) })
  }

  function handleFileSelect(e) {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    if (!/^[A-Za-z0-9_]+\.pcd$/.test(file.name)) {
      setUploadError('Filename must match [A-Za-z0-9_]+.pcd')
      return
    }
    setUploadError(null)
    const exists = maps.some((m) => m.filename === file.name)
    if (exists) {
      setWarningModal({
        open: true,
        title: `"${file.name}" already exists`,
        body: 'Uploading will overwrite the existing map file on disk. This cannot be undone.',
        onConfirm: () => {
          setWarningModal((w) => ({ ...w, open: false }))
          doUpload(file)
        },
      })
    } else {
      doUpload(file)
    }
  }

  function doDeleteMap(filename) {
    setBusy(true)
    fetch(`/api/maps/${filename}`, { method: 'DELETE' })
      .then((r) => {
        if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `delete failed (${r.status})`) })
        return r.json()
      })
      .then(() => {
        showToast(`Deleted ${filename}`)
        fetchMaps()
        setBusy(false)
      })
      .catch((err) => { showToast(`Delete failed: ${err.message}`); setBusy(false) })
  }

  function handleDeleteMap(filename) {
    // Only guard the map of a LIVE session. mappingState.mapName deliberately survives
    // action:'end', and under FAST-LIO nothing holds the .pcd once the session is over —
    // keying on the name alone would block deleting the map you just finished.
    const mapName = filename.replace(/\.pcd$/, '')
    if (mappingState.mapping && mappingState.mapName === mapName) return
    setWarningModal({
      open: true,
      title: `Delete "${filename}"?`,
      body: 'This will permanently remove the map file from disk. This cannot be undone.',
      onConfirm: () => {
        setWarningModal((w) => ({ ...w, open: false }))
        doDeleteMap(filename)
      },
    })
  }

  // -- 2D maps -------------------------------------------------------------

  function handleLoadPcd() {
    if (!selectedPcd) return
    setBusy(true)
    setRebuilding(true)
    setMapInfo(null)
    loadPcdForFlattening(selectedPcd,
      (res) => {
        setBusy(false)
        if (!res.success) {
          setRebuilding(false)
          showToast(res.message || 'load_pcd failed')
          return
        }
        setLoadedPcd(selectedPcd)
        // Push the current slider values so the node matches what the panel shows — it keeps
        // whatever the last session left set, which need not be these. That also settles the
        // direction of the sync for this session: the panel is now authoritative, so the
        // read-back must not fire and overwrite it.
        slidersSyncedRef.current = true
        pushSliders(sliders)
      },
      (err) => { setBusy(false); setRebuilding(false); showToast(`load_pcd failed: ${err}`) }
    )
  }

  function pushSliders(values) {
    setRebuilding(true)
    setNodeParameters(FLATTENER,
      SLIDERS.map(({ name, integer }) => ({ name, value: values[name], integer: !!integer })),
      (res) => {
        const bad = (res.results || []).find((r) => !r.successful)
        if (bad) { setRebuilding(false); showToast(`parameter rejected: ${bad.reason}`) }
      },
      (err) => { setRebuilding(false); showToast(`set_parameters failed: ${err}`) }
    )
  }

  function handleSliderChange(name, value) {
    const next = { ...sliders, [name]: value }
    setSliders(next)
    if (!loadedPcd) return
    clearTimeout(sliderTimerRef.current)
    sliderTimerRef.current = setTimeout(() => pushSliders(next), SLIDER_DEBOUNCE_MS)
  }

  // map_resolution is not a slider — it is left at the node default. This is the one case
  // where the operator needs it: the grid blew past max_map_cells, the node kept the previous
  // map, and without this there is no way out of that from the UI.
  function handleUseSuggestedResolution() {
    if (!mapInfo?.suggested_resolution) return
    setRebuilding(true)
    // Rounded up: the suggestion is the exact boundary, so using it verbatim can land back on
    // the wrong side of the cap after the ceil() in the rasteriser.
    const res = Math.ceil(mapInfo.suggested_resolution * 1000) / 1000
    setNodeParameters(FLATTENER, [{ name: 'map_resolution', value: res }],
      () => showToast(`map_resolution set to ${res} m`),
      (err) => { setRebuilding(false); showToast(`set_parameters failed: ${err}`) })
  }

  // Held open for the whole tuning step, not opened around the click.
  //
  // Why not /flattened_map, where the map already is: rosbridge keeps one subscription per
  // topic shared across all browser clients, and applies the `raw` flag only for whichever
  // client subscribed first (subscribers.py:350). Lichtblick — running in the iframe next to
  // this widget — subscribes with compression cbor-raw, so rosbridge's subscription to
  // /flattened_map is in raw mode and its callback receives `bytes`. Asking for plain cbor on
  // that same topic makes rosbridge throw
  //     AttributeError: 'bytes' object has no attribute 'get_fields_and_field_types'
  // on its handler thread: nothing is sent to this browser at all, and the read would wait out
  // its timeout with the map plainly visible in Lichtblick a few pixels away.
  // /editor_flattened_map gets its own rosbridge subscription, which Lichtblick never poisons.
  //
  // Why subscribe here rather than in handleOpenEditor: the editor topic is VOLATILE, so a
  // publish that goes out before rosbridge's subscription has been matched with the publisher
  // over DDS is dropped with nothing retained to fall back on. Subscribing at click time and
  // waiting a fixed delay before triggering is a guess about how long that match takes; holding
  // the subscription open for the whole tuning session means it is matched long before the
  // button can be pressed. It costs nothing to hold: this topic is published ONLY by
  // ~/republish_map, so no traffic flows until the operator asks for it.
  const pendingGridRef = useRef(null)
  useEffect(() => {
    if (!creating || !loadedPcd) return undefined
    return subscribeOccupancyGrid(EDITOR_MAP_TOPIC, (msg) => {
      // Only ever act on a grid THIS tab asked for. The subscription is always live now, so a
      // republish triggered from anywhere else — a second browser tab, a `ros2 service call`
      // from a terminal — would otherwise throw the editor open in front of whoever is here.
      const pending = pendingGridRef.current
      if (!pending) return
      pendingGridRef.current = null
      pending(msg)
    })
  }, [creating, loadedPcd])

  function handleOpenEditor() {
    setOpeningEditor(true)
    // Tracked locally rather than off `openingEditor`: the timer below is created in this same
    // tick, so it would close over the pre-setState value and always think it had timed out.
    let settled = false
    // Distinguishes "the flattener has no map" from "the flattener sent one and it never got
    // here", which are the two failures worth telling apart at the 20 s mark.
    let republished = false
    let timer = null
    const finish = () => {
      settled = true
      pendingGridRef.current = null
      clearTimeout(timer)
      setOpeningEditor(false)
    }

    pendingGridRef.current = (msg) => {
      finish()
      if (!msg.info.width || !msg.info.height) {
        showToast('The flattened map is empty — loosen the filters and try again.')
        return
      }
      const grid = gridToCells(msg)
      setEditor({ source: { ...grid, pcdName: loadedPcd, name: null } })
    }

    const giveUp = (message) => {
      if (settled) return
      finish()
      showToast(message)
    }

    republishFlattenedMap(
      // success: false is the flattener saying it has nothing to send — a real answer, and one
      // worth showing straight away instead of sitting out the timeout below.
      (res) => {
        if (res.success) republished = true
        else giveUp(`map_flattener: ${res.message}`)
      },
      (err) => giveUp(`${FLATTENER}/republish_map failed: ${err}`))

    timer = setTimeout(() => giveUp(republished
      ? `map_flattener published the map but nothing reached the browser on `
        + `${EDITOR_MAP_TOPIC} — check rosbridge.`
      : `No response from ${FLATTENER}/republish_map — is map_flattener running?`),
    GRID_FETCH_TIMEOUT_MS)
  }

  async function handleEditMap(entry) {
    setBusy(true)
    try {
      const img = await loadMapImage(entry.name)
      const { cells, width, height } = imageToCells(img)
      setEditor({
        source: {
          cells, width, height,
          resolution: entry.resolution ?? 0.05,
          origin: entry.origin ?? [0, 0, 0],
          // Carried through from the yaml, so a Save As from here keeps pointing at the .pcd
          // this map was originally cut from.
          pcdName: entry.pcdFile ? entry.pcdFile.replace(/^.*\//, '').replace(/\.pcd$/, '') : null,
          name: entry.name,
        },
      })
    } catch (err) {
      showToast(`Could not open ${entry.name}: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveFromEditor(name, blob, meta) {
    const form = new FormData()
    form.append('png', blob, `${name}.png`)
    form.append('meta', JSON.stringify(meta))
    const res = await fetch(`/api/maps2d/${name}`, { method: 'POST', body: form })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `save failed (${res.status})`)
    }
    fetchMaps2d()
    showToast(`Saved ${name}`)
  }

  function handleUpload2d(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    if (files.length !== 2) {
      setUploadError('Select exactly two files: the .png and its .yaml')
      return
    }
    const png = files.find((f) => /\.png$/i.test(f.name))
    const yaml = files.find((f) => /\.ya?ml$/i.test(f.name))
    if (!png || !yaml) {
      setUploadError('Need one .png and one .yaml')
      return
    }
    setUploadError(null)

    const name = png.name.replace(/\.png$/i, '')
    const doIt = () => {
      setBusy(true)
      const form = new FormData()
      form.append('png', png)
      form.append('yaml', yaml)
      fetch('/api/maps2d', { method: 'POST', body: form })
        .then((r) => {
          if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `upload failed (${r.status})`) })
          return r.json()
        })
        .then(({ name: saved, overwritten }) => {
          showToast(overwritten ? `Replaced ${saved}` : `Uploaded ${saved}`)
          fetchMaps2d()
          setBusy(false)
        })
        .catch((err) => { showToast(`Upload failed: ${err.message}`); setBusy(false) })
    }

    if (maps2d.some((m) => m.name === name)) {
      setWarningModal({
        open: true,
        title: `"${name}" already exists`,
        body: 'Uploading will overwrite both the .png and the .yaml on disk. This cannot be undone.',
        onConfirm: () => { setWarningModal((w) => ({ ...w, open: false })); doIt() },
      })
    } else {
      doIt()
    }
  }

  function handleDelete2d(name) {
    setWarningModal({
      open: true,
      title: `Delete "${name}"?`,
      body: `This permanently removes ${name}.png and ${name}.yaml from disk. This cannot be undone.`,
      onConfirm: () => {
        setWarningModal((w) => ({ ...w, open: false }))
        setBusy(true)
        fetch(`/api/maps2d/${name}`, { method: 'DELETE' })
          .then((r) => {
            if (!r.ok) return r.json().then((b) => { throw new Error(b.error || `delete failed (${r.status})`) })
            return r.json()
          })
          .then(() => { showToast(`Deleted ${name}`); fetchMaps2d(); setBusy(false) })
          .catch((err) => { showToast(`Delete failed: ${err.message}`); setBusy(false) })
      },
    })
  }

  const nameInvalid = newMapName.length > 0 && !MAP_NAME_RE.test(newMapName)

  return (
    <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="panel-header">
        Mapping Tool
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Toast visible={toastMsg != null} message={toastMsg ?? ''} />
        </div>
      </div>

      {/* Sub-view switcher */}
      <div className="flex" style={{ gap: 4, padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {SUB_VIEWS.map(({ key, label }) => (
          <button
            key={key}
            className="btn-icon"
            style={{
              flex: 1,
              fontSize: 11,
              padding: '6px 4px',
              ...(subView === key && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }),
            }}
            onClick={() => { onSubViewChange(key); setCreating(false) }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Current session status — always visible, any sub-view */}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div>
            Status:{' '}
            <span style={{ color: mappingState.mapping ? '#22C55E' : 'var(--text-h)' }}>
              {mappingState.mapping ? `MAPPING (${mappingState.mapName})` : 'IDLE'}
            </span>
          </div>
          {mappingState.mapName && (
            <div>Last saved: {formatAgo(liveLastSavedAgoSeconds)}</div>
          )}
          {pendingRetry && (
            <button className="btn-icon" style={{ fontSize: 10, alignSelf: 'flex-start', marginTop: 2 }} onClick={handleRetrySync} disabled={busy}>
              ⟳ Retry state sync
            </button>
          )}
        </div>

        {subView === 'maps3d' && (
          <>
            {mappingState.mapping ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text)' }}>
                  Mapping session active. Drive the robot around to build the map, then end the session when done.
                </div>
                <button
                  className="btn-icon"
                  style={{ padding: '8px 12px', fontSize: 12, borderColor: '#DC2626', color: '#DC2626' }}
                  onClick={handleEndMapping}
                  disabled={busy}
                >
                  {saving ? '⏳ Saving map…' : '■ End Mapping'}
                </button>
                {saving && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    Writing the .pcd to disk. This can take a while on a large map — do not
                    close this page.
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>Map name</label>
                <input
                  value={newMapName}
                  onChange={(e) => setNewMapName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
                  // Land the caret after the date seed, but only while it is untouched —
                  // once there is a name to edit, clicking into the middle must still work.
                  onFocus={(e) => {
                    if (e.target.value === todayPrefix()) {
                      const end = e.target.value.length
                      e.target.setSelectionRange(end, end)
                    }
                  }}
                  placeholder="e.g. warehouse_floor_2"
                  className="val-mono"
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '6px 8px',
                    fontSize: 12,
                    color: 'var(--text-h)',
                  }}
                />
                {nameInvalid && (
                  <div style={{ fontSize: 11, color: '#EF4444' }}>Only letters, numbers, and underscores are allowed.</div>
                )}
                <button
                  className="btn-icon"
                  style={{ padding: '8px 12px', fontSize: 12, marginTop: 4 }}
                  onClick={handleStartClick}
                  disabled={busy || !newMapName || nameInvalid}
                >
                  ▶ Start Mapping
                </button>
              </div>
            )}

            <Divider />

            <div>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '6px 10px' }}
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                ⬆ Upload .pcd file
              </button>
              <input ref={fileInputRef} type="file" accept=".pcd" style={{ display: 'none' }} onChange={handleFileSelect} />
              {uploadError && <div style={{ fontSize: 11, color: '#EF4444', marginTop: 4 }}>{uploadError}</div>}
            </div>

            {mappingState.mapping && (
              <div style={{ fontSize: 11, color: '#EF4444' }}>
                A mapping session is active — its map cannot be deleted until you end it.
              </div>
            )}
            {maps.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No maps found in {PCD_DIR}/.</div>
            )}
            {maps.map(({ filename, sizeBytes }) => {
              const mapName = filename.replace(/\.pcd$/, '')
              // Highlighted while a session is writing it; that is also the only time it is
              // locked, since FAST-LIO holds no handle on the file once the session ends.
              const isActive = mappingState.mapping && mappingState.mapName === mapName
              return (
                <Row key={filename} active={isActive}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-h)', wordBreak: 'break-all' }}>{filename}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                      {formatBytes(sizeBytes)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <a
                      className="btn-icon"
                      style={{ fontSize: 11, padding: '4px 8px', textDecoration: 'none' }}
                      href={mapFileUrl(filename)}
                      download={filename}
                    >
                      ⬇ Download
                    </a>
                    <button
                      className="btn-icon"
                      style={{ fontSize: 11, padding: '4px 8px', borderColor: '#DC2626', color: '#DC2626' }}
                      onClick={() => handleDeleteMap(filename)}
                      disabled={busy || isActive}
                      title={isActive ? 'Cannot delete the map being written right now' : undefined}
                    >
                      ✕ Delete
                    </button>
                  </div>
                </Row>
              )
            })}
          </>
        )}

        {subView === 'maps2d' && !creating && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              Navigation maps: a .png grid plus the .yaml that gives it a scale and an origin.
              Both are needed — a map missing either half is not listed.
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '6px 10px' }}
                onClick={() => { setCreating(true); setLoadedPcd(null); setMapInfo(null) }}
                disabled={busy}
              >
                ＋ Create from 3D map
              </button>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '6px 10px' }}
                onClick={() => upload2dInputRef.current?.click()}
                disabled={busy}
              >
                ⬆ Upload .png + .yaml
              </button>
              <input
                ref={upload2dInputRef} type="file" accept=".png,.yaml,.yml" multiple
                style={{ display: 'none' }} onChange={handleUpload2d}
              />
            </div>
            {uploadError && <div style={{ fontSize: 11, color: '#EF4444' }}>{uploadError}</div>}

            {maps2d.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No maps found in {PNG_DIR}/.</div>
            )}
            {maps2d.map((entry) => (
              <Row key={entry.name}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-h)', wordBreak: 'break-all' }}>
                    {entry.name}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                    {entry.width && entry.height ? `${entry.width}×${entry.height} px` : '? px'}
                    {entry.resolution ? ` · ${entry.resolution} m/px` : ''}
                    {' · '}{formatBytes(entry.pngBytes)}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                    {entry.pcdFile ? `from ${entry.pcdFile.replace(/^.*\//, '')}` : 'no source .pcd recorded'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    className="btn-icon" style={{ fontSize: 11, padding: '4px 8px' }}
                    onClick={() => handleEditMap(entry)} disabled={busy}
                  >
                    ✎ Edit
                  </button>
                  <a
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '4px 8px', textDecoration: 'none' }}
                    href={map2dZipUrl(entry.name)}
                    download={`${entry.name}_map.zip`}
                  >
                    ⬇ Download
                  </a>
                  <button
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '4px 8px', borderColor: '#DC2626', color: '#DC2626' }}
                    onClick={() => handleDelete2d(entry.name)} disabled={busy}
                  >
                    ✕ Delete
                  </button>
                </div>
              </Row>
            ))}
          </div>
        )}

        {subView === 'maps2d' && creating && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn-icon" style={{ fontSize: 11, alignSelf: 'flex-start' }}
              onClick={() => setCreating(false)} disabled={busy}
            >
              ◂ Back to 2D maps
            </button>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
                Source 3D map
              </label>
              <select
                value={selectedPcd}
                onChange={(e) => setSelectedPcd(e.target.value)}
                className="val-mono"
                style={{
                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
                  padding: '6px 8px', fontSize: 12, color: 'var(--text-h)',
                }}
              >
                <option value="">Select a .pcd…</option>
                {maps.map(({ filename }) => (
                  <option key={filename} value={filename.replace(/\.pcd$/, '')}>{filename}</option>
                ))}
              </select>
              <button
                className="btn-icon" style={{ fontSize: 12, padding: '6px 10px' }}
                onClick={handleLoadPcd} disabled={busy || !selectedPcd}
              >
                ▶ Load &amp; flatten
              </button>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Watch the result in the Lichtblick pane on the left: the 2D grid on
                /flattened_map, and /flattened_cloud for the slice of the point cloud that
                produced it.
              </div>
            </div>

            {loadedPcd && (
              <>
                <Divider />
                {/* Rebuild state rides on this row rather than sitting under the sliders: the
                    four of them are taller than a short screen, and "is what I am looking at
                    current?" is not a question worth scrolling for. */}
                <div
                  className="flex items-center justify-between"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', gap: 8 }}
                >
                  <span>
                    Loaded: <span style={{ color: 'var(--text-h)' }}>{loadedPcd}</span>
                  </span>
                  {rebuilding && (
                    <span style={{ color: 'var(--accent-blue)', flexShrink: 0 }}>⏳ rebuilding…</span>
                  )}
                </div>

                {SLIDERS.map(({ name, label, unit, min, max, step, hint }) => (
                  <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div className="flex items-center justify-between">
                      <label style={{ fontSize: 11, color: 'var(--text-h)' }}>{label}</label>
                      <span className="val-mono">{sliders[name]}{unit && ` ${unit}`}</span>
                    </div>
                    <input
                      type="range" min={min} max={max} step={step} value={sliders[name]}
                      onChange={(e) => handleSliderChange(name, Number(e.target.value))}
                      style={{ width: '100%' }}
                      disabled={busy}
                    />
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.35 }}>{hint}</div>
                  </div>
                ))}

                {/* Dimmed rather than replaced while a rebuild runs: these are the figures for
                    the PREVIOUS grid until the new info lands, and they should read as stale
                    instead of quietly passing for current. */}
                <div style={{ opacity: rebuilding ? 0.45 : 1, transition: 'opacity 0.15s' }}>
                  <MapInfoReadout
                    info={mapInfo}
                    onUseSuggested={handleUseSuggestedResolution}
                    busy={busy}
                  />
                </div>

                <button
                  className="btn-icon"
                  style={{ padding: '8px 12px', fontSize: 12, borderColor: 'var(--accent-bright)' }}
                  onClick={handleOpenEditor}
                  disabled={busy || openingEditor || rebuilding || !mapInfo?.ok}
                >
                  {openingEditor ? '⏳ Loading map…' : 'Confirm → open editor'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <WarningModal
        open={warningModal.open}
        title={warningModal.title}
        body={warningModal.body}
        onConfirm={warningModal.onConfirm}
        onCancel={() => setWarningModal((w) => ({ ...w, open: false }))}
      />

      <MapEditorModal
        open={editor != null}
        source={editor?.source}
        existingNames={maps2d.map((m) => m.name)}
        onSave={handleSaveFromEditor}
        onClose={() => { setEditor(null); setCreating(false); fetchMaps2d() }}
      />
    </div>
  )
}

// The rebuild indicator used to live here, replacing the whole readout. It now rides on the
// "Loaded:" row above the sliders, where it is visible without scrolling.
function MapInfoReadout({ info, onUseSuggested, busy }) {
  if (!info) return null

  if (!info.ok) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: '#EF4444', lineHeight: 1.4 }}>
          ⚠ {info.message || 'The last rebuild failed; the previous map is still shown.'}
        </div>
        {info.suggested_resolution > 0 && (
          <button className="btn-icon" style={{ fontSize: 11, alignSelf: 'flex-start' }}
            onClick={onUseSuggested} disabled={busy}>
            Use {(Math.ceil(info.suggested_resolution * 1000) / 1000)} m/px
          </button>
        )}
      </div>
    )
  }

  const megapixels = (info.width * info.height) / 1e6
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
      <div>
        Grid: <span style={{ color: 'var(--text-h)' }}>{info.width} × {info.height}</span>
        {' '}at {info.resolution} m/px
      </div>
      <div>Points: {info.in_band.toLocaleString()} in band → {info.kept.toLocaleString()} kept</div>
      {megapixels > 12 && (
        <div style={{ color: '#F59E0B' }}>
          ⚠ {megapixels.toFixed(0)} MP — the editor will be slow and may use over
          {' '}{(megapixels * 5).toFixed(0)} MB of memory.
        </div>
      )}
    </div>
  )
}

function Divider() {
  return <div style={{ borderTop: '1px solid var(--border)', margin: '2px 0' }} />
}

function Row({ children, active }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '6px 8px',
        border: '1px solid var(--border)', borderRadius: 4,
        borderLeft: active ? '3px solid var(--accent-bright)' : '3px solid transparent',
        background: active ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
      }}
    >
      {children}
    </div>
  )
}
