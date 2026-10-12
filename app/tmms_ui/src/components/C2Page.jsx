import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTopicActivity } from '../hooks/useTopicActivity'
import { ResizeHandle } from './ui/ResizeHandle'
import {
  ZoomControls, ViewToggle, ScaleBar, CoordReadout,
} from './ui/C2MapControls'
import { C2MapCanvas } from './widgets/C2MapCanvas'
import { C2PoiHoverCard, C2PoiViewer } from './widgets/C2PoiPhotos'
import { C2LoadMapWidget } from './widgets/C2LoadMapWidget'
import { C2RobotStatusWidget } from './widgets/C2RobotStatusWidget'
import { C2PointsWidget } from './widgets/C2PointsWidget'
import { fitView, normaliseMapEntry, quaternionToYaw, worldToPixel } from './../lib/c2Coords'
import {
  POSE_ID, POSE_TYPE, defaultName, displayName, effectiveYaw, makePin, reindexOrder,
} from './../lib/c2Pins'
import {
  buildClearanceGrid, clearanceAt, linkKey, linksFromKeys, planRoute,
} from './../lib/c2Graph'
import { distToSegment, drawGraphLayer } from './../lib/c2GraphDraw'
import { loadUploadedMap } from './../lib/c2MapFile'
import { subscribeNavPlan } from './../lib/c2NavPath'
import { useC2GraphStore } from '../hooks/useC2GraphStore'
import { cancelNavGoal, setQuadrupedPaused, subscribe } from '../services/rosbridge'
// Robot commands and the scan overlay come from Pius's navplan
// tester as-is. It was built to be reused by this page; none of those files are changed here.
import {
  nextNavplanId, relocalize, sendNavigationPlan, subscribeLaserScan,
} from '../navplan_tester/lib/navplanRos'
import { MapOverlay } from '../navplan_tester/MapOverlay'

const MIN_SPAN = 0.12
const ZOOM_STEP = 1.4
const STATUS_TOPIC = '/quadruped_main_status'
const STATUS_TYPE = 'tmms_msgs/QuadrupedMainStatus'
// A scan older than this is treated as lost and no longer drawn.
const SCAN_TIMEOUT_MS = 2000
const PLAN_LOG_LENGTH = 20
// A click within this many screen pixels of a link selects it.
const LINK_HIT_PX = 7
const NO_LINKS = []
const isMapPoint = (id) => typeof id === 'string' && id.startsWith('poi_')
// The graph last opened on each map, so it opens again by itself next time.
const LAST_GRAPH_KEY = 'tmms.c2.lastGraph'
// Map view toggles (show Pius's points, show names) are remembered per browser.
const VIEW_PREFS_KEY = 'tmms.c2.mapView'
function loadViewPrefs() {
  try { return { mapPoints: true, names: true, ...JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) ?? '{}') } }
  catch { return { mapPoints: true, names: true } }
}
// Every point can be linked: Points of Interest, Simple waypoints and Home.
const canLink = (p) => Boolean(p)
// How close the robot must come to a stop for it to count as reached. Matches nav2's
// RemovePassedGoals radius, which drops a stop once the robot is this close.
const STOP_REACHED_M = 0.7
const FINAL_PLAN_STATES = new Set(['completed', 'cancelled', 'errored', 'rejected'])

