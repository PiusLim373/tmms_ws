import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTopicActivity } from '../hooks/useTopicActivity'
import { useRos } from '../hooks/useRos'
import { Header } from '../components/Header'
import { Footer } from '../components/Footer'
import { C2MapCanvas } from '../components/widgets/C2MapCanvas'
import { C2PoiHoverCard, C2PoiViewer } from '../components/widgets/C2PoiPhotos'
import { ZoomControls } from '../components/ui/C2MapControls'
import { ResizeHandle } from '../components/ui/ResizeHandle'
import { POSE_ID, POSE_TYPE } from '../lib/c2Pins'
import { fitView, normaliseMapEntry, quaternionToYaw, worldToPixel } from '../lib/c2Coords'
import { cancelNavGoal, setQuadrupedPaused, subscribe } from '../services/rosbridge'
import { ConfirmSendModal } from './ConfirmSendModal'
import { MapOverlay } from './MapOverlay'
import { MapPicker } from './MapPicker'
import { RobotCard } from './RobotCard'
import { TypeGlyph } from './TypeGlyph'
import { WaypointPopover } from './WaypointPopover'
import { nextNavplanId, relocalize, sendNavplan, subscribeLaserScan } from './lib/navplanRos'
import { degFromYaw } from './lib/quat'
import {
  TYPE_LABEL, buildWaypoints, isArrival, isLocked, linkRows, loadRows, makeRow, partnerOf,
  removeRow, saveRows, setType, swapPair, unlink, unlinkedSwitches, updateRow, validateRoute,
} from './lib/routePlan'
import { CANVAS_TYPE, SWITCH_TEXT } from './lib/routeStyle'
import { TONE } from './lib/tone'
import './tester.css'

const STATUS_TOPIC = '/quadruped_main_status'
const STATUS_TYPE = 'tmms_msgs/QuadrupedMainStatus'
// A scan older than this is treated as lost: no longer drawn, and flagged on the map.
const SCAN_TIMEOUT_MS = 2000

// Smallest share of the widget column any one widget may be squeezed to -- about a header.
const MIN_SPAN = 0.06

// C2MapCanvas's heading-ring radius, matched by the map-switch ring.
const RING_PX = 48

// Same hover behaviour as the C2 page's map points.
const POI_HOVER_PX = 16
const HOVER_CARD_LINGER_MS = 250

// Same chrome as the C2 widgets: header with a status slot, then a body that scrolls on its own.
function Widget({ title, aside, children }) {
  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>{title}</span>
        {aside}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px' }}>
        {children}
      </div>
    </div>
  )
}

const RAIL_W = 34
// Matches the transitions in tester.css.
const SLIDE_MS = 220

// The sidebar's toggle: the whole strip is the button, showing a count of what the sidebar holds.
function Rail({ open, onToggle, waypoints, points }) {
  const label = open ? 'Hide waypoints and points of interest' : 'Show waypoints and points of interest'
  const count = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }
  return (
    <button
      className="panel npt-rail"
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls="npt-sidebar"
      onClick={onToggle}
      style={{
        width: RAIL_W, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 14, padding: '8px 0', cursor: 'pointer',
      }}
    >
      <span className="npt-rail-chevron">
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          className="npt-turn"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </span>
      <span style={count}>
        <TypeGlyph type="simple" size={14} />
        <span className="val-mono">{waypoints}</span>
      </span>
      <span style={count}>
        <TypeGlyph type="poi" size={14} />
        <span className="val-mono">{points}</span>
      </span>
      <span
        className="val-mono"
        style={{
          writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: 10,
          letterSpacing: '0.14em', color: 'var(--text-dim)', whiteSpace: 'nowrap',
        }}
      >
        WAYPOINTS · POI
      </span>
    </button>
  )
}

// Not localized in any sense the operator must act on. `pending` is converging, not a fault.
const LOC_FAULTS = new Set(['not_started', 'failed', 'localization_lost'])

// The robot centred, at twice the zoom that fits the whole map.
function robotView(info, size, position) {
  const scale = Math.min(40, fitView(info, size).scale * 2)
  const g = worldToPixel(position.x, position.y, info)
  return { scale, x: size.width / 2 - g.x * scale, y: size.height / 2 - g.y * scale }
}

function Aside({ children, color }) {
  return (
    <span className="val-mono" style={{ fontSize: 10, color: color ?? 'var(--text-dim)' }}>
      {children}
    </span>
  )
}

// The name chip C2MapCanvas draws over poi and map-switch pins. Simple and home pins get no
// chip there, so drawRoute gives them a step badge instead.
function chipLabel(rows, row, i) {
  if (row.type === 'map_switch') {
    const partner = partnerOf(rows, row)
    const where = !partner ? 'unlinked' : isArrival(rows, i) ? `from ${partner.map}` : `to ${partner.map}`
    return `#${i + 1} ⇄ ${where}`
  }
  return `#${i + 1}${row.label ? ` ${row.label}` : ''}`
}

function drawLine(ctx, a, b) {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}

