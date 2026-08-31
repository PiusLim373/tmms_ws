import { useEffect, useRef, useState } from 'react'
import { startMapping, stopMapping } from '../../services/rosbridge'
import { WarningModal } from '../ui/WarningModal'
import { Toast } from '../ui/Toast'

const MAP_NAME_RE = /^[A-Za-z0-9_]+$/
// Display only, for the empty-state text. mapping_manager_node owns the real path and builds
// <maps_dir>/<name>.pcd itself, so nothing here is ever sent to the robot.
const MAPS_DIR = '~/.htxgrrt/maps'

const mapFileUrl = (filename) =>
  `${window.location.protocol}//${window.location.hostname}:3001/api/maps/${filename}`

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
  { key: 'start', label: 'Create Map' },
  { key: 'manage', label: 'Manage Maps' },
]

export function MappingToolWidget() {
  const [subView, setSubView] = useState('start')
  const [mappingState, setMappingState] = useState({ mapping: false, mapName: null, startedAt: null, lastSavedAgoSeconds: null })
  const [lastFetchedAt, setLastFetchedAt] = useState(Date.now())
  const [nowTick, setNowTick] = useState(Date.now())

  const [maps, setMaps] = useState([])
  const [newMapName, setNewMapName] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingRetry, setPendingRetry] = useState(null)
  const [toastMsg, setToastMsg] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [warningModal, setWarningModal] = useState({ open: false, title: '', body: '', onConfirm: null })

  const toastTimerRef = useRef(null)
  const fileInputRef = useRef(null)

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

  useEffect(() => {
    fetchMappingState()
    const stateInterval = setInterval(fetchMappingState, 5000)
    const tickInterval = setInterval(() => setNowTick(Date.now()), 1000)
    return () => {
      clearInterval(stateInterval)
      clearInterval(tickInterval)
      clearTimeout(toastTimerRef.current)
    }
  }, [])

  useEffect(() => {
    fetchMaps()
  }, [subView])

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
            onClick={() => setSubView(key)}
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

        {subView === 'start' && (
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
          </>
        )}

        {subView === 'manage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No maps found in {MAPS_DIR}/.</div>
            )}
            {maps.map(({ filename, sizeBytes }) => {
              const mapName = filename.replace(/\.pcd$/, '')
              // Highlighted while a session is writing it; that is also the only time it is
              // locked, since FAST-LIO holds no handle on the file once the session ends.
              const isActive = mappingState.mapping && mappingState.mapName === mapName
              return (
                <div
                  key={filename}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    padding: '6px 8px',
                    border: '1px solid var(--border)', borderRadius: 4,
                    borderLeft: isActive ? '3px solid var(--accent-bright)' : '3px solid transparent',
                    background: isActive ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
                  }}
                >
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
                </div>
              )
            })}
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
    </div>
  )
}