export function C2Page() {

  const [storeMaps, setStoreMaps] = useState(null)
  const [uploaded, setUploaded] = useState([])
  const [mapName, setMapName] = useState(null)
  const [mapError, setMapError] = useState(null)
  const [images, setImages] = useState(() => new Map())

  const refreshMaps = useCallback(() => {
    setMapError(null)
    fetch('/api/maps2d')
      .then((r) => r.json())
      .then((list) => setStoreMaps(
        list.map(normaliseMapEntry).filter(Boolean).map((m) => ({ ...m, source: 'store' }))))
      .catch((err) => {
        console.warn('[C2] /api/maps2d unavailable:', err.message)
        setStoreMaps([])
      })
  }, [])

  useEffect(refreshMaps, [refreshMaps])

  const maps = useMemo(
    () => [...uploaded, ...(storeMaps ?? [])],
    [uploaded, storeMaps],
  )
  const selectedMap = maps.find((m) => m.name === mapName) ?? null
  const image = selectedMap ? images.get(selectedMap.name) ?? null : null

  useEffect(() => {
    if (!selectedMap || selectedMap.source !== 'store' || images.has(selectedMap.name)) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setImages((prev) => new Map(prev).set(selectedMap.name, img))
    }
    img.onerror = () => {
      if (!cancelled) setMapError(`Could not load ${selectedMap.name}.png from the map store.`)
    }
    img.src = `/api/maps2d/${encodeURIComponent(selectedMap.name)}/image`
    return () => { cancelled = true }
  }, [selectedMap, images])

  const fileRef = useRef(null)
  const requestUpload = useCallback(() => fileRef.current?.click(), [])

  const handleUpload = useCallback(async (files) => {
    if (files.length === 0) return
    setMapError(null)
    try {
      const loaded = await loadUploadedMap(files)
      setImages((prev) => new Map(prev).set(loaded.name, loaded.image))
      setUploaded((prev) => [
        { name: loaded.name, source: 'upload', pngBytes: loaded.bytes, ...loaded.info },
        ...prev.filter((m) => m.name !== loaded.name),
      ])
      setMapName(loaded.name)
    } catch (err) {
      setMapError(err.message)
    }
  }, [])

  const { active: statusLive, lastMsg: status } = useTopicActivity(STATUS_TOPIC, STATUS_TYPE, 1500)

  const robot = useMemo(() => {
    if (!status) return null
    const p = status.pose?.position
    return {
      position: p ? { x: p.x, y: p.y } : null,
      yaw: quaternionToYaw(status.pose?.orientation),
      battery: status.battery_percentage,
      mode: status.robot_mode,
      navState: status.navigation_state,
      localization: status.localization_status,
      paused: status.is_paused,
      currentMap: status.current_map,
      navplanId: status.current_navplan_id,
      navplanStatus: status.current_navplan_status,
    }
  }, [status])

  const robotMap = statusLive ? robot?.currentMap || null : null
  const robotOnThisMap = Boolean(robotMap && mapName && robotMap === mapName)

  // After a refresh nothing is selected, but the robot still has a map loaded. Show that one —
  // once, and only if the operator hasn't picked a map, so this never overrides a choice.
  const restoredMap = useRef(false)
  useEffect(() => {
    if (restoredMap.current || mapName || !storeMaps || !robotMap) return
    restoredMap.current = true
    if (storeMaps.some((m) => m.name === robotMap)) setMapName(robotMap)
  }, [storeMaps, robotMap, mapName])

  const { graphs, updateGraphs, status: storeStatus } = useC2GraphStore()
  const [graph, setGraph] = useState(null)
  // The map a graph was last opened for by itself (see "open the last graph on start").
  const autoOpenedFor = useRef(null)
  const [editing, setEditing] = useState(false)
  const [graphPanel, setGraphPanel] = useState(null)

  const [pins, setPins] = useState([])
  // The operator's links ("idA|idB" keys). Saved with the graph, alongside the pins. Routes only
  // ever use these: two points are connected only if the operator linked them.
  const [linkKeys, setLinkKeys] = useState(NO_LINKS)
  const [selectedLink, setSelectedLink] = useState(null)
  // Link tool: on while the operator is linking points; linkStart is the first point clicked.
  const [linkMode, setLinkMode] = useState(false)
  const [linkStart, setLinkStart] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [placingType, setPlacingType] = useState(null)
  const [renaming, setRenaming] = useState(null)

  const pinsRef = useRef(pins)
  const historyRef = useRef({ past: [], future: [], key: null, at: 0 })
  const [history, setHistory] = useState({ past: 0, future: 0 })

  const HISTORY_LIMIT = 200
  const COALESCE_MS = 700

  const applyPins = useCallback((next, { selection } = {}) => {
    pinsRef.current = next
    setPins(next)
    if (selection !== undefined) setSelectedId(selection)
  }, [])

  const mutate = useCallback((key, updater) => {
    const prev = pinsRef.current
    const next = updater(prev)
    if (next === prev) return

    const h = historyRef.current
    const now = performance.now()
    const sameRun = key !== null && h.key === key && now - h.at < COALESCE_MS
    if (!sameRun) {
      h.past.push(prev)
      if (h.past.length > HISTORY_LIMIT) h.past.shift()
      h.future = []
      setHistory({ past: h.past.length, future: 0 })
    }
    h.key = key
    h.at = now
    applyPins(next)
  }, [applyPins])

  const resetHistory = useCallback((next) => {
    historyRef.current = { past: [], future: [], key: null, at: 0 }
    setHistory({ past: 0, future: 0 })
    pinsRef.current = next
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (h.past.length === 0) return
    h.future.push(pinsRef.current)
    const restored = h.past.pop()
    h.key = null
    setHistory({ past: h.past.length, future: h.future.length })
    const stillThere = restored.some((pin) => pin.id === selectedId)
    applyPins(restored, { selection: stillThere ? selectedId : null })
  }, [applyPins, selectedId])

  const redo = useCallback(() => {
    const h = historyRef.current
    if (h.future.length === 0) return
    h.past.push(pinsRef.current)
    const restored = h.future.pop()
    h.key = null
    setHistory({ past: h.past.length, future: h.future.length })
    const stillThere = restored.some((pin) => pin.id === selectedId)
    applyPins(restored, { selection: stillThere ? selectedId : null })
  }, [applyPins, selectedId])

  // Copies the open graph's pins back into the saved list. Skipped when nothing changed (e.g.
  // just after loading), so opening a graph never counts as an edit or triggers a save.
  useEffect(() => {
    if (!graph) return
    updateGraphs((prev) => {
      const current = prev.find((g) => g.id === graph.id)
      if (!current) return prev
      if (current.pins === pins && (current.links ?? NO_LINKS) === linkKeys) return prev
      return prev.map((g) => (
        g.id === graph.id
          ? { ...g, pins, links: linkKeys, updatedAt: new Date().toISOString() }
          : g
      ))
    })
  }, [pins, linkKeys, graph, updateGraphs])

  const closeGraph = useCallback(() => {
    setRenaming(null)
    setGraph(null)
    setEditing(false)
    setPins([])
    setLinkKeys(NO_LINKS)
    setSelectedLink(null)
    setLinkMode(false)
    setLinkStart(null)
    resetHistory([])
    setSelectedId(null)
    setPlacingType(null)
  }, [resetHistory])

  // -- relocalize ------------------------------------------------------------
  // 'idle' -> 'placing' -> 'placed' -> 'sending' -> back to 'idle' on success, or 'placed' on
  // failure so the marker can be nudged and resent. The marker is not a graph pin: it is never
  // saved and never part of a route.
  const [reloc, setReloc] = useState('idle')
  const [posePin, setPosePin] = useState(null)

  const cancelReloc = useCallback(() => {
    setReloc('idle')
    setPosePin(null)
    setSelectedId((cur) => (cur === POSE_ID ? null : cur))
  }, [])

  const selectMap = useCallback((name) => {
    autoOpenedFor.current = null
    setMapName(name)
    setMapError(null)
    closeGraph()
    // The marker is a position on the old map.
    cancelReloc()
  }, [closeGraph, cancelReloc])

  const createGraph = useCallback((name) => {
    const entry = {
      id: `g_${Date.now().toString(36)}`,
      name,
      map: mapName,
      pins: [],
      links: NO_LINKS,
      updatedAt: new Date().toISOString(),
    }
    updateGraphs((prev) => [...prev, entry])
    setGraph({ id: entry.id, name: entry.name })
    setPins([])
    setLinkKeys(NO_LINKS)
    setSelectedLink(null)
    setLinkMode(false)
    setLinkStart(null)
    resetHistory([])
    setSelectedId(null)
    setEditing(true)
    setGraphPanel(null)
  }, [mapName, resetHistory, updateGraphs])

  const loadGraph = useCallback((id) => {
    const found = graphs.find((g) => g.id === id)
    if (!found) return
    setGraph({ id: found.id, name: found.name })
    setPins(found.pins)
    setLinkKeys(found.links ?? NO_LINKS)
    setSelectedLink(null)
    setLinkMode(false)
    setLinkStart(null)
    resetHistory(found.pins)
    setSelectedId(null)
    setEditing(false)
    setGraphPanel(null)
  }, [graphs, resetHistory])

  // -- open the last graph on start ---------------------------------------------
  // When a map is shown with no graph open, a graph opens by itself (view only): the one last
  // opened on that map in this browser, else the one on that map changed most recently. Picking
  // a map does it again; closing a graph with ✕ doesn't reopen it.
  useEffect(() => {
    if (!graph || !mapName) return
    try {
      const last = JSON.parse(localStorage.getItem(LAST_GRAPH_KEY) ?? '{}')
      localStorage.setItem(LAST_GRAPH_KEY, JSON.stringify({ ...last, [mapName]: graph.id }))
    } catch { /* not remembered */ }
  }, [graph, mapName])
  useEffect(() => {
    if (!mapName || graph || storeStatus === 'loading' || storeStatus === 'offline' || autoOpenedFor.current === mapName) return
    autoOpenedFor.current = mapName
    const onMap = graphs.filter((g) => g.map === mapName)
    let lastId = null
    try { lastId = JSON.parse(localStorage.getItem(LAST_GRAPH_KEY) ?? '{}')[mapName] ?? null } catch { /* none */ }
    const newest = onMap.reduce((a, g) => (!a || (g.updatedAt ?? '') > (a.updatedAt ?? '') ? g : a), null)
    const pick = onMap.find((g) => g.id === lastId) ?? newest
    if (pick) loadGraph(pick.id)
  }, [mapName, graph, graphs, storeStatus, loadGraph])

  const addPin = useCallback((type, world) => {
    let placedId = null
    mutate(null, (prev) => {
      if (type === 'home') {
        const existing = prev.find((p) => p.type === 'home')
        if (existing) {
          placedId = existing.id
          return prev.map((p) => (p.id === existing.id ? { ...p, x: world.x, y: world.y } : p))
        }
      }
      const pin = makePin(type, world, prev)
      placedId = pin.id
      return [...prev, pin]
    })
    if (placedId) setSelectedId(placedId)

    if (type === 'home') setPlacingType(null)
  }, [mutate])

  const movePin = useCallback((id, world) => {
    mutate(`move:${id}`, (prev) => prev.map((p) => (
      p.id === id ? { ...p, x: world.x, y: world.y } : p
    )))
  }, [mutate])

  const updatePin = useCallback((id, patch) => {
    mutate(`edit:${id}:${Object.keys(patch).join(',')}`, (prev) => prev.map((p) => (
      p.id === id ? { ...p, ...patch } : p
    )))
  }, [mutate])

  const setYaw = useCallback((id, yaw) => {
    mutate(`yaw:${id}`, (prev) => prev.map((p) => (
      p.id === id ? { ...p, yaw: yaw ?? 0, headingSet: yaw != null } : p
    )))
  }, [mutate])

  const removePin = useCallback((id) => {
    mutate(null, (prev) => (prev.some((p) => p.id === id)
      ? reindexOrder(prev.filter((p) => p.id !== id))
      : prev))
    setSelectedId((cur) => (cur === id ? null : cur))
    setRenaming((cur) => (cur?.id === id ? null : cur))
  }, [mutate])

  const beginRename = useCallback((id) => {
    if (isMapPoint(id)) return
    const pin = pinsRef.current.find((p) => p.id === id)
    if (!pin) return
    setPlacingType(null)
    setSelectedId(id)
    setRenaming({ id, draft: pin.label })
  }, [])

  const commitRename = useCallback(() => {
    setRenaming((cur) => {
      if (cur) updatePin(cur.id, { label: cur.draft.trim() })
      return null
    })
  }, [updatePin])

  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [hover, setHover] = useState(null)
  const [viewMode, setViewMode] = useState('2D')
  // Both: the ref is what the fit effect reads without re-running, the state gives the overlay
  // canvas its real width/height.
  const sizeRef = useRef({ width: 0, height: 0 })
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const fittedFor = useRef(null)

  const onSizeChange = useCallback((size) => {
    sizeRef.current = size
    setCanvasSize(size)
  }, [])

  const info = useMemo(() => (selectedMap
    ? {
      width: selectedMap.width,
      height: selectedMap.height,
      resolution: selectedMap.resolution,
      origin: selectedMap.origin,
    }
    : null), [selectedMap])

  useEffect(() => {
    if (!info || !image) return
    const key = `${mapName}:${info.width}x${info.height}`
    if (fittedFor.current === key || !sizeRef.current.width) return
    fittedFor.current = key
    setView(fitView(info, sizeRef.current))
  }, [info, mapName, image])

  const zoomBy = useCallback((factor) => {
    const { width, height } = sizeRef.current
    setView((v) => {
      const next = Math.min(40, Math.max(0.05, v.scale * factor))
      if (next === v.scale) return v
      return {
        scale: next,
        x: width / 2 - ((width / 2 - v.x) / v.scale) * next,
        y: height / 2 - ((height / 2 - v.y) / v.scale) * next,
      }
    })
  }, [])

  const fit = useCallback(() => {
    if (info) setView(fitView(info, sizeRef.current))
  }, [info])

  const canEdit = Boolean(graph) && editing

  // -- points that came with the map -----------------------------------------
  // Pius's points of interest, captured while mapping and copied into the 2D map's yaml.
  // /api/maps2d returns them as `pois`, yaw in DEGREES in the map frame. Mapping only ever adds
  // points, it never edits them, so C2 copies each one into the open graph the first time it sees
  // it (saved to the database with the graph's pins). From then on the graph's copy is the one
  // used: it can be moved and turned in C2, but not renamed or deleted.
  const fileMapPoints = useMemo(() => (selectedMap?.pois ?? [])
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      id: `poi_${p.id}`,
      type: 'action',
      source: 'mapping',
      x: p.x,
      y: p.y,
      yaw: ((Number(p.yaw) || 0) * Math.PI) / 180,
      headingSet: Number.isFinite(p.yaw),
      label: p.name || `POI_${p.id}`,
      poi: { description: p.description ?? '', snapshots: p.snapshots ?? [], timestamp: p.timestamp ?? '' },
    })), [selectedMap])

  // Copies in the map's points this graph doesn't have yet. Undo/redo states get them too, so
  // undoing never takes them back out.
  useEffect(() => {
    if (!graph || fileMapPoints.length === 0) return
    const withMapPoints = (list) => {
      const have = new Set(list.map((p) => p.id))
      const missing = fileMapPoints.filter((p) => !have.has(p.id))
      return missing.length ? [...missing, ...list] : list
    }
    const next = withMapPoints(pinsRef.current)
    if (next === pinsRef.current) return
    const h = historyRef.current
    h.past = h.past.map(withMapPoints)
    h.future = h.future.map(withMapPoints)
    applyPins(next)
  }, [graph, fileMapPoints, applyPins])

  const mapPoints = useMemo(
    () => (graph ? pins.filter((p) => p.source === 'mapping') : fileMapPoints), [graph, pins, fileMapPoints])
  const ownPins = useMemo(() => pins.filter((p) => p.source !== 'mapping'), [pins])
  const allPoints = useMemo(() => [...mapPoints, ...ownPins], [mapPoints, ownPins])

  // -- canvas: every point plus the relocalize marker --------------------------
  const [viewPrefs, setViewPrefs] = useState(loadViewPrefs)
  const toggleViewPref = useCallback((key) => setViewPrefs((prev) => {
    const next = { ...prev, [key]: !prev[key] }
    try { localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(next)) } catch { /* not remembered */ }
    return next
  }), [])

  // -- the point network -------------------------------------------------------
  // Built from the map picture once per map; every "is this line clear?" after that is a lookup.
  const grid = useMemo(() => (image && info ? buildClearanceGrid(image, info) : null), [image, info])
  const graphPoints = useMemo(
    () => allPoints.map((p) => ({ ...p, name: displayName(p, pins) })), [allPoints, pins])
  const links = useMemo(
    () => linksFromKeys(graphPoints, linkKeys, grid, info), [graphPoints, linkKeys, grid, info])

  const removeLink = useCallback((key) => {
    setLinkKeys((prev) => prev.filter((k) => k !== key))
    setSelectedLink(null)
  }, [])

  // Clicking a point: normally selects it. With the Link tool on, the first click picks the start
  // and each next click links it to the previous one, so A, B, C links A-B and B-C. Clicking a
  // pair that is already linked removes that link.
  // Clicking one of Pius's points opens its photos. Only when not editing: while editing, a click
  // is for moving and linking. It stays selected after the viewer closes, ready for Go.
  const [viewerId, setViewerId] = useState(null)
  const selectPoint = useCallback((id) => {
    setSelectedLink(null)
    if (!linkMode) {
      setSelectedId(id)
      if (!canEdit && isMapPoint(id)) setViewerId(id)
      return
    }
    if (!id) { setLinkStart(null); return }
    const point = graphPoints.find((p) => p.id === id)
    if (!canLink(point)) return
    if (!linkStart || linkStart === id) { setLinkStart(id); setSelectedId(id); return }
    const key = linkKey(linkStart, id)
    setLinkKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    setLinkStart(id)
    setSelectedId(id)
  }, [linkMode, linkStart, graphPoints, canEdit])

  const toggleLinkMode = useCallback(() => {
    setLinkMode((on) => !on)
    setLinkStart(null)
    setPlacingType(null)
  }, [])

  // Arming a pin type ends linking, and the other way round: one tool at a time.
  const armPinType = useCallback((type) => {
    setPlacingType(type)
    if (type) { setLinkMode(false); setLinkStart(null) }
  }, [])

  // A click on empty map: pick the nearest link within reach, if any. While linking, an empty
  // click just drops the half-made link.
  const toScreenPt = useCallback((p) => {
    const g = worldToPixel(p.x, p.y, info)
    return { x: view.x + g.x * view.scale, y: view.y + g.y * view.scale }
  }, [info, view])

  const handleEmptyClick = useCallback((pt) => {
    if (!info) return false
    if (linkMode) { setLinkStart(null); return true }
    const byId = new Map(graphPoints.map((p) => [p.id, p]))
    let best = null
    let bestD = LINK_HIT_PX
    for (const l of links) {
      const a = byId.get(l.a)
      const b = byId.get(l.b)
      if (!a || !b) continue
      const d = distToSegment(pt, toScreenPt(a), toScreenPt(b))
      if (d < bestD) { best = l; bestD = d }
    }
    if (!best) { setSelectedLink(null); return false }
    setSelectedLink(best.key)
    setSelectedId(null)
    return true
  }, [info, graphPoints, links, toScreenPt, linkMode])

  const selectedLinkInfo = selectedLink ? links.find((l) => l.key === selectedLink) ?? null : null

  const startReloc = useCallback(() => {
    setPlacingType(null)
    setPosePin(null)
    setReloc('placing')
  }, [])

  const handlePlace = useCallback((type, world) => {
    if (type === POSE_TYPE) {
      setPosePin({ id: POSE_ID, type: POSE_TYPE, x: world.x, y: world.y, yaw: 0, headingSet: false, label: '' })
      // Selected so the rotate ring shows straight away — setting the heading is the next step.
      setSelectedId(POSE_ID)
      setReloc('placed')
      return
    }
    addPin(type, world)
  }, [addPin])

  // The marker stays movable while the graph is locked; graph pins only move while editing.
  const handleMovePin = useCallback((id, world) => {
    if (id === POSE_ID) setPosePin((p) => (p ? { ...p, x: world.x, y: world.y } : p))
    else if (canEdit) movePin(id, world)
  }, [canEdit, movePin])

  const handleSetYaw = useCallback((id, yaw) => {
    if (id === POSE_ID) setPosePin((p) => (p ? { ...p, yaw: yaw ?? 0, headingSet: yaw != null } : p))
    else if (canEdit) setYaw(id, yaw)
  }, [canEdit, setYaw])

  // -- robot commands ----------------------------------------------------------
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  // The route is only shown once the operator presses Go: then it is drawn on the map and
  // confirmed (or cancelled) in the Robot panel. Placing or picking points never draws it.
  // null, 'to' (nav2 plans its own way to the destination) or 'through' (follow the links).
  const [routeMode, setRouteMode] = useState(null)
  const finish = useCallback((ok, message) => { setBusy(false); setResult({ ok, message }) }, [])

  // Why the robot can't be driven from this map at all. Uploaded maps live only in this
  // browser, so the robot has no file to load them from.
  const driveBlocker = !selectedMap ? 'Load a map to drive the robot.'
    : selectedMap.source === 'upload'
      ? `${selectedMap.name} was uploaded to this browser only — the robot doesn't have it. Pick a map from the store.`
      : null

  // -- going to a point ----------------------------------------------------------
  // The selected point is the destination. The way there: the robot walks by itself to the point
  // nearest it, then follows links to the destination, shortest total distance.
  // Rounded to 5 cm so the 5 Hz status doesn't replan on every tiny wobble of the estimate.
  const rx = robotOnThisMap && robot?.position ? Math.round(robot.position.x * 20) / 20 : null
  const ry = robotOnThisMap && robot?.position ? Math.round(robot.position.y * 20) / 20 : null
  const robotPos = useMemo(() => (rx == null ? null : { x: rx, y: ry }), [rx, ry])
  const target = selectedId && selectedId !== POSE_ID
    ? graphPoints.find((p) => p.id === selectedId) ?? null
    : null

  // Checks shared by both ways of going: is this somewhere the robot can be sent at all?
  const destReason = useMemo(() => {
    if (!target) return 'Select a Point of Interest or Home on the map to go there.'
    if (!grid) return 'The map is still loading.'
    if (target.type === 'simple') {
      return `${target.name} is a Simple waypoint: the robot only passes through those. Pick a Point of Interest or Home to go to.`
    }
    if (clearanceAt(target, grid, info) === 0) {
      return `${target.name} is on a wall or in unmapped (grey) space. Move it onto white floor.`
    }
    if (!robotPos) return 'The robot is not on this map. Relocalize it here first.'
    // nav2 would report this as reached instantly.
    if (Math.hypot(robotPos.x - target.x, robotPos.y - target.y) < 0.5) return `The robot is already at ${target.name}.`
    return null
  }, [target, grid, info, robotPos])

  // Go through: follow the operator's links. Any linked point can be passed through on the way —
  // a Point of Interest or Home does everything a Simple waypoint does, and can also be a
  // destination. The robot starts at whichever point it can reach first.
  const plan = useMemo(() => {
    if (destReason) return null
    return planRoute({ points: graphPoints, links, robot: robotPos, targetId: target.id, grid, info })
  }, [destReason, target, grid, info, graphPoints, links, robotPos])

  // Go to: only the destination is sent and nav2 plans the whole way itself. Nothing is drawn
  // before Send — C2 does not guess nav2's path. Once sent, nav2's real path (/plan) is drawn.
  const directPlan = useMemo(() => {
    if (destReason) return null
    return {
      ok: true,
      stops: [target],
      robotLeg: null,
      legs: [],
      lengthM: Math.hypot(target.x - robotPos.x, target.y - robotPos.y),
    }
  }, [destReason, target, robotPos])

  const toBlocker = driveBlocker ? null : destReason
  const goBlocker = driveBlocker ? null : destReason ?? (plan && !plan.ok ? plan.reason : null)
  const activePlan = routeMode === 'to' ? directPlan : routeMode === 'through' && plan?.ok ? plan : null

  // Stated rather than silently dropped: the robot's route message carries positions and
  // headings only, so these pin settings don't reach it yet.
  const routeNote = activePlan?.stops.some((p) => p.action?.dwellSeconds > 0)
    ? 'Dwell times are not sent yet — the robot drives through without stopping.'
    : null

  // Any change of destination, or going back to placing points, drops the preview — except when
  // Return home just picked Home, which opens the preview for it straight away.
  const autoPreviewRef = useRef(false)
  const openPreviewFor = useCallback(() => {
    if (plan?.ok && !goBlocker) setRouteMode('through')
    else if (!toBlocker && directPlan) setRouteMode('to')
    else setRouteMode(null)
  }, [plan, goBlocker, toBlocker, directPlan])
  useEffect(() => {
    if (autoPreviewRef.current) { autoPreviewRef.current = false; openPreviewFor() } else setRouteMode(null)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Return home: select Home and show the way there. Follows the links when they reach Home,
  // otherwise lets nav2 plan its own way.
  const homePin = pins.find((p) => p.type === 'home') ?? null
  function handleReturnHome() {
    if (!homePin) return
    setPlacingType(null)
    setLinkMode(false)
    if (selectedId === homePin.id) openPreviewFor()
    else { autoPreviewRef.current = true; setSelectedId(homePin.id) }
  }

  // -- the route the robot is walking ------------------------------------------
  // Kept on the map after Send until the robot reports the route finished, so the operator can
  // watch the robot follow it. `reached` counts stops already passed; their legs turn grey.
  const [walking, setWalking] = useState(null)

  // nav2's real path for a Go-to route, straight from the robot. nav2 only plans once it has the
  // goal, so this fills in after Send and updates whenever nav2 re-plans.
  const [navPath, setNavPath] = useState(null)
  const walkingTo = walking?.mode === 'to'
  useEffect(() => {
    setNavPath(null)
    if (!walkingTo) return undefined
    return subscribeNavPlan((p) => { if (!p.frame || p.frame === 'map') setNavPath(p.points) })
  }, [walkingTo, walking?.id])

  useEffect(() => {
    const pos = robot?.position
    if (!walking || !pos) return
    let reached = walking.reached
    // The robot can pass a stop between two status updates, so check from the far end back.
    for (let k = walking.stops.length - 1; k >= reached; k--) {
      if (Math.hypot(walking.stops[k].x - pos.x, walking.stops[k].y - pos.y) < STOP_REACHED_M) { reached = k + 1; break }
    }
    if (reached !== walking.reached) setWalking((w) => (w ? { ...w, reached } : w))
  }, [robot?.position?.x, robot?.position?.y, walking]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (placingType || reloc !== 'idle') setRouteMode(null) }, [placingType, reloc])

  // "Hide Pius's points" only hides them from the map: they still count for routes. A hidden
  // point still shows while it is selected or a stop on the route being previewed or walked.
  const hiddenIds = useMemo(() => {
    if (viewPrefs.mapPoints) return null
    const keep = new Set([selectedId, ...(activePlan?.stops ?? []).map((p) => p.id),
      ...(walking?.stops ?? []).map((p) => p.id)])
    return new Set(mapPoints.filter((p) => !keep.has(p.id)).map((p) => p.id))
  }, [viewPrefs.mapPoints, selectedId, activePlan, walking, mapPoints])
  const shownPoints = useMemo(
    () => (hiddenIds ? allPoints.filter((p) => !hiddenIds.has(p.id)) : allPoints), [allPoints, hiddenIds])
  const shownLinks = useMemo(
    () => (hiddenIds ? links.filter((l) => !hiddenIds.has(l.a) && !hiddenIds.has(l.b)) : links), [links, hiddenIds])
  const canvasPins = useMemo(() => (posePin ? [...shownPoints, posePin] : shownPoints), [shownPoints, posePin])
  const viewerPoint = mapPoints.find((p) => p.id === viewerId) ?? null
  // The map point under the pointer, for its hover card. Same reach as clicking it.
  const hoveredMapPoint = useMemo(() => {
    if (!hover || !info || viewerId) return null
    const h = toScreenPt(hover)
    return shownPoints.find((p) => p.source === 'mapping' && Math.hypot(toScreenPt(p).x - h.x, toScreenPt(p).y - h.y) <= 16) ?? null
  }, [hover, info, viewerId, shownPoints, toScreenPt])

  const drawUnder = useCallback((ctx, toScreen) => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-bright').trim() || '#7C3AED'
    const from = linkMode && linkStart ? graphPoints.find((p) => p.id === linkStart) : null
    drawGraphLayer(ctx, toScreen, {
      points: graphPoints,
      links: shownLinks,
      selectedKey: selectedLink,
      pending: from && hover ? { from, to: hover } : null,
      plan: activePlan ?? (walking
        ? walking.mode === 'to'
          ? { robotLeg: null, legs: navPath?.length > 1 ? [navPath] : [] }
          : {
            robotLeg: walking.reached > 0 ? null : walking.robotLeg,
            legs: walking.legs,
            doneLegs: Math.max(0, walking.reached - 1),
          }
        : null),
      accent,
    })
  }, [graphPoints, shownLinks, selectedLink, linkMode, linkStart, hover, activePlan, walking, navPath])

  // Linking only makes sense while the graph is being edited.
  useEffect(() => { if (!canEdit) { setLinkMode(false); setLinkStart(null) } }, [canEdit])

  function handleSendReloc() {
    if (!posePin || !mapName) return
    setReloc('sending'); setBusy(true); setResult(null)
    relocalize({ mapName, x: posePin.x, y: posePin.y, yaw: posePin.yaw ?? 0 },
      (r) => {
        finish(r.success, r.message)
        if (r.success) cancelReloc()
        else setReloc('placed')
      },
      (e) => { finish(false, String(e)); setReloc('placed') })
  }

  function handleGo(mode) {
    if (driveBlocker) return
    if (mode === 'to' && (toBlocker || !directPlan)) return
    if (mode === 'through' && (goBlocker || !plan?.ok)) return
    setPlacingType(null)
    setRouteMode(mode)
  }

  function handleSendRoute() {
    if (driveBlocker || !activePlan) return
    const navplan = {
      navplanId: nextNavplanId(),
      // The map the pins were drawn on, not the robot's. The robot refuses the route when it is
      // on another map — tagging it with the robot's map instead would pass that check and
      // drive to coordinates from the wrong map.
      mapName,
      // Only the last heading is enforced by the robot; the stops before it are passed through.
      waypoints: activePlan.stops.map((p) => ({ x: p.x, y: p.y, yaw: effectiveYaw(p) })),
    }
    const sent = { id: navplan.navplanId, name: target?.name, mode: routeMode, stops: activePlan.stops,
      robotLeg: activePlan.robotLeg, legs: activePlan.legs, reached: 0 }
    setRouteMode(null)
    setBusy(true); setResult(null)
    sendNavigationPlan(navplan,
      (r) => { finish(r.success, r.message); if (r.success) setWalking(sent) },
      (e) => finish(false, String(e)))
  }

  // Pause and Cancel are the stop controls, so they never wait on `busy`: a route send can sit
  // for up to 20 s and a relocalize for up to 60 s, and the operator must be able to stop the
  // robot during either.
  function handlePause() {
    const unpausing = Boolean(robot?.paused)
    // Unpausing hands the robot to navigation and makes it stand up, so it is confirmed.
    if (unpausing && !window.confirm('Unpause?\n\nThe robot will stand up (balance stand) and navigation takes control. Manual teleop stops.')) return
    setResult(null)
    setQuadrupedPaused(!unpausing,
      (r) => setResult({ ok: r.success, message: r.message || (unpausing ? 'Unpaused.' : 'Paused.') }),
      (e) => setResult({ ok: false, message: String(e) }))
  }

  function handleCancelGoal() {
    setResult(null)
    cancelNavGoal(
      () => { setResult({ ok: true, message: 'Cancel requested.' }); setWalking(null) },
      (e) => setResult({ ok: false, message: String(e) }))
  }

  // -- route log ---------------------------------------------------------------
  // /curr_navplan fires on every status change of a route, so this catches transitions the
  // 5 Hz status topic can skip.
  const [planLog, setPlanLog] = useState([])
  useEffect(() => subscribe('/curr_navplan', 'tmms_msgs/NavigationPlan', (m) => {
    setPlanLog((prev) => [
      ...prev.slice(-(PLAN_LOG_LENGTH - 1)),
      { id: m.navplan_id, status: m.status, at: new Date().toLocaleTimeString() },
    ])
  }), [])

  // The route stops being shown once the robot reports it finished, from either source.
  useEffect(() => {
    if (!walking) return
    const last = planLog.findLast?.((e) => e.id === walking.id)
    const status = robot?.navplanId === walking.id ? robot.navplanStatus : null
    if ((last && FINAL_PLAN_STATES.has(last.status)) || FINAL_PLAN_STATES.has(status)) setWalking(null)
  }, [planLog, robot?.navplanId, robot?.navplanStatus, walking]) // eslint-disable-line react-hooks/exhaustive-deps

  // -- lidar overlay -----------------------------------------------------------
  // What the robot's laser sees, drawn on the map. If relocalizing worked, the red dots sit
  // on the walls.
  const [scan, setScan] = useState(null)
  const [scanLive, setScanLive] = useState(false)
  const lastScanAt = useRef(0)
  useEffect(() => {
    const unsub = subscribeLaserScan((m) => {
      lastScanAt.current = Date.now()
      setScan(m)
    })
    const interval = setInterval(() => {
      const live = Date.now() - lastScanAt.current < SCAN_TIMEOUT_MS
      setScanLive((prev) => (prev !== live ? live : prev))
    }, 200)
    return () => { unsub(); clearInterval(interval) }
  }, [])

  const scanHint = !info ? 'load a map'
    : !scanLive ? 'no /rslidar_scan'
      : !robotMap ? 'robot has no map loaded'
        : !robotOnThisMap ? `robot is on ${robotMap}`
          : !robot?.position ? 'no robot position'
            : null

  const renamingPin = renaming ? pins.find((p) => p.id === renaming.id) : null
  const renamePos = renamingPin && info
    ? (() => {
      const g = worldToPixel(renamingPin.x, renamingPin.y, info)
      return { x: view.x + g.x * view.scale, y: view.y + g.y * view.scale - 22 }
    })()
    : null
  const renamePlaceholder = renamingPin ? defaultName(renamingPin, pins) : ''

  const isTyping = (target) => {
    if (!target) return false
    if (target.isContentEditable) return true
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  }

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e.target)) return

      if (e.key === 'Escape') {
        // Not while sending: the marker has to stay so a failed reply can be retried.
        if (reloc === 'placing' || reloc === 'placed') cancelReloc()
        setPlacingType(null)
        setLinkMode(false)
        setLinkStart(null)
        setSelectedId(null)
        setSelectedLink(null)
        setRenaming(null)
        setRouteMode(null)
        return
      }

      // Points that came with the map can't be deleted from C2.
      if ((e.key === 'Delete' || e.key === 'Backspace') && isMapPoint(selectedId)) return

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId === POSE_ID) {
        e.preventDefault()
        if (reloc !== 'sending') cancelReloc()
        return
      }

      if (!canEdit) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      } else if (mod && key === 'z') {
        e.preventDefault()
        undo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        removePin(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, undo, redo, removePin, selectedId, reloc, cancelReloc])

  const rightColRef = useRef(null)
  const [mapEnd, setMapEnd] = useState(0.21)
  const [pointsEnd, setPointsEnd] = useState(0.5)

  const graphsForMap = graphs.filter((g) => g.map === mapName)

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      <C2PoiViewer point={viewerPoint} mapName={mapName} onClose={() => setViewerId(null)} />

      <input
        ref={fileRef}
        type="file"
        accept=".png,.yaml,.yml"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleUpload(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />

      <div
        className="panel flex flex-col"
        style={{ width: '65%', flexShrink: 0, minWidth: 0, overflow: 'hidden', borderRight: '1px solid var(--border)' }}
      >
        <div className="panel-header">
          <span>C2 — SCENE MARKUP</span>
          <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            {mapName ?? 'no map'}
            {graph ? ` · ${graph.name}${editing ? ' · editing' : ''}` : ''}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          <C2MapCanvas
            info={info}
            image={image}
            pins={canvasPins}
            selectedId={selectedId}
            placingType={reloc === 'placing' ? POSE_TYPE : canEdit ? placingType : null}
            editable={canEdit || reloc === 'placed'}
            view={view}
            robot={robotOnThisMap ? robot : null}
            onViewChange={setView}
            onPlace={handlePlace}
            onSelect={selectPoint}
            onMovePin={handleMovePin}
            onSetYaw={handleSetYaw}
            onRename={canEdit ? beginRename : undefined}
            onHover={setHover}
            onSizeChange={onSizeChange}
            drawUnder={drawUnder}
            onEmptyClick={handleEmptyClick}
            showNames={viewPrefs.names}
          />

          <MapOverlay
            info={info}
            view={view}
            size={canvasSize}
            robot={robotOnThisMap ? robot : null}
            // No route lines while marking: placing a pin is not choosing a route. The route
            // is only decided at send time (Route Order today; a path search later).
            waypoints={[]}
            scan={scanLive ? scan : null}
            ghost={null}
          />

          <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 6, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'calc(100% - 20px)' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '4px 8px', background: 'var(--panel-bg)' }}
                onClick={() => toggleViewPref('mapPoints')}
                aria-pressed={!viewPrefs.mapPoints}
                title="Pius's points from mapping. Hidden ones still count for routes."
              >
                {viewPrefs.mapPoints ? '◉ Hide mapping points' : '○ Show mapping points'}
              </button>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '4px 8px', background: 'var(--panel-bg)' }}
                onClick={() => toggleViewPref('names')}
                aria-pressed={!viewPrefs.names}
                title="Name labels over the points. The selected point always shows its name."
              >
                {viewPrefs.names ? '◉ Hide names' : '○ Show names'}
              </button>
            </div>

          </div>

          {hoveredMapPoint && (
            <C2PoiHoverCard
              point={hoveredMapPoint}
              at={toScreenPt(hoveredMapPoint)}
              mapName={mapName}
              bounds={canvasSize}
            />
          )}

          {selectedLinkInfo && info && (() => {
            const byId = new Map(graphPoints.map((p) => [p.id, p]))
            const a = byId.get(selectedLinkInfo.a)
            const b = byId.get(selectedLinkInfo.b)
            if (!a || !b) return null
            const sa = toScreenPt(a)
            const sb = toScreenPt(b)
            return (
              <div
                className="val-mono"
                style={{
                  position: 'absolute', left: (sa.x + sb.x) / 2, top: (sa.y + sb.y) / 2 - 14,
                  transform: 'translate(-50%, -100%)', zIndex: 5, display: 'flex', alignItems: 'center',
                  gap: 8, padding: '4px 8px', borderRadius: 4, fontSize: 11, whiteSpace: 'nowrap',
                  border: '1px solid var(--accent-bright)', background: 'var(--panel-bg)', color: 'var(--text-h)',
                }}
              >
                <span>
                  {a.name} ↔ {b.name} · {selectedLinkInfo.len.toFixed(1)} m
                  {selectedLinkInfo.crossesWall && (
                    <span style={{ color: '#D97706' }}> · crosses a wall: the robot will have to find its own way round</span>
                  )}
                </span>
                {canEdit ? (
                  <button
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '2px 8px', borderColor: '#DC2626', color: '#DC2626' }}
                    onClick={() => removeLink(selectedLinkInfo.key)}
                  >
                    ✕ Remove link
                  </button>
                ) : (
                  <span style={{ color: 'var(--text-dim)' }}>
                    {graph ? 'Edit graph to change' : 'Open a graph to change'}
                  </span>
                )}
              </div>
            )
          })()}

          {reloc !== 'idle' && info && (
            <div
              className="val-mono"
              style={{
                position: 'absolute', top: 44, left: '50%', transform: 'translateX(-50%)',
                padding: '4px 10px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', zIndex: 4,
                border: '1px solid var(--robot-marker, #22D3EE)', background: 'var(--panel-bg)',
                color: 'var(--robot-marker, #22D3EE)',
              }}
            >
              {reloc === 'placing' && 'Click where the robot is'}
              {reloc === 'placed' && 'Drag the ring to set which way it faces'}
              {reloc === 'sending' && 'Relocalizing…'}
            </div>
          )}

          {robotMap && !robotOnThisMap && (
            <div
              className="val-mono"
              style={{
                position: 'absolute',
                top: 10,
                left: '50%',
                transform: 'translateX(-50%)',
                maxWidth: 'calc(100% - 20px)',
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid #FBBF24',
                background: 'var(--panel-bg)',
                color: '#FBBF24',
                fontSize: 11,
                textAlign: 'center',
                pointerEvents: 'none',
                zIndex: 4,
              }}
            >
              Robot is localized in {robotMap} — not shown on this map
            </div>
          )}

          {renaming && renamePos && (
            <input
              autoFocus
              value={renaming.draft}
              placeholder={renamePlaceholder}
              onChange={(e) => setRenaming((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
              }}
              className="val-mono"
              style={{
                position: 'absolute',
                left: renamePos.x,
                top: renamePos.y,
                transform: 'translate(-50%, -100%)',
                width: 150,
                padding: '4px 6px',
                borderRadius: 4,
                border: '1px solid var(--accent-bright)',
                background: 'var(--panel-bg)',
                color: 'var(--text-h)',
                fontSize: 12,
                textAlign: 'center',
                outline: 'none',
                zIndex: 5,
              }}
            />
          )}
          {!image && (
            <div
              style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 13, color: 'var(--text-dim)',
                textAlign: 'center', padding: 24, pointerEvents: 'none',
              }}
            >
              {selectedMap ? `Loading ${selectedMap.name}…` : 'No map loaded.'}
            </div>
          )}
          <div style={{ position: 'absolute', inset: 0, padding: 10, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', bottom: 10, left: 10, display: 'flex', gap: 8, pointerEvents: 'auto' }}>
              <ViewToggle mode={viewMode} onChange={setViewMode} />
            </div>
            <div style={{ position: 'absolute', bottom: 10, right: 10 }}>
              <ZoomControls
                zoom={view.scale}
                onZoomIn={() => zoomBy(ZOOM_STEP)}
                onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
                onFit={fit}
              />
            </div>
            <div
              style={{
                position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
                display: 'flex', alignItems: 'flex-end', gap: 16,
              }}
            >
              <CoordReadout world={hover} />
              <ScaleBar scale={view.scale} resolution={info?.resolution} />
            </div>
          </div>
        </div>
      </div>
      <div
        ref={rightColRef}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ height: `${mapEnd * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
          <C2LoadMapWidget
            maps={maps}
            loading={storeMaps === null}
            selectedName={mapName}
            onSelect={selectMap}
            onRequestUpload={requestUpload}
            onRefresh={refreshMaps}
            error={mapError}
          />
        </div>
        <ResizeHandle
          direction="v"
          containerRef={rightColRef}
          onResize={(pct) => setMapEnd(Math.min(pct, pointsEnd - MIN_SPAN))}
          min={MIN_SPAN}
          max={0.8}
        />
        <div style={{ height: `${(pointsEnd - mapEnd) * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
          <C2PointsWidget
            pins={ownPins}
            selectedId={selectedId}
            placingType={placingType}
            editable={editing}
            mapName={mapName}
            canUndo={history.past > 0}
            canRedo={history.future > 0}
            onUndo={undo}
            onRedo={redo}
            graph={graph}
            graphs={graphsForMap}
            panelMode={graphPanel}
            onPanelMode={setGraphPanel}
            onCreateGraph={createGraph}
            onLoadGraph={loadGraph}
            onToggleEdit={() => setEditing((e) => !e)}
            onCloseGraph={closeGraph}
            onArm={armPinType}
            linkMode={linkMode}
            linkStartName={linkStart ? graphPoints.find((p) => p.id === linkStart)?.name : null}
            linkCount={links.length}
            onToggleLinkMode={toggleLinkMode}
            onSelect={selectPoint}
            onRemove={removePin}
            onChange={updatePin}
            mapPoints={mapPoints}
            onSetYaw={setYaw}
            storeStatus={storeStatus}
          />
        </div>
        <ResizeHandle
          direction="v"
          containerRef={rightColRef}
          onResize={(pct) => setPointsEnd(Math.max(pct, mapEnd + MIN_SPAN))}
          min={0.2}
          max={1 - MIN_SPAN}
        />
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <C2RobotStatusWidget
            robot={robot}
            live={statusLive}
            mapName={mapName}
            driveBlocker={driveBlocker}
            target={target}
            plan={plan?.ok ? plan : null}
            goBlocker={goBlocker}
            toBlocker={toBlocker}
            routeMode={routeMode}
            activePlan={activePlan}
            routeNote={routeNote}
            busy={busy}
            result={result}
            reloc={reloc}
            posePin={posePin}
            onStartReloc={startReloc}
            onCancelReloc={cancelReloc}
            onSendReloc={handleSendReloc}
            onGoTo={() => handleGo('to')}
            walking={walking}
            navPathShown={Boolean(navPath?.length)}
            hasHome={Boolean(homePin)}
            onReturnHome={handleReturnHome}
            onGoThrough={() => handleGo('through')}
            onCancelRoute={() => setRouteMode(null)}
            onSendRoute={handleSendRoute}
            onPause={handlePause}
            onCancelGoal={handleCancelGoal}
            scanHint={scanHint}
            planLog={planLog}
          />
        </div>
      </div>
    </div>
  )
}