// C2MapCanvas draws no heading for a type it does not know, so a map switch's is drawn here,
// the same shape as C2's, under the pin.
function drawHeading(ctx, s, yaw, color) {
  const len = 30
  const tipX = s.x + Math.cos(-yaw) * len
  const tipY = s.y + Math.sin(-yaw) * len
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  drawLine(ctx, s, { x: tipX, y: tipY })
  const wing = 7
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - Math.cos(-yaw - 0.45) * wing, tipY - Math.sin(-yaw - 0.45) * wing)
  ctx.lineTo(tipX - Math.cos(-yaw + 0.45) * wing, tipY - Math.sin(-yaw + 0.45) * wing)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

// A map switch still waiting for its pair. Clears C2MapCanvas's selection halo (radius 23).
function drawUnlinkedRing(ctx, s) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(s.x, s.y, 26, 0, Math.PI * 2)
  ctx.strokeStyle = TONE.warn
  ctx.lineWidth = 2.5
  ctx.setLineDash([6, 4])
  ctx.stroke()
  ctx.restore()
}

function drawStepBadge(ctx, s, text) {
  ctx.save()
  ctx.font = '700 11px Inter, system-ui, sans-serif'
  const w = ctx.measureText(text).width + 8
  const x = s.x + 11
  const y = s.y - 26
  ctx.beginPath()
  ctx.roundRect(x, y, w, 16, 3)
  ctx.fillStyle = 'rgba(11, 7, 16, 0.9)'
  ctx.fill()
  ctx.fillStyle = '#FFFFFF'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + 4, y + 8.5)
  ctx.restore()
}

