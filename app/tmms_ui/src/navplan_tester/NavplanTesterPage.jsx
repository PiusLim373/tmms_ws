import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTopicActivity } from '../hooks/useTopicActivity'
import { useRos } from '../hooks/useRos'
import { Header } from '../components/Header'
import { Footer } from '../components/Footer'
import { C2MapCanvas } from '../components/widgets/C2MapCanvas'
import { ZoomControls } from '../components/ui/C2MapControls'
import { ResizeHandle } from '../components/ui/ResizeHandle'
import {
  effectiveYaw, makePin, reindexOrder, routeOrder,
} from '../lib/c2Pins'
import { fitView, normaliseMapEntry, quaternionToYaw } from '../lib/c2Coords'
import {
  cancelNavGoal, setQuadrupedPaused, subscribe,
} from '../services/rosbridge'
import { ConfirmSendModal } from './ConfirmSendModal'
import { MapOverlay } from './MapOverlay'
import {
  nextNavplanId, relocalize, sendNavigationPlan, subscribeLaserScan,
} from './lib/navplanRos'
import { degFromYaw } from './lib/quat'

const STATUS_TOPIC = '/quadruped_main_status'
const STATUS_TYPE = 'tmms_msgs/QuadrupedMainStatus'
// A scan older than this is treated as lost: no longer drawn, and flagged on the map.
const SCAN_TIMEOUT_MS = 2000

// Smallest share of the widget column any one widget may be squeezed to -- about a header.
const MIN_SPAN = 0.06

// Waypoints are placed as 'action' pins because that is the C2 pin type that carries a
// heading; 'home' is reused for the single initial-pose marker. Nothing in lib/c2Pins is
// modified — this page only consumes it.
const WAYPOINT_TYPE = 'action'
const INITIAL_POSE_TYPE = 'home'

const TONE = {
  ok: '#4ADE80', warn: '#FBBF24', busy: '#60A5FA', bad: '#F87171', neutral: 'var(--text-dim)',
}
const NAV_STATE_TONE = {
  idle: 'neutral', navigating: 'busy', paused: 'warn', canceled: 'warn',
  error: 'bad', unlocalized: 'bad', navigation_failed: 'bad',
}
const LOC_TONE = {
  not_started: 'warn', pending: 'busy', localized: 'ok', failed: 'bad', localization_lost: 'bad',
}
// Mirrors NavigationPlan.msg's status enum.
const PLAN_TONE = {
  created: 'neutral', accepted: 'busy', executing: 'busy',
  completed: 'ok', rejected: 'bad', cancelled: 'warn', errored: 'bad',
}

function Row({ label, value, tone }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{label}</span>
      <span className="val-mono" style={{ fontSize: 11, color: tone ? TONE[tone] : 'var(--text-h)' }}>
        {value || '—'}
      </span>
    </div>
  )
}

// Same chrome as the C2 widgets: header with a status slot, then a body that scrolls on its own.
function Widget({ step, title, aside, children }) {
  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>{step} · {title}</span>
        {aside}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px' }}>
        {children}
      </div>
    </div>
  )
}

function Aside({ children, color }) {
  return (
    <span className="val-mono" style={{ fontSize: 10, color: color ?? 'var(--text-dim)' }}>
      {children}
    </span>
  )
}