export function NavplanTesterPage() {
  // -- robot state ---------------------------------------------------------
  const { active: statusLive, lastMsg: status } = useTopicActivity(STATUS_TOPIC, STATUS_TYPE, 1500)
  const { connected } = useRos()
  // Same rule as App.jsx: no battery reading at all beats a stale one.
  const battery = statusLive ? status?.battery_percentage : undefined

  // Same key and effect as App.jsx, so this page follows the dashboard's theme and the
  // header's toggle changes both. Without it the page ignored the theme entirely.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'dark' } catch { return 'dark' }
  })
  useEffect(() => {
    document.documentElement.className = theme === 'light' ? 'light' : ''
    try { localStorage.setItem('theme', theme) } catch { /* private window: theme just won't stick */ }
  }, [theme])

  const navState = status?.navigation_state ?? ''
  const locStatus = status?.localization_status ?? ''
  const robotMap = status?.current_map ?? ''
  const isPaused = status?.is_paused ?? true

  const robot = useMemo(() => {
    if (!status?.pose?.position) return null
    return {
      position: { x: status.pose.position.x, y: status.pose.position.y },
      yaw: quaternionToYaw(status.pose.orientation),
    }
  }, [status])

  // Latched by tmms_yasmin, so a page opened mid-route still shows where it is.
  const [route, setRoute] = useState(null)
  const [segment, setSegment] = useState(null)
  useEffect(() => subscribe('/curr_route', 'tmms_msgs/Route', setRoute), [])
  useEffect(() => subscribe('/curr_route_segment', 'tmms_msgs/RouteSegment', setSegment), [])

  // -- map -----------------------------------------------------------------
  const [maps, setMaps] = useState(null)
  const [mapName, setMapName] = useState(null)
  const [image, setImage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    fetch('/api/maps2d')
      .then((r) => r.json())
      .then((list) => setMaps(list.map(normaliseMapEntry).filter(Boolean)))
      .catch(() => setMaps([]))
  }, [])

  const selectedMap = useMemo(
    () => maps?.find((m) => m.name === mapName) ?? null, [maps, mapName])

  // A refresh loses the selected map, but the robot still has one loaded. Once both the map
  // list and the robot's current_map are known, show that map -- once, and only if the
  // operator hasn't picked one, so this never overrides a choice. The boot placeholder
  // (default_map) is hidden from /api/maps2d, so it is never restored.
  const restoredMap = useRef(false)
  useEffect(() => {
    if (restoredMap.current || mapName || !maps || !robotMap) return
    restoredMap.current = true
    if (maps.some((m) => m.name === robotMap)) setMapName(robotMap)
  }, [maps, robotMap, mapName])

  useEffect(() => {
    if (!selectedMap) { setImage(null); return }
    let cancelled = false
    const img = new Image()
    img.onload = () => { if (!cancelled) setImage(img) }
    img.src = `/api/maps2d/${encodeURIComponent(selectedMap.name)}/image`
    return () => { cancelled = true }
  }, [selectedMap])

  const info = useMemo(() => (selectedMap
    ? {
      width: selectedMap.width,
      height: selectedMap.height,
      resolution: selectedMap.resolution,
      origin: selectedMap.origin,
    }
    : null), [selectedMap])

  // -- canvas view ---------------------------------------------------------
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  // Both: the ref is what the fit effect reads without re-running, the state is what gives
  // the overlay canvas real width/height attributes.
  const [size, setSize] = useState({ width: 0, height: 0 })
  const sizeRef = useRef({ width: 0, height: 0 })
  const fittedFor = useRef(null)
  const onSizeChange = useCallback((s) => { sizeRef.current = s; setSize(s) }, [])

  // Set by the locate button; consumed once the robot's map is fitted, so it lands centred.
  const centerOnRobot = useRef(false)

  useEffect(() => {
    if (!info || !image || !sizeRef.current.width) return
    const key = `${mapName}:${info.width}x${info.height}`
    if (fittedFor.current !== key) {
      fittedFor.current = key
      setView(fitView(info, sizeRef.current))
    }
    if (centerOnRobot.current && robot?.position && mapName === robotMap) {
      centerOnRobot.current = false
      setView(robotView(info, sizeRef.current, robot.position))
    }
  }, [info, mapName, image, robot, robotMap])

  const zoomBy = useCallback((f) => setView((v) => {
    const { width, height } = sizeRef.current
    const cx = width / 2
    const cy = height / 2
    const scale = Math.min(40, Math.max(0.05, v.scale * f))
    return { scale, x: cx - ((cx - v.x) / v.scale) * scale, y: cy - ((cy - v.y) / v.scale) * scale }
  }), [])

  const toScreenPt = useCallback((p) => {
    const g = worldToPixel(p.x, p.y, info)
    return { x: view.x + g.x * view.scale, y: view.y + g.y * view.scale }
  }, [info, view])

  // -- laser scan overlay ---------------------------------------------------
  // Always on. Staleness is tracked the same way as useTopicActivity, which can't be used
  // directly: the scan needs subscribeLaserScan's cbor + throttle options.
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

  // -- layout --------------------------------------------------------------
  // Not persisted. The sidebar starts closed, leaving the map the whole width. When open,
  // POINTS OF INTEREST and WAYPOINTS share it; splits[i] is the bottom edge of widget i as a
  // fraction of the column, the last taking the rest.
  const pageRef = useRef(null)
  const colRef = useRef(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarW, setSidebarW] = useState(400)
  const [splits, setSplits] = useState([0.3])

  // The width only animates while opening or closing, so dragging the handle stays direct.
  const [sliding, setSliding] = useState(false)
  const slideTimer = useRef(null)
  useEffect(() => () => clearTimeout(slideTimer.current), [])

  const toggleSidebar = useCallback(() => {
    clearTimeout(slideTimer.current)
    setSliding(true)
    setSidebarOpen((o) => !o)
    slideTimer.current = setTimeout(() => setSliding(false), SLIDE_MS + 50)
  }, [])

  // ResizeHandle reports where the map ends, as a fraction of the page.
  const resizeSidebar = useCallback((pct) => {
    const width = pageRef.current?.getBoundingClientRect().width
    if (width) setSidebarW(Math.round(width * (1 - pct)) - RAIL_W)
  }, [])

  const resizeSplit = useCallback((i, pct) => setSplits((s) => {
    const lo = (i > 0 ? s[i - 1] : 0) + MIN_SPAN
    const hi = (i < s.length - 1 ? s[i + 1] : 1) - MIN_SPAN
    const next = [...s]
    next[i] = Math.min(hi, Math.max(lo, pct))
    return next
  }), [])

  // -- route ---------------------------------------------------------------
  // Every waypoint on every map, in route order. Kept in this browser so a reload does not
  // lose a route plotted across several maps.
  const [rows, setRows] = useState(loadRows)
  useEffect(() => { saveRows(rows) }, [rows])
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const [selectedId, setSelectedId] = useState(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [hover, setHover] = useState(null)

  // -- points of interest -------------------------------------------------
  // From the map's yaml, built the way the C2 page builds its map points.
  const mapPoints = useMemo(() => (selectedMap?.pois ?? [])
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      id: `poi_${p.id}`,
      poiId: p.id,
      type: 'action',
      source: 'mapping',
      x: p.x,
      y: p.y,
      yaw: ((Number(p.yaw) || 0) * Math.PI) / 180,
      headingSet: Number.isFinite(p.yaw),
      label: p.name || `POI_${p.id}`,
      poi: { description: p.description ?? '', snapshots: p.snapshots ?? [], timestamp: p.timestamp ?? '' },
    })), [selectedMap])

  const routedPoiIds = useMemo(() => new Set(
    rows.filter((r) => r.map === mapName && r.poiId != null).map((r) => r.poiId)), [rows, mapName])

  const addPoiToRoute = useCallback((point) => {
    if (!mapName) return
    setRows((prev) => [...prev, makeRow(mapName, point, {
      type: 'poi', poiId: point.poiId, yaw: point.yaw, headingSet: point.headingSet, label: point.label,
    })])
  }, [mapName])

  const [viewerId, setViewerId] = useState(null)
  const viewerPoint = mapPoints.find((p) => p.id === viewerId) ?? null

  // -- relocalize ------------------------------------------------------------
  // 'idle' -> 'placing' -> 'placed' -> (send | cancel) -> 'idle', on C2's pose pin.
  const [reloc, setReloc] = useState('idle')
  const [posePin, setPosePin] = useState(null)

  const cancelReloc = useCallback(() => {
    setReloc('idle')
    setPosePin(null)
    setSelectedId((cur) => (cur === POSE_ID ? null : cur))
  }, [])

  // Waypoint placing is the resting state; relocalizing temporarily takes the cursor over.
  const placingType = reloc === 'idle' ? 'simple' : reloc === 'placing' ? POSE_TYPE : null

  const handlePlace = useCallback((type, world) => {
    if (type === POSE_TYPE) {
      setPosePin({ id: POSE_ID, type: POSE_TYPE, x: world.x, y: world.y, yaw: 0, headingSet: false, label: '' })
      setSelectedId(POSE_ID)
      setReloc('placed')
      return
    }
    // With a pin open, a click elsewhere closes it rather than dropping a stray waypoint.
    if (selectedIdRef.current != null) { setSelectedId(null); return }
    if (mapName) setRows((prev) => [...prev, makeRow(mapName, world)])
  }, [mapName])

  const handleMovePin = useCallback((id, world) => {
    if (id === POSE_ID) { setPosePin((p) => (p ? { ...p, x: world.x, y: world.y } : p)); return }
    const row = rowsRef.current.find((r) => r.id === id)
    if (row && !isLocked(row)) setRows((prev) => updateRow(prev, id, { x: world.x, y: world.y }))
  }, [])

  const handleSetYaw = useCallback((id, yaw) => {
    // A turned heading is chosen, no longer the map switch default.
    const patch = { yaw: yaw ?? 0, headingSet: yaw != null, headingDefault: false }
    if (id === POSE_ID) { setPosePin((p) => (p ? { ...p, ...patch } : p)); return }
    const row = rowsRef.current.find((r) => r.id === id)
    if (row && !isLocked(row)) setRows((prev) => updateRow(prev, id, patch))
  }, [])

  // Browsing only: the route stays, and each pin keeps the map it was drawn on.
  const selectMap = useCallback((name) => {
    setMapName(name)
    setSelectedId(null)
    setHover(null)
    cancelReloc()
  }, [cancelReloc])

  const focusRow = useCallback((row) => {
    if (row.map !== mapName) selectMap(row.map)
    setSelectedId(row.id)
  }, [mapName, selectMap])

  // -- selection -------------------------------------------------------------
  const selectedIndex = rows.findIndex((r) => r.id === selectedId)
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null
  const selectedPoint = mapPoints.find((p) => p.id === selectedId) ?? null
  // Map.yaml points never move; with one selected, C2MapCanvas shows no drag or heading handle.
  const lockedSelection = Boolean(selectedPoint) || isLocked(selectedRow)

  // The robot pose only means something on the map it is localized on.
  const robotHere = robotMap && mapName === robotMap ? robot : null

  // -- canvas ----------------------------------------------------------------
  const canvasPins = useMemo(() => {
    const routePins = []
    rows.forEach((row, i) => {
      if (row.map !== mapName) return
      routePins.push({
        id: row.id, type: CANVAS_TYPE[row.type], x: row.x, y: row.y, yaw: row.yaw,
        headingSet: row.headingSet, label: chipLabel(rows, row, i), order: i,
      })
    })
    // A routed POI is drawn as its route pin only; two pins on one spot would fight for clicks.
    const points = mapPoints.filter((p) => !routedPoiIds.has(p.poiId))
    return [...points, ...routePins, ...(posePin ? [posePin] : [])]
  }, [rows, mapName, mapPoints, routedPoiIds, posePin])

  // Under the pins: legs between consecutive waypoints on this map, the robot's dashed first
  // leg, map-switch headings and unlinked rings, and step badges for the pins C2MapCanvas
  // draws no chip on.
  const drawRoute = useCallback((ctx, toScreen) => {
    if (!mapName) return
    const css = getComputedStyle(document.documentElement)
    const switchColor = css.getPropertyValue('--pin-simple').trim() || '#1D4ED8'
    ctx.save()
    ctx.strokeStyle = css.getPropertyValue('--pin-action').trim() || '#DC2626'
    ctx.globalAlpha = 0.75
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    if (robotHere?.position && rows[0]?.map === mapName) {
      ctx.setLineDash([6, 4])
      drawLine(ctx, toScreen(robotHere.position.x, robotHere.position.y), toScreen(rows[0].x, rows[0].y))
      ctx.setLineDash([])
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].map === mapName && rows[i - 1].map === mapName) {
        drawLine(ctx, toScreen(rows[i - 1].x, rows[i - 1].y), toScreen(rows[i].x, rows[i].y))
      }
    }
    ctx.restore()

    rows.forEach((row, i) => {
      if (row.map !== mapName) return
      const s = toScreen(row.x, row.y)
      if (row.type === 'map_switch') {
        if (row.headingSet) drawHeading(ctx, s, row.yaw, switchColor)
        if (!row.link) drawUnlinkedRing(ctx, s)
      } else if (row.type === 'simple' || row.type === 'home') {
        drawStepBadge(ctx, s, `#${i + 1}`)
      }
    })
  }, [rows, mapName, robotHere])

  // -- map-switch heading ring -------------------------------------------------
  // C2MapCanvas only rings its own heading types, so a selected map switch gets the same ring
  // here, over the canvas: same orbit, same drag, Shift snaps to 15°.
  const ringDrag = useRef(false)
  const ringAt = selectedRow?.type === 'map_switch' && selectedRow.map === mapName && info
    ? toScreenPt(selectedRow)
    : null

  function dragRing(e) {
    if (!ringDrag.current || !ringAt) return
    const box = e.currentTarget.parentElement.getBoundingClientRect()
    let yaw = Math.atan2(-(e.clientY - box.top - ringAt.y), e.clientX - box.left - ringAt.x)
    if (e.shiftKey) yaw = Math.round(yaw / (Math.PI / 12)) * (Math.PI / 12)
    handleSetYaw(selectedRow.id, yaw)
  }

  // -- POI hover card ----------------------------------------------------------
  const hoveredPoint = useMemo(() => {
    if (!hover || !info || viewerId) return null
    const h = toScreenPt(hover)
    return mapPoints.find((p) => {
      const s = toScreenPt(p)
      return Math.hypot(s.x - h.x, s.y - h.y) <= POI_HOVER_PX
    }) ?? null
  }, [hover, info, viewerId, mapPoints, toScreenPt])
  const [cardId, setCardId] = useState(null)
  const onCardRef = useRef(false)
  useEffect(() => {
    if (hoveredPoint) { setCardId(hoveredPoint.id); return undefined }
    if (viewerId) { setCardId(null); return undefined }
    const t = setTimeout(() => { if (!onCardRef.current) setCardId(null) }, HOVER_CARD_LINGER_MS)
    return () => clearTimeout(t)
  }, [hoveredPoint, viewerId])
  // Not over the point being edited: the popover is there.
  const cardPoint = mapPoints.find((p) => p.id === cardId
    && p.id !== selectedId && p.poiId !== selectedRow?.poiId) ?? null

  // -- actions -------------------------------------------------------------
  const finish = (ok, message) => { setBusy(false); setResult({ ok, message }) }

  const editRows = useCallback((fn) => setRows((prev) => fn(prev)), [])

  // Sent with the viewed map, which need not be the robot's: relocalizing is how the robot is
  // moved onto it. The reply is the outcome, so the pin stays on failure to be nudged and resent.
  function handleSendRelocalize() {
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

  const problems = useMemo(() => validateRoute(rows, robotMap || null), [rows, robotMap])
  const [confirm, setConfirm] = useState(null)   // the plan awaiting confirmation

  function handleSend() {
    if (problems.length || busy) return
    setConfirm({
      navplanId: nextNavplanId(),
      waypoints: buildWaypoints(rows),
      // Display only, and only meaningful when the route starts on the robot's map.
      robotStart: robot && robotMap === rows[0].map
        ? { x: robot.position.x, y: robot.position.y, yaw: robot.yaw }
        : null,
    })
  }

  function handleConfirmSend() {
    const plan = confirm
    setConfirm(null)
    setBusy(true); setResult(null)
    sendNavplan(plan,
      (r) => finish(r.success, r.message),
      (e) => finish(false, String(e)))
  }

  function handleClear() {
    if (!rows.length) return
    if (!window.confirm(`Remove all ${rows.length} waypoints, on every map?`)) return
    setRows([])
    setSelectedId(null)
  }

  function handlePause() {
    const next = !isPaused
    setBusy(true); setResult(null)
    setQuadrupedPaused(next,
      (r) => finish(r.success, r.message),
      (e) => finish(false, String(e)))
  }

  // /cancel_goal is a Trigger: it refuses during a map switch and when nothing is running.
  function handleCancel() {
    setBusy(true); setResult(null)
    cancelNavGoal(
      (r) => finish(r?.success !== false, r?.message || 'Cancel requested.'),
      (e) => finish(false, String(e)))
  }

  // C2MapCanvas does no key handling of its own -- on the C2 page, Delete and Escape belong
  // to C2Page. Reusing only the canvas left this page with neither, so they live here.
  useEffect(() => {
    // Text fields only. A <select> never takes Delete/Backspace as input, and the map picker
    // here is often the last thing focused.
    const isTyping = (t) => Boolean(t) && (t.isContentEditable
      || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

    const onKey = (e) => {
      // The pin is in flight; removing it now would leave a failed reply with nothing to retry.
      // The photo viewer and the confirm modal handle their own keys.
      if (isTyping(e.target) || reloc === 'sending' || viewerId != null || confirm) return

      if (e.key === 'Escape') {
        if (reloc !== 'idle') cancelReloc()
        setSelectedId(null)
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        if (selectedId === POSE_ID) cancelReloc()
        else if (rowsRef.current.some((r) => r.id === selectedId)) {
          setRows((prev) => removeRow(prev, selectedId))
          setSelectedId(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, reloc, cancelReloc, viewerId, confirm])

  // -- derived display -------------------------------------------------------
  const mapMismatch = Boolean(mapName && robotMap && mapName !== robotMap)
  const onRobotMap = Boolean(mapName && mapName === robotMap)
  const countByMap = useMemo(
    () => rows.reduce((m, r) => m.set(r.map, (m.get(r.map) ?? 0) + 1), new Map()), [rows])

  // The overlay has four independent preconditions and used to fail all of them silently,
  // which is a miserable thing to debug. Name whichever one is blocking.
  const scanHint = !info ? 'select a map to draw on'
    : !scanLive ? 'no /rslidar_scan received'
      : !robotMap ? 'robot has no map loaded'
        : mapName !== robotMap ? `robot is on “${robotMap}”, not this map`
          : !robot ? 'no robot pose on /quadruped_main_status'
            : null
  const scanOk = scanHint == null

  const segmentText = useMemo(() => {
    const first = segment?.waypoints?.[0]
    if (!first) return ''
    const all = route?.route_segments ?? []
    const k = all.findIndex((s) => s.waypoints?.[0]?.id === first.id
      && s.waypoints[0].map_name === first.map_name && s.waypoints.length === segment.waypoints.length)
    return `${k >= 0 ? `${k + 1}/${all.length} · ` : ''}${first.map_name} · ends ${segment.end_action}`
  }, [route, segment])

  let popover = null
  if (info && reloc !== 'sending') {
    if (selectedPoint) {
      popover = (
        <WaypointPopover
          anchor={toScreenPt(selectedPoint)}
          bounds={size}
          mapName={mapName}
          poi={selectedPoint}
          onAddPoi={() => { addPoiToRoute(selectedPoint); setSelectedId(null) }}
          onPhotos={() => setViewerId(selectedPoint.id)}
          onClose={() => setSelectedId(null)}
        />
      )
    } else if (selectedRow && selectedRow.map === mapName) {
      const id = selectedRow.id
      const partner = partnerOf(rows, selectedRow)
      popover = (
        <WaypointPopover
          anchor={toScreenPt(selectedRow)}
          bounds={size}
          mapName={selectedRow.map}
          row={selectedRow}
          step={selectedIndex + 1}
          locked={isLocked(selectedRow)}
          partner={partner}
          partnerStep={partner ? rows.indexOf(partner) + 1 : null}
          arrival={isArrival(rows, selectedIndex)}
          candidates={unlinkedSwitches(rows, selectedRow.map)}
          onType={(t) => editRows((prev) => setType(prev, id, t))}
          // The candidate was plotted first, so it is where the robot stops.
          onLink={(cid) => editRows((prev) => linkRows(prev, cid, id))}
          onUnlink={() => editRows((prev) => unlink(prev, id))}
          onSwap={() => editRows((prev) => swapPair(prev, id))}
          onDelete={() => { editRows((prev) => removeRow(prev, id)); setSelectedId(null) }}
          onClose={() => setSelectedId(null)}
        />
      )
    }
  }

  // A failed map-switch relocalize lands here too: localization `failed`, yasmin `unlocalized`.
  const locFault = statusLive && (navState === 'unlocalized' || LOC_FAULTS.has(locStatus))
  // /relocalize refuses while any attempt runs, including one started from Lichtblick.
  const relocBlocked = !info || busy || locStatus === 'pending'
  const robotMapKnown = Boolean(robotMap && maps?.some((m) => m.name === robotMap))
  // yasmin refuses a cancel during map_switching itself; the reply says why.
  const cancelOff = busy || (navState !== 'navigating' && navState !== 'map_switching')

  function locateRobot() {
    if (!robotMapKnown) return
    centerOnRobot.current = Boolean(robot?.position)
    if (robotMap !== mapName) { selectMap(robotMap); return }
    if (info && robot?.position) {
      centerOnRobot.current = false
      setView(robotView(info, sizeRef.current, robot.position))
    }
  }

  const widgets = [
    <Widget key="pois" title="POINTS OF INTEREST" aside={<Aside>{mapPoints.length}</Aside>}>
      {mapPoints.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {info ? 'This map has no points of interest.' : 'Select a map to see its points of interest.'}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>
            From the map.yaml. Hover a marker for its photos, click a row to open them. ＋ adds
            it to the route.
          </div>
          {mapPoints.map((p) => (
            <div
              key={p.id}
              onClick={() => setViewerId(p.id)}
              className="val-mono"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 11, padding: '3px 4px', cursor: 'pointer', color: 'var(--text)',
                borderLeft: `2px solid ${routedPoiIds.has(p.poiId) ? 'var(--pin-poi)' : 'transparent'}`,
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--pin-poi)' }}>#{p.poiId}</span> {p.label}
                <span style={{ color: 'var(--text-dim)' }}>
                  {' '}· {p.x.toFixed(1)}, {p.y.toFixed(1)} · {degFromYaw(p.yaw).toFixed(0)}°
                </span>
              </span>
              <button
                className="btn-icon"
                title="Add to route"
                onClick={(e) => { e.stopPropagation(); addPoiToRoute(p) }}
              >
                ＋
              </button>
            </div>
          ))}
        </>
      )}
    </Widget>,

    <Widget key="waypoints" title="WAYPOINTS" aside={<Aside>{rows.length}</Aside>}>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>
        Click the map to add a waypoint, click a pin to change its type. A map switch pairs a pin
        on each map: where the robot stops, then where it relocalizes. Changing map keeps the
        route.
      </div>

      {rows.map((row, i) => {
        const partner = row.type === 'map_switch' ? partnerOf(rows, row) : null
        const newMap = i === 0 || rows[i - 1].map !== row.map
        return (
          <Fragment key={row.id}>
            {newMap && (
              <div
                className="val-mono"
                style={{
                  fontSize: 10, color: 'var(--text-dim)', marginTop: i ? 6 : 0, padding: '2px 4px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {row.map}{row.map === robotMap ? ' · robot here' : ''}
              </div>
            )}
            <div
              onClick={() => focusRow(row)}
              className="val-mono"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
                fontSize: 11, padding: '3px 4px', cursor: 'pointer', color: 'var(--text)',
                borderLeft: `2px solid ${row.id === selectedId ? 'var(--accent-bright)' : 'transparent'}`,
              }}
            >
              <span
                style={{
                  minWidth: 0, display: 'flex', alignItems: 'center', gap: 5,
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}
              >
                <span style={{ width: 18, textAlign: 'right' }}>{i + 1}.</span>
                <TypeGlyph type={row.type} size={12} unlinked={row.type === 'map_switch' && !partner} />
                {row.type === 'map_switch' ? (
                  <span style={{ color: partner ? SWITCH_TEXT : TONE.warn }}>
                    {!partner ? '⚠ unlinked' : isArrival(rows, i) ? `← ${partner.map}` : `→ ${partner.map}`}
                  </span>
                ) : (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.label || TYPE_LABEL[row.type]}
                  </span>
                )}
                <span style={{ color: 'var(--text-dim)' }}>
                  {row.x.toFixed(1)}, {row.y.toFixed(1)}
                  {row.type !== 'simple' && row.headingSet && ` · ${degFromYaw(row.yaw).toFixed(0)}°`}
                </span>
              </span>
              <button
                className="btn-icon"
                onClick={(e) => {
                  e.stopPropagation()
                  setRows((prev) => removeRow(prev, row.id))
                  setSelectedId((cur) => (cur === row.id ? null : cur))
                }}
              >
                ✕
              </button>
            </div>
          </Fragment>
        )
      })}

      {rows.length > 0 && problems.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {problems.map((p) => (
            <div key={p} style={{ fontSize: 10, color: TONE.warn }}>⚠ {p}</div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn-icon" style={{ flex: 1 }} disabled={!rows.length} onClick={handleClear}>
          Clear
        </button>
        <button
          className="btn-icon"
          style={{ flex: 2, borderColor: 'var(--accent-bright)' }}
          disabled={problems.length > 0 || busy}
          title={problems[0]}
          onClick={handleSend}
        >
          Send navplan ▶
        </button>
      </div>
    </Widget>,
  ]

  // Scan problems other than the robot being on another map, which the mismatch note covers.
  const lidarHint = scanOk || mapMismatch ? null : scanHint

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <Header
        connected={connected}
        battery={battery}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      <div ref={pageRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {/* Map */}
        <div
          className="panel flex flex-col"
          style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
        >
          {/* The header is the dashboard's, so this is what says which page you are on. */}
          <div className="panel-header">
            <span>NAVPLAN TESTER</span>
          </div>

          <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
            <C2MapCanvas
              info={info}
              image={image}
              pins={canvasPins}
              selectedId={selectedId}
              placingType={info ? placingType : null}
              editable={Boolean(info) && !lockedSelection}
              view={view}
              robot={robotHere}
              onViewChange={setView}
              onPlace={handlePlace}
              onSelect={setSelectedId}
              onMovePin={handleMovePin}
              onSetYaw={handleSetYaw}
              onHover={setHover}
              onSizeChange={onSizeChange}
              drawUnder={drawRoute}
            />

            {/* Scan and the relocalize ghost only; the route is drawn under the pins. */}
            <MapOverlay
              info={info}
              view={view}
              size={size}
              robot={robotHere}
              waypoints={[]}
              scan={scanLive ? scan : null}
              ghost={reloc === 'placing' ? hover : null}
            />

            {cardPoint && (
              <C2PoiHoverCard
                point={cardPoint}
                at={toScreenPt(cardPoint)}
                mapName={mapName}
                bounds={size}
                onOpen={() => { onCardRef.current = false; setViewerId(cardPoint.id) }}
                onPointerEnter={() => { onCardRef.current = true }}
                onPointerLeave={() => { onCardRef.current = false; setCardId(null) }}
              />
            )}

            {ringAt && (
              <>
                <div
                  style={{
                    position: 'absolute', left: ringAt.x - RING_PX, top: ringAt.y - RING_PX,
                    width: RING_PX * 2, height: RING_PX * 2, borderRadius: '50%',
                    border: '1.2px solid var(--accent-bright)', opacity: 0.35, pointerEvents: 'none',
                  }}
                />
                <div
                  role="slider"
                  aria-label="Map switch heading"
                  aria-valuenow={Math.round(degFromYaw(selectedRow.yaw))}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    e.currentTarget.setPointerCapture(e.pointerId)
                    ringDrag.current = true
                  }}
                  onPointerMove={dragRing}
                  onPointerUp={(e) => {
                    ringDrag.current = false
                    e.currentTarget.releasePointerCapture?.(e.pointerId)
                  }}
                  style={{
                    position: 'absolute', zIndex: 5, width: 22, height: 22, cursor: 'grab',
                    left: ringAt.x + Math.cos(-selectedRow.yaw) * RING_PX - 11,
                    top: ringAt.y + Math.sin(-selectedRow.yaw) * RING_PX - 11,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none',
                  }}
                >
                  <span
                    style={{
                      width: 12, height: 12, borderRadius: '50%', background: 'var(--accent-bright)',
                      border: '2px solid #FFFFFF',
                    }}
                  />
                </div>
              </>
            )}

            {popover}

            {info && (
              <>
                <div style={{ position: 'absolute', right: 10, bottom: 10 }}>
                  <ZoomControls
                    onZoomIn={() => zoomBy(1.4)}
                    onZoomOut={() => zoomBy(1 / 1.4)}
                    onFit={() => setView(fitView(info, sizeRef.current))}
                    zoom={view.scale}
                  />
                </div>

                <div
                  style={{
                    position: 'absolute', top: 10, left: 10, zIndex: 4, maxWidth: 'calc(100% - 360px)',
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6,
                    pointerEvents: 'none',
                  }}
                >
                  <div
                    className="val-mono"
                    style={{
                      maxWidth: '100%', padding: '4px 8px', borderRadius: 4, fontSize: 11,
                      background: 'var(--panel-bg)', border: '1px solid var(--border)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      color: reloc === 'idle' ? 'var(--text-dim)' : 'var(--robot-marker, #22D3EE)',
                    }}
                  >
                    {reloc === 'idle' && 'Click to add a waypoint · click a pin to edit it'}
                    {reloc === 'placing' && 'Click the robot’s position'}
                    {reloc === 'placed' && 'Drag the ring to set its heading'}
                    {reloc === 'sending' && 'Relocalizing…'}
                  </div>

                  {lidarHint && (
                    <div
                      className="val-mono"
                      style={{
                        maxWidth: '100%', padding: '4px 10px', borderRadius: 4,
                        border: `1px solid ${TONE.warn}`, background: 'var(--panel-bg)',
                        color: TONE.warn, fontSize: 11,
                      }}
                    >
                      ⚠ LIDAR · {lidarHint}
                    </div>
                  )}
                </div>
              </>
            )}

            {!info && (
              <div
                style={{
                  position: 'absolute', inset: 0, display: 'flex', pointerEvents: 'none',
                  alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-dim)', fontSize: 12,
                }}
              >
                Select a map to begin.
              </div>
            )}

            <div
              style={{
                position: 'absolute', top: 10, right: 10, zIndex: 8, maxWidth: 'calc(100% - 20px)',
                display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
              }}
            >
              <MapPicker
                maps={maps}
                value={mapName}
                robotMap={robotMap}
                counts={countByMap}
                disabled={busy}
                onChange={selectMap}
              />
              {mapMismatch && (
                <div
                  className="npt-card"
                  style={{
                    maxWidth: 300, padding: '6px 10px', fontSize: 11, lineHeight: 1.45,
                    color: TONE.warn, borderColor: TONE.warn, pointerEvents: 'none',
                  }}
                >
                  Robot is on “{robotMap}”. Relocalize here to drive on this map.
                </div>
              )}
            </div>

            <div style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 5 }}>
              <RobotCard
                live={statusLive}
                status={status}
                robot={robot}
                segmentText={segmentText}
                isPaused={isPaused}
                busy={busy}
                cancelOff={cancelOff}
                result={result}
                onRobotMap={onRobotMap}
                robotMapKnown={robotMapKnown}
                onLocate={locateRobot}
                reloc={reloc}
                posePin={posePin}
                mapName={mapName}
                mapMismatch={mapMismatch}
                locFault={locFault}
                relocBlocked={relocBlocked}
                onRelocStart={() => { setSelectedId(null); setReloc('placing') }}
                onRelocCancel={cancelReloc}
                onRelocSend={handleSendRelocalize}
                onPause={handlePause}
                onCancel={handleCancel}
              />
            </div>
          </div>
        </div>

        {sidebarOpen && (
          <ResizeHandle
            direction="h"
            containerRef={pageRef}
            onResize={resizeSidebar}
            min={0.4}
            max={0.85}
          />
        )}

        <Rail
          open={sidebarOpen}
          onToggle={toggleSidebar}
          waypoints={rows.length}
          points={mapPoints.length}
        />

        {/* Always mounted so it can slide: the outer box animates its width while the column
            inside keeps its own, so the widgets slide in rather than reflow. Split by drag
            handles; resizeSplit does the clamping, so the handles' own min/max are wide open. */}
        <div
          id="npt-sidebar"
          inert={!sidebarOpen}
          className={sliding ? 'npt-slide-width' : undefined}
          style={{ width: sidebarOpen ? sidebarW : 0, flexShrink: 0, display: 'flex', overflow: 'hidden' }}
        >
          <div
            ref={colRef}
            style={{ width: sidebarW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            {widgets.map((w, i) => (
              <Fragment key={w.key}>
                {i > 0 && (
                  <ResizeHandle
                    direction="v"
                    containerRef={colRef}
                    onResize={(pct) => resizeSplit(i - 1, pct)}
                    min={0}
                    max={1}
                  />
                )}
                <div
                  style={i < splits.length
                    ? {
                      height: `${(splits[i] - (i > 0 ? splits[i - 1] : 0)) * 100}%`,
                      flexShrink: 0,
                      overflow: 'hidden',
                    }
                    : { flex: 1, minHeight: 0, overflow: 'hidden' }}
                >
                  {w}
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      <C2PoiViewer point={viewerPoint} mapName={mapName} onClose={() => setViewerId(null)} />

      <ConfirmSendModal
        open={confirm != null}
        navplanId={confirm?.navplanId}
        waypoints={confirm?.waypoints ?? []}
        robotStart={confirm?.robotStart ?? null}
        onCancel={() => setConfirm(null)}
        onConfirm={handleConfirmSend}
      />

      {/* The dashboard's own footer, for its e-stop. Its page tabs drive App.jsx's in-memory
          routing, which does not exist here, so every tab goes back to the dashboard. */}
      <Footer
        connected={connected}
        page={null}
        onNavigate={() => { window.location.href = '/' }}
      />
    </div>
  )
}