function Spinner() {
  return (
    <span
      className="animate-spin"
      style={{
        display: 'inline-block', width: 10, height: 10, marginRight: 6, verticalAlign: '-1px',
        border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%',
      }}
    />
  )
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

  // The plan status topic is volatile and event-driven; quadruped_main_status carries the
  // same two fields continuously, so that is what the readout uses. This subscription is
  // only for the transition log.
  const [planLog, setPlanLog] = useState([])
  useEffect(() => subscribe('/curr_navplan', 'tmms_msgs/NavigationPlan', (m) => {
    setPlanLog((prev) => [...prev.slice(-9), `${m.navplan_id} → ${m.status}`])
  }), [])

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
  // (default_map) is hidden from /api/maps2d,
  // so it is never restored; there is nothing to plan on there anyway.
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

  useEffect(() => {
    if (!info || !image) return
    const key = `${mapName}:${info.width}x${info.height}`
    if (fittedFor.current === key || !sizeRef.current.width) return
    fittedFor.current = key
    setView(fitView(info, sizeRef.current))
  }, [info, mapName, image])

  const zoomBy = useCallback((f) => setView((v) => {
    const { width, height } = sizeRef.current
    const cx = width / 2
    const cy = height / 2
    const scale = Math.min(40, Math.max(0.05, v.scale * f))
    return { scale, x: cx - ((cx - v.x) / v.scale) * scale, y: cy - ((cy - v.y) / v.scale) * scale }
  }), [])

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
  // Same scheme as NavigationPage: boundaries as fractions of the container, not persisted.
  // splits[i] is the bottom edge of widget i; the last widget takes the rest.
  const pageRef = useRef(null)
  const colRef = useRef(null)
  const [mapPct, setMapPct] = useState(0.76)
  const [splits, setSplits] = useState([0.14, 0.27, 0.58, 0.85])

  const resizeSplit = useCallback((i, pct) => setSplits((s) => {
    const lo = (i > 0 ? s[i - 1] : 0) + MIN_SPAN
    const hi = (i < s.length - 1 ? s[i + 1] : 1) - MIN_SPAN
    const next = [...s]
    next[i] = Math.min(hi, Math.max(lo, pct))
    return next
  }), [])

  // -- pins ----------------------------------------------------------------
  // 'idle' -> 'placing' -> 'placed' -> (send | cancel) -> 'idle'. The initial-pose pin only
  // exists inside this flow, so it never clutters the canvas afterwards.
  const [reloc, setReloc] = useState('idle')
  const [pins, setPins] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [hoverWorld, setHoverWorld] = useState(null)

  // Waypoint placing is the resting state; relocalizing temporarily takes the cursor over.
  const placingType = reloc === 'idle' ? WAYPOINT_TYPE
    : reloc === 'placing' ? INITIAL_POSE_TYPE
      : null

  const addPin = useCallback((type, world) => {
    setPins((prev) => {
      // One initial-pose marker at a time; placing another replaces it.
      const base = type === INITIAL_POSE_TYPE
        ? prev.filter((p) => p.type !== INITIAL_POSE_TYPE)
        : prev
      const pin = makePin(type, world, base)
      if (type === INITIAL_POSE_TYPE) {
        // Select it so C2MapCanvas draws the rotate handle straight away — setting the
        // heading is the next step and should not need a second click to reach.
        setSelectedId(pin.id)
        setReloc('placed')
      }
      return reindexOrder([...base, pin])
    })
  }, [])

  const movePin = useCallback((id, world) => setPins((prev) => prev.map(
    (p) => (p.id === id ? { ...p, x: world.x, y: world.y } : p))), [])

  const setYaw = useCallback((id, yaw) => setPins((prev) => prev.map(
    (p) => (p.id === id ? { ...p, yaw, headingSet: true } : p))), [])

  const deletePin = useCallback((id) => {
    setPins((prev) => reindexOrder(prev.filter((p) => p.id !== id)))
    // Otherwise the list keeps highlighting, and the canvas keeps a handle for, a pin that
    // no longer exists.
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  const initialPin = pins.find((p) => p.type === INITIAL_POSE_TYPE) ?? null
  const waypoints = useMemo(
    () => routeOrder(pins.filter((p) => p.type === WAYPOINT_TYPE)), [pins])

  // -- actions -------------------------------------------------------------
  const finish = (ok, message) => { setBusy(false); setResult({ ok, message }) }

  const clearRelocPin = useCallback(() => {
    setPins((prev) => prev.filter((p) => p.type !== INITIAL_POSE_TYPE))
    setHoverWorld(null)
    setReloc('idle')
  }, [])

  // Browsing only -- nothing is sent to the robot. Waypoints and the pose pin are coordinates
  // on the map they were drawn on, so they go with it rather than reappearing on another.
  const selectMap = useCallback((name) => {
    setMapName(name)
    setPins([])
    setSelectedId(null)
    setHoverWorld(null)
    setReloc('idle')
  }, [])

  // C2MapCanvas does no key handling of its own -- on the C2 page, Delete and Escape belong
  // to C2Page. Reusing only the canvas left this page with neither, so they live here.
  useEffect(() => {
    // Text fields only. C2Page also skips a focused <select>, but the map picker here is one
    // and is often the last thing focused; a <select> never takes Delete/Backspace as input,
    // so guarding it would only swallow the keypress.
    const isTyping = (t) => Boolean(t) && (t.isContentEditable
      || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

    const onKey = (e) => {
      // The pin is in flight; removing it now would leave a failed reply with nothing to retry.
      if (isTyping(e.target) || reloc === 'sending') return

      if (e.key === 'Escape') {
        if (reloc !== 'idle') clearRelocPin()
        setSelectedId(null)
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        // The initial-pose pin belongs to the relocalize flow: removing it cancels the flow
        // rather than leaving it in 'placed' with nothing placed.
        if (selectedId === initialPin?.id) clearRelocPin()
        else deletePin(selectedId)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, initialPin, reloc, clearRelocPin, deletePin])

  // Sent with the viewed map, which need not be the robot's: relocalizing is how the robot is
  // moved onto it. The reply is the outcome, so the pin stays on failure to be nudged and resent.
  function handleSendRelocalize() {
    if (!initialPin || !mapName) return
    setReloc('sending'); setBusy(true); setResult(null)
    relocalize({ mapName, x: initialPin.x, y: initialPin.y, yaw: initialPin.yaw ?? 0 },
      (r) => {
        finish(r.success, r.message)
        if (r.success) clearRelocPin()
        else setReloc('placed')
      },
      (e) => { finish(false, String(e)); setReloc('placed') })
  }

  // The robot pose only means something on the map it is localized on. Shared by the overlay
  // (marker-relative scan, robot->wp1 link) and the confirm modal's reference row.
  const robotHere = robotMap && mapName === robotMap ? robot : null

  const [confirm, setConfirm] = useState(null)   // the plan awaiting confirmation

  function handleSend() {
    if (!waypoints.length || !mapName) return
    setConfirm({
      navplanId: nextNavplanId(),
      // The map the waypoints were drawn on, not the robot's. navplan_processor rejects the
      // plan when the robot is on another one -- tagging it with the robot's map instead would
      // pass that check and drive to coordinates from the wrong map.
      mapName,
      waypoints: waypoints.map((p) => ({ x: p.x, y: p.y, yaw: effectiveYaw(p) })),
      // Display only. sendNavigationPlan destructures just navplanId/mapName/waypoints, so
      // this can never reach the service. Snapshotted, not live: the modal shows what the
      // plan was built against.
      robotStart: robotHere
        ? { x: robotHere.position.x, y: robotHere.position.y, yaw: robotHere.yaw }
        : null,
    })
  }

  function handleConfirmSend() {
    const plan = confirm
    setConfirm(null)
    setBusy(true); setResult(null)
    sendNavigationPlan(plan,
      (r) => finish(r.success, r.message),
      (e) => finish(false, String(e)))
  }

  function handlePause() {
    const next = !isPaused
    setBusy(true); setResult(null)
    setQuadrupedPaused(next,
      (r) => finish(r.success, r.message),
      (e) => finish(false, String(e)))
  }

  function handleCancel() {
    setBusy(true); setResult(null)
    cancelNavGoal(
      () => finish(true, 'Cancel requested.'),
      (e) => finish(false, String(e)))
  }

  const mapMismatch = Boolean(mapName && robotMap && mapName !== robotMap)
  const onRobotMap = Boolean(mapName && mapName === robotMap)

  // The overlay has four independent preconditions and used to fail all of them silently,
  // which is a miserable thing to debug. Name whichever one is blocking.
  const scanHint = !info ? 'select a map to draw on'
    : !scanLive ? 'no /rslidar_scan received'
      : !robotMap ? 'robot has no map loaded'
        : mapName !== robotMap ? `robot is on “${robotMap}”, not this map`
          : !robot ? 'no robot pose on /quadruped_main_status'
            : null
  const scanOk = scanHint == null

  const widgets = [
    <Widget
      key="map"
      step="1"
      title="MAP"
      aside={<Aside>robot: {robotMap || '—'}</Aside>}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          title={onRobotMap ? 'The robot is on this map' : 'The robot is not on this map'}
          style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: onRobotMap ? TONE.ok : 'var(--border)',
          }}
        />
        <select
          className="val-mono"
          value={mapName ?? ''}
          onChange={(e) => selectMap(e.target.value || null)}
          disabled={busy}
          style={{
            flex: 1, minWidth: 0, fontSize: 11, padding: '4px 6px',
            background: 'var(--bg)', color: 'var(--text-h)',
            border: '1px solid var(--border)', borderRadius: 4,
          }}
        >
          <option value="">{maps === null ? 'loading…' : 'select a map…'}</option>
          {(maps ?? []).map((m) => (
            <option key={m.name} value={m.name}>
              {m.name === robotMap ? `● ${m.name}` : m.name}
            </option>
          ))}
        </select>
      </div>
      {mapMismatch && (
        <div style={{ fontSize: 10, color: TONE.warn, marginTop: 4 }}>
          Robot is on “{robotMap}”. Relocalize here to drive on this map.
        </div>
      )}
    </Widget>,

    <Widget
      key="reloc"
      step="2"
      title="RELOCALIZE"
      aside={<Aside color={TONE[LOC_TONE[locStatus]]}>{locStatus || '—'}</Aside>}
    >
      {reloc === 'idle' ? (
        <button
          className="btn-icon"
          style={{ width: '100%' }}
          // /relocalize refuses while any attempt runs, including one started from Lichtblick.
          disabled={!info || busy || locStatus === 'pending'}
          onClick={() => setReloc('placing')}
        >
          {locStatus === 'pending' ? 'Converging…' : 'Set initial pose'}
        </button>
      ) : (
        <>
          <div className="val-mono" style={{ fontSize: 11, marginBottom: 6 }}>
            {initialPin
              ? `${initialPin.x.toFixed(2)}, ${initialPin.y.toFixed(2)}`
                + `${initialPin.headingSet ? ` · ${degFromYaw(initialPin.yaw).toFixed(0)}°` : ' · heading not set'}`
              : 'Click the map to place the robot'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>
            on “{mapName}”{mapMismatch ? ' · loads it on the robot' : ''}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn-icon"
              style={{ flex: 1 }}
              disabled={reloc === 'sending'}
              onClick={clearRelocPin}
            >
              Cancel
            </button>
            <button
              className="btn-icon"
              style={{ flex: 2, borderColor: 'var(--accent-bright)' }}
              disabled={!initialPin || busy}
              onClick={handleSendRelocalize}
            >
              {reloc === 'sending' ? <><Spinner />Relocalizing…</> : 'Send pose ▶'}
            </button>
          </div>
        </>
      )}
    </Widget>,

    <Widget key="waypoints" step="3" title="WAYPOINTS" aside={<Aside>{waypoints.length}</Aside>}>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>
        Click the map in order. Drag a pin’s ring to set its heading — only the last
        one is enforced. Select a pin and press Delete to remove it, Esc to deselect.
      </div>

      {waypoints.map((p, i) => (
        <div
          key={p.id}
          onClick={() => setSelectedId(p.id)}
          className="val-mono"
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 11, padding: '3px 4px', cursor: 'pointer',
            borderLeft: `2px solid ${p.id === selectedId ? 'var(--accent-bright)' : 'transparent'}`,
            color: 'var(--text)',
          }}
        >
          <span>
            {i + 1}. {p.x.toFixed(2)}, {p.y.toFixed(2)}
            {effectiveYaw(p) != null && ` · ${degFromYaw(p.yaw).toFixed(0)}°`}
          </span>
          <button
            className="btn-icon"
            onClick={(e) => { e.stopPropagation(); deletePin(p.id) }}
          >
            ✕
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button
          className="btn-icon"
          style={{ flex: 1 }}
          disabled={!waypoints.length}
          onClick={() => setPins((prev) => prev.filter((p) => p.type !== WAYPOINT_TYPE))}
        >
          Clear
        </button>
        <button
          className="btn-icon"
          style={{ flex: 2, borderColor: 'var(--accent-bright)' }}
          disabled={!waypoints.length || !mapName || busy}
          onClick={handleSend}
        >
          Send navplan ▶
        </button>
      </div>
    </Widget>,

    <Widget
      key="robot"
      step="4"
      title="ROBOT"
      aside={(
        <Aside color={statusLive ? TONE.ok : undefined}>
          {statusLive ? '● LIVE' : '○ NO DATA'}
        </Aside>
      )}
    >
      <Row label="MAP" value={robotMap} />
      <Row label="LOCALIZATION" value={locStatus} tone={LOC_TONE[locStatus]} />
      <Row label="NAV STATE" value={navState} tone={NAV_STATE_TONE[navState]} />
      <Row
        label="NAVPLAN"
        value={status?.current_navplan_id ? String(status.current_navplan_id) : ''}
      />
      <Row
        label="PLAN STATUS"
        value={status?.current_navplan_status}
        tone={PLAN_TONE[status?.current_navplan_status]}
      />
      <div
        className="val-mono"
        style={{ fontSize: 10, marginTop: 6, color: scanOk ? TONE.ok : TONE.warn }}
      >
        lidar: {scanOk ? `${scan?.ranges?.length ?? 0} beams` : scanHint}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn-icon" style={{ flex: 1 }} disabled={busy} onClick={handlePause}>
          {isPaused ? '▶ Unpause' : '⏸ Pause'}
        </button>
        <button
          className="btn-icon"
          style={{ flex: 1 }}
          disabled={busy || navState !== 'navigating'}
          onClick={handleCancel}
        >
          ✕ Cancel
        </button>
      </div>

      {result && (
        <div style={{ fontSize: 10, marginTop: 8, color: result.ok ? TONE.ok : TONE.bad }}>
          {result.message}
        </div>
      )}
    </Widget>,

    <Widget key="log" step="5" title="NAVPLAN LOG" aside={<Aside>/curr_navplan</Aside>}>
      {planLog.length === 0
        ? <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>nothing yet</div>
        : planLog.map((line, i) => (
          <div key={i} className="val-mono" style={{ fontSize: 10, color: 'var(--text)' }}>
            {line}
          </div>
        ))}
    </Widget>,
  ]

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
          style={{ width: `${mapPct * 100}%`, flexShrink: 0, minWidth: 0, overflow: 'hidden' }}
        >
          {/* The header is the dashboard's, so this is what says which page you are on. */}
          <div className="panel-header">
            <span>NAVPLAN TESTER</span>
            <Aside>{mapName ?? 'no map'}</Aside>
          </div>

          <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
            <C2MapCanvas
              info={info}
              image={image}
              pins={pins}
              selectedId={selectedId}
              placingType={info ? placingType : null}
              editable={Boolean(info)}
              view={view}
              robot={robotHere}
              onViewChange={setView}
              onPlace={addPin}
              onSelect={setSelectedId}
              onMovePin={movePin}
              onSetYaw={setYaw}
              onRename={() => {}}
              // Only tracked while placing a pose: onHover fires on every pointer move, and
              // there is no reason to re-render the page at that rate the rest of the time.
              onHover={reloc === 'placing' ? setHoverWorld : undefined}
              onSizeChange={onSizeChange}
            />

            <MapOverlay
              info={info}
              view={view}
              size={size}
              robot={robotHere}
              waypoints={waypoints}
              scan={scanLive ? scan : null}
              ghost={reloc === 'placing' ? hoverWorld : null}
            />

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
                  className="val-mono"
                  style={{
                    position: 'absolute', top: 10, left: 10, display: 'flex', gap: 6,
                    alignItems: 'center', padding: '4px 8px', borderRadius: 4,
                    background: 'var(--panel-bg)', border: '1px solid var(--border)',
                    fontSize: 11,
                    color: reloc === 'idle' ? 'var(--text-dim)' : 'var(--pin-home, #F59E0B)',
                  }}
                >
                  {reloc === 'idle' && 'Click to add a waypoint'}
                  {reloc === 'placing' && 'Click the robot’s position'}
                  {reloc === 'placed' && 'Drag the ring to set its heading'}
                </div>

                {!scanOk && (
                  <div
                    className="val-mono"
                    style={{
                      position: 'absolute', top: 10, right: 10,
                      maxWidth: 'calc(100% - 240px)', padding: '4px 10px', borderRadius: 4,
                      border: `1px solid ${TONE.warn}`, background: 'var(--panel-bg)',
                      color: TONE.warn, fontSize: 11, pointerEvents: 'none', zIndex: 4,
                    }}
                  >
                    ⚠ LIDAR · {scanHint}
                  </div>
                )}
              </>
            )}

            {!info && (
              <div
                style={{
                  position: 'absolute', inset: 0, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-dim)', fontSize: 12,
                }}
              >
                Select a map to begin.
              </div>
            )}
          </div>
        </div>

        <ResizeHandle
          direction="h"
          containerRef={pageRef}
          onResize={setMapPct}
          min={0.4}
          max={0.85}
        />

        {/* Widgets, split by drag handles. resizeSplit does the clamping, so the handles'
            own min/max are left wide open. */}
        <div
          ref={colRef}
          style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
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

      <ConfirmSendModal
        open={confirm != null}
        navplanId={confirm?.navplanId}
        mapName={confirm?.mapName}
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
