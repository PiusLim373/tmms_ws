import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTopicActivity } from '../hooks/useTopicActivity'
import { useC2GraphStore, useRoutePhotos } from '../hooks/useC2GraphStore'
import { takeRoutePhotos, withRoutePhotos } from '../lib/c2Store'
import { useC2Maps, useMapViews } from '../hooks/useC2Maps'
import { ResizeHandle } from './ui/ResizeHandle'
import { ZoomControls, ScaleBar, CoordReadout } from './ui/C2MapControls'
import { C2PinGlyph } from './ui/C2PinGlyph'
import { C2MapCanvas } from './widgets/C2MapCanvas'
import { C2PoiHoverCard, C2PoiViewer } from './widgets/C2PoiPhotos'
import { CameraWidget } from './widgets/CameraWidget'
import { WarningModal } from './ui/WarningModal'
import { QuadrupedWidget } from './widgets/QuadrupedWidget'
import { Z1ArmWidget } from './widgets/Z1ArmWidget'
import { centreOn, degToRad, fitView, quaternionToYaw, worldToPixel, worldToScreen } from '../lib/c2Coords'
import {
  PIN_META, POSE_ID, POSE_TYPE, carryAcross, displayName, displayNumber, stopsToWaypoints, withMapPoints,
} from '../lib/c2Pins'
import { clearanceAt, linksFromKeys, mapTurner, partnerOf, planRoute } from '../lib/c2Graph'
import { drawGraphLayer } from '../lib/c2GraphDraw'
import { subscribeNavPlan } from '../lib/c2NavPath'
import { cancelNavGoal, setQuadrupedPaused, subscribe } from '../services/rosbridge'
import { nextNavplanId, relocalize, sendNavplan, subscribeLaserScan } from '../navplan_tester/lib/navplanRos'
import { MapOverlay } from '../navplan_tester/MapOverlay'
import { RobotCard } from '../navplan_tester/RobotCard'
import { ConfirmSendModal } from '../navplan_tester/ConfirmSendModal'
import '../navplan_tester/tester.css'

// Runs saved graphs; nothing is edited here (that is the Path Editor). Down the left, the
// steps in order: pick a graph, get the robot ready, pick a destination, send, watch it run.

const NONE = []
const ZOOM_STEP = 1.4
const BLANK_VIEW = { scale: 1, x: 0, y: 0 }
const SWITCH_LINE = '#60A5FA'
const STATUS_TOPIC = '/quadruped_main_status'
const STATUS_TYPE = 'tmms_msgs/QuadrupedMainStatus'
const SCAN_TIMEOUT_MS = 2000
const PLAN_LOG_LENGTH = 20
const POI_HOVER_PX = 16
const HOVER_CARD_LINGER_MS = 250
const STOP_REACHED_M = 0.7
const LAST_GRAPH_KEY = 'tmms.c2.runGraph'
const CARD_MIN_KEY = 'tmms.c2.robotCardMin'
const NAV_TONE = {
  idle: 'var(--text-dim)', navigating: '#4ADE80', map_switching: '#60A5FA', paused: '#FBBF24',
  canceled: '#FBBF24', error: '#F87171', unlocalized: '#F87171', navigation_failed: '#F87171',
}
const FINAL_PLAN_STATES = new Set(['completed', 'cancelled', 'errored', 'rejected'])
// A map switch that does not converge is retried this many times, from the robot's own estimate.
const RECOVER_TRIES = 3
const RECOVER_RETRY_MS = 1200
// After a good relocalize, time for /quadruped_main_status (a 200 ms mirror) to show the robot
// free again, so navplan_processor does not refuse the resend as still busy.
const RECOVER_SETTLE_MS = 1500
// Not localized in any sense the operator must act on. `pending` is converging, not a fault.
const LOC_FAULTS = new Set(['not_started', 'failed', 'localization_lost'])
const DESTINATION_TYPES = new Set(['action', 'home'])
const NOT_STANDING = {
  damping: 'lying limp (damping)',
  lie_down: 'lying down',
  sit: 'sitting',
}
const TONE = { ok: '#4ADE80', warn: '#FBBF24', busy: '#60A5FA', bad: '#F87171' }
const PLAN_TONE = {
  accepted: 'busy', executing: 'busy', completed: 'ok', rejected: 'bad', cancelled: 'warn', errored: 'bad',
}
const btn = { fontSize: 11, padding: '7px 10px' }
const primaryBtn = { ...btn, borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }

// Two switches in a row on different maps: where the route changes map.
const crossesAt = (stops, k) => stops[k]?.type === 'map_switch'
  && ((stops[k + 1]?.type === 'map_switch' && stops[k + 1].map !== stops[k].map)
    || (stops[k - 1]?.type === 'map_switch' && stops[k - 1].map !== stops[k].map))

// What is left of a route after the map switch the robot was crossing: the stops after its
// arrival switch on the new map. The crossing is the switch nearest where the robot stopped
// (`from`, its pose on the old map), else the first one into the map it is on now.
function restAfterSwitch(stops, from, nowMap) {
  let best = -1
  let bestD = Infinity
  for (let k = 0; k + 1 < stops.length; k++) {
    const a = stops[k]
    const b = stops[k + 1]
    if (a.type !== 'map_switch' || b.type !== 'map_switch' || a.map === b.map) continue
    if (from && a.map === from.map) {
      const d = Math.hypot(a.x - from.x, a.y - from.y)
      if (d < bestD) { best = k; bestD = d }
    } else if (!from && best < 0 && b.map === nowMap) {
      best = k
    }
  }
  return best < 0 ? [] : stops.slice(best + 2)
}

// The robot centred, at twice the zoom that fits the whole map, turned as the map is.
function robotView(info, size, position, rot) {
  const scale = Math.min(40, fitView(info, size, 0.94, rot).scale * 2)
  const g = worldToPixel(position.x, position.y, info)
  return centreOn({ scale, x: 0, y: 0, rot }, g.x, g.y, size)
}

// The tester's step badge: simple and home pins get no name chip, so a route stop shows its
// number here instead.
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

// One numbered step of the guide. `state` is done, active or waiting.
function Step({ n, title, state, summary, children }) {
  const color = state === 'done' ? TONE.ok : state === 'active' ? 'var(--accent-bright)' : 'var(--text-dim)'
  return (
    <div
      style={{
        border: `1px solid ${state === 'active' ? 'var(--accent-bright)' : 'var(--border)'}`,
        borderRadius: 6, opacity: state === 'waiting' ? 0.55 : 1,
        background: state === 'active' ? 'color-mix(in srgb, var(--accent-bright) 7%, transparent)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
        <span
          className="val-mono"
          style={{
            width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
            border: `1.5px solid ${color}`, color: state === 'done' ? '#0B0710' : color,
            background: state === 'done' ? TONE.ok : 'transparent',
          }}
        >
          {state === 'done' ? '✓' : n}
        </span>
        <span className="val-mono" style={{ fontSize: 12, letterSpacing: '0.06em', color: 'var(--text-h)' }}>{title}</span>
        {summary && (
          <span className="val-mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summary}
          </span>
        )}
      </div>
      {children && (
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
      )}
    </div>
  )
}

function Check({ ok, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.45, color: ok ? 'var(--text)' : TONE.warn }}>
      <span style={{ width: 14, flexShrink: 0, color: ok ? TONE.ok : TONE.warn }}>{ok ? '✓' : '✕'}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  )
}

const Note = ({ children, color }) => (
  <div style={{ fontSize: 11, lineHeight: 1.5, color: color ?? 'var(--text-dim)' }}>{children}</div>
)

// heldKeys and isPaused come from App, as for the dashboard's teleop: the keyboard is read
// once for the whole app, and the paused flag is the app-wide one the teleop gate relies on.
export function C2Page({ heldKeys, isPaused }) {
  // -- graph ---------------------------------------------------------------
  const { graphs, status: storeStatus } = useC2GraphStore()
  const [graphId, setGraphId] = useState(() => {
    try { return localStorage.getItem(LAST_GRAPH_KEY) } catch { return null }
  })
  const [choosing, setChoosing] = useState(false)
  const graph = graphs.find((g) => g.id === graphId) ?? null
  const graphMaps = graph?.maps ?? NONE
  const { byName, images, error: mapError, gridFor } = useC2Maps(graphMaps)

  const pins = useMemo(() => (graph
    ? withMapPoints(graph.pins, graphMaps.map((n) => byName.get(n)).filter(Boolean), graph.hiddenPois ?? [])
    : NONE), [graph, graphMaps, byName])
  // Names and numbers count over the whole graph, every map, so each map shows the same ones.
  // Photos C2 took of this route's own POIs ride along as `poi`, as mapping POIs carry theirs.
  const { photos, reload: reloadPhotos } = useRoutePhotos(graph?.id ?? null)
  const named = useMemo(() => withRoutePhotos(
    pins.map((p) => ({ ...p, name: displayName(p, pins), number: displayNumber(p, pins) })),
    photos, graph?.id,
  ), [pins, photos, graph?.id])
  const links = graph?.links ?? NONE

  const pickGraph = useCallback((id) => {
    setGraphId(id)
    setChoosing(false)
    try { localStorage.setItem(LAST_GRAPH_KEY, id) } catch {}
  }, [])

  // -- robot ---------------------------------------------------------------
  const { active: statusLive, lastMsg: status } = useTopicActivity(STATUS_TOPIC, STATUS_TYPE, 1500)
  const robot = useMemo(() => {
    if (!status) return null
    const p = status.pose?.position
    return {
      position: p ? { x: p.x, y: p.y } : null,
      yaw: quaternionToYaw(status.pose?.orientation),
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
  const robotInGraph = Boolean(robotMap && graphMaps.includes(robotMap))
  const navState = status?.navigation_state ?? ''
  const locStatus = status?.localization_status ?? ''

  // -- which maps are shown ------------------------------------------------
  // One map at a time (following the robot by default), or every map of the graph side by
  // side, as in the Path Editor.
  const [viewMap, setViewMap] = useState(null)
  // All maps side by side is where C2 opens; a map tab or a tile's header shows one alone.
  const [allMaps, setAllMaps] = useState(true)
  const [follow, setFollow] = useState(true)
  const shownMap = graphMaps.includes(viewMap) ? viewMap : (robotInGraph ? robotMap : graphMaps[0] ?? null)
  // Following: the shown map changes with the robot's, e.g. across a map switch.
  useEffect(() => {
    if (follow && robotInGraph) setViewMap(robotMap)
  }, [follow, robotInGraph, robotMap])
  const showMap = useCallback((m) => {
    setAllMaps(false)
    setViewMap(m)
    if (m !== robotMap) setFollow(false)
  }, [robotMap])
  const tiles = useMemo(() => (allMaps ? graphMaps : shownMap ? [shownMap] : NONE), [allMaps, graphMaps, shownMap])
  const info = shownMap ? byName.get(shownMap) ?? null : null
  const robotOnThisMap = Boolean(robotMap && shownMap === robotMap)
  // How the Path Editor turned each map on screen; display only.
  const rotOf = useCallback((m) => degToRad(graph?.rotations?.[m]), [graph])

  // Fitted once, then kept where the user left it (useMapViews), shared with the Path Editor.
  const { views, setViews, sizes, viewSetter, sizeSetter } = useMapViews(graph?.id ?? null, tiles, byName, images, rotOf)
  const [hover, setHover] = useState(null)
  const centerOnRobot = useRef(false)

  useEffect(() => {
    if (!centerOnRobot.current || !robot?.position || !robotMap || !tiles.includes(robotMap)) return
    const mi = byName.get(robotMap)
    const size = sizes[robotMap]
    if (mi && size?.width && images.get(robotMap) && views[robotMap]) {
      centerOnRobot.current = false
      setViews((v) => ({ ...v, [robotMap]: robotView(mi, size, robot.position, rotOf(robotMap)) }))
    }
  }, [tiles, byName, images, sizes, rotOf, robot, robotMap, views, setViews])

  const zoomBy = useCallback((m, factor) => {
    const { width = 0, height = 0 } = sizes[m] ?? {}
    viewSetter(m)((v) => {
      const next = Math.min(40, Math.max(0.05, v.scale * factor))
      if (next === v.scale) return v
      return { ...v, scale: next, x: width / 2 - ((width / 2 - v.x) / v.scale) * next, y: height / 2 - ((height / 2 - v.y) / v.scale) * next }
    })
  }, [sizes, viewSetter])
  const toScreenOn = useCallback((m, p) => worldToScreen(p.x, p.y, byName.get(m), views[m] ?? BLANK_VIEW), [byName, views])

  // -- relocalize ----------------------------------------------------------
  const [reloc, setReloc] = useState('idle')
  const [posePin, setPosePin] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const finish = useCallback((ok, message) => { setBusy(false); setResult({ ok, message }) }, [])

  const cancelReloc = useCallback(() => { setReloc('idle'); setPosePin(null) }, [])
  const startReloc = useCallback(() => { setPosePin(null); setReloc('placing') }, [])

  function handleSendReloc() {
    if (!posePin) return
    setReloc('sending'); setBusy(true); setResult(null)
    relocalize({ mapName: posePin.map, x: posePin.x, y: posePin.y, yaw: posePin.yaw ?? 0 },
      (r) => {
        finish(r.success, r.message)
        if (r.success) {
          cancelReloc()
          setFollow(true)
          // Relocalized by hand after a failed map switch: carry on with the same route.
          setRecovery((rc) => (rc && rc.phase !== 'resend' && rc.phase !== 'relocalizing'
            ? { ...rc, phase: 'resend', message: 'Relocalized by hand. Continuing the same route…' }
            : rc))
        } else setReloc('placed')
      },
      (e) => { finish(false, String(e)); setReloc('placed') })
  }

  // -- destination and plan ------------------------------------------------
  const [targetId, setTargetId] = useState(null)
  useEffect(() => { setTargetId(null) }, [graphId])
  const target = targetId ? named.find((p) => p.id === targetId) ?? null : null
  const destinations = useMemo(() => named.filter((p) => DESTINATION_TYPES.has(p.type)), [named])

  const rx = robotMap && robot?.position ? Math.round(robot.position.x * 20) / 20 : null
  const ry = robotMap && robot?.position ? Math.round(robot.position.y * 20) / 20 : null
  const robotAt = useMemo(() => (rx == null ? null : { map: robotMap, x: rx, y: ry }), [robotMap, rx, ry])

  const notStanding = statusLive ? NOT_STANDING[robot?.mode] : null
  const ready = statusLive && robotInGraph && locStatus === 'localized' && !notStanding && !robot?.paused

  const destReason = useMemo(() => {
    if (!target) return 'Pick a destination: a Point of Interest or Home.'
    if (!DESTINATION_TYPES.has(target.type)) {
      return `${target.name} is a ${PIN_META[target.type].label}: the robot only passes through those. Pick a Point of Interest or Home.`
    }
    const g = gridFor(target.map)
    if (!g) return `Still loading ${target.map}.`
    if (clearanceAt(target, g.grid, g.info) === 0) {
      return `${target.name} is on a wall or in unmapped space. Move it in the Path Editor.`
    }
    if (!robotAt) return 'The robot is not localized on any map. Relocalize it first.'
    if (target.map === robotAt.map && Math.hypot(robotAt.x - target.x, robotAt.y - target.y) < 0.5) {
      return `The robot is already at ${target.name}.`
    }
    return null
  }, [target, gridFor, robotAt])

  const plan = useMemo(() => (destReason ? null : planRoute({
    pins, links, robot: robotAt, targetId: target.id, gridFor,
  })), [destReason, pins, links, robotAt, target, gridFor])

  const directPlan = useMemo(() => {
    if (destReason) return null
    if (target.map === robotAt.map) {
      return { ok: true, stops: [target], robotLeg: null, legs: [], lengthM: Math.hypot(target.x - robotAt.x, target.y - robotAt.y) }
    }
    // Across maps the robot still has to stop at each map switch; only those and the
    // destination are sent, and it plans its own way between them.
    if (!plan?.ok) return null
    return {
      ok: true,
      stops: plan.stops.filter((s, k, all) => k === all.length - 1 || crossesAt(all, k)),
      robotLeg: null,
      legs: [],
      lengthM: plan.lengthM,
    }
  }, [destReason, target, robotAt, plan])

  const toBlocker = destReason ?? (directPlan ? null : plan?.reason ?? null)
  const goBlocker = destReason ?? (plan && !plan.ok ? plan.reason : null)

  const [routeMode, setRouteMode] = useState(null)
  useEffect(() => { setRouteMode(null) }, [targetId, graphId])
  const activePlan = routeMode === 'to' ? directPlan : routeMode === 'through' && plan?.ok ? plan : null

  // -- running -------------------------------------------------------------
  const [walking, setWalking] = useState(null)
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
    for (let k = walking.stops.length - 1; k >= reached; k--) {
      if (walking.stops[k].map !== robotMap) continue
      if (Math.hypot(walking.stops[k].x - pos.x, walking.stops[k].y - pos.y) < STOP_REACHED_M) { reached = k + 1; break }
    }
    if (reached !== walking.reached) setWalking((w) => (w ? { ...w, reached } : w))
  }, [robot?.position?.x, robot?.position?.y, robotMap, walking]) // eslint-disable-line react-hooks/exhaustive-deps

  const [planLog, setPlanLog] = useState([])
  useEffect(() => subscribe('/curr_navplan', 'tmms_msgs/NavigationPlan', (m) => {
    setPlanLog((prev) => [
      ...prev.slice(-(PLAN_LOG_LENGTH - 1)),
      { id: m.navplan_id, status: m.status, at: new Date().toLocaleTimeString() },
    ])
  }), [])
  // -- automatic map-switch recovery ---------------------------------------
  // A map switch whose relocalize does not converge ends the route, with the robot stopped
  // on the new map. Rather than leave that to the operator, C2 relocalizes again from the
  // robot's own estimate (AMCL usually lands close) and, once localized, sends the rest of
  // the route to the same destination. `recovery.phase`: start -> relocalizing -> resend,
  // back to start on a failed try, failed after RECOVER_TRIES.
  const [recovery, setRecovery] = useState(null)
  const sawSwitch = useRef(false)
  // The robot's pose while it drives, frozen when a map switch starts: where it really stopped
  // on the old map, which recovery carries across to the new one (carryAcross).
  const navPose = useRef(null)
  const switchFrom = useRef(null)
  useEffect(() => {
    if (!walking) return
    if (navState === 'navigating') {
      switchFrom.current = null
      if (robotMap && robot?.position && Number.isFinite(robot.yaw)) {
        navPose.current = { map: robotMap, x: robot.position.x, y: robot.position.y, yaw: robot.yaw }
      }
    } else if (navState === 'map_switching') {
      sawSwitch.current = true
      if (!switchFrom.current) switchFrom.current = navPose.current
    }
  }, [walking, navState, robot, robotMap])

  useEffect(() => {
    if (!walking) return
    const last = planLog.findLast?.((e) => e.id === walking.id)
    const st = robot?.navplanId === walking.id ? robot.navplanStatus : null
    if ((last && FINAL_PLAN_STATES.has(last.status)) || FINAL_PLAN_STATES.has(st)) {
      const final = last?.status ?? st
      const switchFailed = final === 'errored' && sawSwitch.current
      sawSwitch.current = false
      setWalking(null)
      if (switchFailed) {
        setResult({ ok: false, message: `Map switch did not localize. Recovering automatically…` })
        const carried = switchFrom.current ? carryAcross(switchFrom.current, walking.stops, mapTurner(pins, graph?.rotations)) : null
        // What is left of the route the operator sent: everything after the switch it was
        // crossing. Recovery sends exactly this once localized, never a new plan.
        const rest = restAfterSwitch(walking.stops, switchFrom.current, robotMap)
        const restLegs = walking.legs.filter((l) => rest.includes(l[0]) && rest.includes(l[1]))
        setRecovery({
          targetId: walking.targetId, mode: walking.mode, name: walking.name, tries: 0, phase: 'start',
          message: '', carried, rest, restLegs, photoPinId: walking.photoPinId ?? null,
        })
      } else {
        setResult({ ok: final === 'completed', message: `Route ${walking.id}: ${final}` })
        if (final === 'completed' && walking.photoPinId) snapPhotos(walking.photoPinId, walking.name)
      }
    }
  }, [planLog, robot?.navplanId, robot?.navplanStatus, walking]) // eslint-disable-line react-hooks/exhaustive-deps

  // Latest values for the timers below, which outlive the render that started them.
  const live = useRef({})
  live.current = { robot, robotAt, robotInGraph, locStatus, pins, links, named, gridFor, graph }

  useEffect(() => {
    if (recovery?.phase !== 'start') return undefined
    const t = setTimeout(() => {
      const { robot: r, robotAt: at, robotInGraph: inGraph, locStatus: ls } = live.current
      if (ls === 'pending') { setRecovery((rc) => rc && { ...rc }); return }
      // Odd tries: where the robot really stopped, carried across the switch pair. Even
      // tries (or without that): wherever AMCL thinks it is now.
      const useCarried = recovery.carried && recovery.tries % 2 === 0
      if (!useCarried && (!at || !inGraph || !Number.isFinite(r?.yaw))) {
        setRecovery((rc) => rc && { ...rc, phase: 'failed', message: 'The robot has no position on a map of this route.' })
        return
      }
      const pose = useCarried ? recovery.carried : { map: at.map, x: r.position.x, y: r.position.y, yaw: r.yaw }
      setRecovery((rc) => rc && { ...rc, phase: 'relocalizing', tries: rc.tries + 1 })
      relocalize({ mapName: pose.map, x: pose.x, y: pose.y, yaw: pose.yaw },
        (res) => setRecovery((rc) => {
          if (!rc) return rc
          if (res.success) return { ...rc, phase: 'resend', message: res.message }
          return rc.tries < RECOVER_TRIES
            ? { ...rc, phase: 'start', message: res.message }
            : { ...rc, phase: 'failed', message: res.message }
        }),
        (e) => setRecovery((rc) => rc && { ...rc, phase: 'failed', message: String(e) }))
    }, recovery.tries === 0 ? 300 : RECOVER_RETRY_MS)
    return () => clearTimeout(t)
  }, [recovery])

  useEffect(() => {
    if (recovery?.phase !== 'resend') return undefined
    const t = setTimeout(() => {
      const { robot: r, robotAt: at, pins: ps, graph: g } = live.current
      const fail = (message) => setRecovery((rc) => rc && { ...rc, phase: 'failed', message })
      const stops = recovery.rest ?? []
      const goal = stops[stops.length - 1]
      if (!goal || !at) { fail('Localized again, but there is no route left to continue.'); return }
      if (r?.paused || NOT_STANDING[r?.mode]) { fail('Localized again. The robot is paused or not standing, so the route was not continued: unpause or stand it, then press Try again.'); return }
      if (at.map !== stops[0].map) {
        fail(`The robot is on ${at.map}, but the rest of the route is on ${stops[0].map}. Relocalize it on ${stops[0].map}.`)
        return
      }
      if (goal.map === at.map && Math.hypot(goal.x - at.x, goal.y - at.y) < 0.5) {
        setRecovery(null)
        setResult({ ok: true, message: `Localized again; the robot is already at ${goal.name}.` })
        return
      }
      const navplanId = nextNavplanId()
      sendNavplan({ navplanId, waypoints: stopsToWaypoints(stops, mapTurner(ps, g?.rotations)) },
        (res) => {
          if (!res.success) { fail(`Localized again, but the robot refused the route: ${res.message}`); return }
          setRecovery(null)
          setResult({ ok: true, message: `Localized again; continuing the same route to ${goal.name} (${stops.length} stop${stops.length === 1 ? '' : 's'} left).` })
          setWalking({
            id: navplanId, targetId: recovery.targetId, name: recovery.name, mode: recovery.mode,
            stops, robotLeg: null, robotMap: at.map, legs: recovery.restLegs ?? [], reached: 0,
            photoPinId: recovery.photoPinId,
          })
          setFollow(true)
        },
        (e) => fail(String(e)))
    }, RECOVER_SETTLE_MS)
    return () => clearTimeout(t)
  }, [recovery])

  // Latched by tmms_yasmin, so a page opened mid-route still shows where it is.
  const [routeMsg, setRouteMsg] = useState(null)
  const [segmentMsg, setSegmentMsg] = useState(null)
  useEffect(() => subscribe('/curr_route', 'tmms_msgs/Route', setRouteMsg), [])
  useEffect(() => subscribe('/curr_route_segment', 'tmms_msgs/RouteSegment', setSegmentMsg), [])
  const segmentText = useMemo(() => {
    const first = segmentMsg?.waypoints?.[0]
    if (!first) return ''
    const all = routeMsg?.route_segments ?? []
    const k = all.findIndex((sg) => sg.waypoints?.[0]?.id === first.id
      && sg.waypoints[0].map_name === first.map_name && sg.waypoints.length === segmentMsg.waypoints.length)
    return `${k >= 0 ? `${k + 1}/${all.length} · ` : ''}${first.map_name} · ends ${segmentMsg.end_action}`
  }, [routeMsg, segmentMsg])

  // -- photos of the route's own POIs ----------------------------------------
  // Optional, taken the way mapping POI snapshots are (lib/c2Store): on arrival if ticked, or
  // by hand while the robot stands at the POI. A new set replaces the old one.
  const photoable = Boolean(target && target.type === 'action' && target.source !== 'mapping')
  const atTarget = Boolean(target && robotAt && target.map === robotAt.map
    && Math.hypot(target.x - robotAt.x, target.y - robotAt.y) < 1.0)
  // Optional: off for every new destination, the operator ticks it to take photos there.
  const [photoOnArrival, setPhotoOnArrival] = useState(false)
  useEffect(() => { setPhotoOnArrival(false) }, [targetId])
  const [photoJob, setPhotoJob] = useState(null)
  function snapPhotos(pinId, name) {
    if (!graph) return
    setPhotoJob({ pinId, phase: 'taking', message: `📷 Taking photos of ${name}…` })
    takeRoutePhotos(graph.id, pinId)
      .then((r) => {
        setPhotoJob({ pinId, phase: 'done', message: `📷 ${r.snapshots.length} photo${r.snapshots.length === 1 ? '' : 's'} of ${name} saved.` })
        reloadPhotos()
      })
      .catch((e) => setPhotoJob({ pinId, phase: 'failed', message: `📷 Photos of ${name} failed: ${e.message}` }))
  }

  // -- send ----------------------------------------------------------------
  const [confirm, setConfirm] = useState(null)
  function reviewRoute() {
    if (!ready || !activePlan) return
    const navplanId = nextNavplanId()
    setConfirm({
      navplanId,
      waypoints: stopsToWaypoints(activePlan.stops, mapTurner(pins, graph?.rotations)),
      sent: {
        id: navplanId, targetId: target?.id, name: target?.name, mode: routeMode, stops: activePlan.stops,
        robotLeg: activePlan.robotLeg, robotMap, legs: activePlan.legs, reached: 0,
      },
    })
  }
  function confirmSend() {
    if (!confirm) return
    const { navplanId, waypoints } = confirm
    // Ticked in the review window, so read at send time.
    const sent = { ...confirm.sent, photoPinId: photoable && photoOnArrival ? target.id : null }
    setConfirm(null)
    setRouteMode(null)
    setBusy(true); setResult(null)
    sendNavplan({ navplanId, waypoints },
      (r) => { finish(r.success, r.message); if (r.success) { setWalking(sent); setFollow(true) } },
      (e) => finish(false, String(e)))
  }

  // Unpausing stands the robot up, so it asks first, in the dashboard's own warning dialog.
  const [askUnpause, setAskUnpause] = useState(false)
  function handlePause() {
    if (robot?.paused) { setAskUnpause(true); return }
    setPaused(true)
  }
  function setPaused(paused) {
    const unpausing = !paused
    setAskUnpause(false)
    setResult(null)
    setQuadrupedPaused(paused,
      (r) => setResult({ ok: r.success, message: r.message || (unpausing ? 'Unpaused.' : 'Paused.') }),
      (e) => setResult({ ok: false, message: String(e) }))
  }

  // /cancel_goal is a Trigger: it refuses during a map switch and when nothing is running.
  function handleCancelGoal() {
    setResult(null)
    setRecovery(null)
    cancelNavGoal(
      (r) => {
        const ok = r?.success !== false
        setResult({ ok, message: r?.message || 'Cancel requested.' })
        if (ok) setWalking(null)
      },
      (e) => setResult({ ok: false, message: String(e) }))
  }

  // -- lidar ---------------------------------------------------------------
  const [scan, setScan] = useState(null)
  const [scanLive, setScanLive] = useState(false)
  const lastScanAt = useRef(0)
  useEffect(() => {
    const unsub = subscribeLaserScan((m) => { lastScanAt.current = Date.now(); setScan(m) })
    const interval = setInterval(() => {
      const live = Date.now() - lastScanAt.current < SCAN_TIMEOUT_MS
      setScanLive((prev) => (prev !== live ? live : prev))
    }, 200)
    return () => { unsub(); clearInterval(interval) }
  }, [])
  const lidarHint = !robotInGraph ? null
    : !scanLive ? 'no /rslidar_scan'
      : !robot?.position ? 'no robot position' : null

  // -- canvas, one per map -------------------------------------------------
  const pinsByMap = useMemo(() => {
    const out = new Map(graphMaps.map((m) => [m, []]))
    for (const p of named) {
      out.get(p.map)?.push(p.type === 'map_switch' && !partnerOf(pins, p) ? { ...p, unpaired: true } : p)
    }
    return out
  }, [named, pins, graphMaps])
  const linksByMap = useMemo(() => new Map(graphMaps.map((m) => {
    const g = gridFor(m)
    return [m, linksFromKeys(pinsByMap.get(m) ?? NONE, links, g?.grid ?? null, g?.info ?? byName.get(m))]
  })), [graphMaps, pinsByMap, links, gridFor, byName])

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-bright').trim() || '#7C3AED'
  const drawUnderFor = (m) => (ctx, toScreen) => {
    const onMap = (leg) => leg[0]?.map === m
    const robotHere = robotMap === m
    drawGraphLayer(ctx, toScreen, {
      points: pinsByMap.get(m) ?? NONE,
      links: linksByMap.get(m) ?? NONE,
      selectedKey: null,
      pending: null,
      plan: activePlan
        ? { robotLeg: robotHere ? activePlan.robotLeg : null, legs: activePlan.legs.filter(onMap) }
        : walking
          ? walking.mode === 'to'
            ? { robotLeg: null, legs: robotHere && navPath?.length > 1 ? [navPath] : [], dashed: true }
            : (() => {
              const legs = walking.legs.filter(onMap)
              return {
                robotLeg: walking.reached > 0 || walking.robotMap !== m ? null : walking.robotLeg,
                legs,
                doneFlags: legs.map((l) => walking.stops.indexOf(l[1]) < walking.reached),
              }
            })()
          : null,
      accent,
    })
    const route = activePlan?.stops ?? walking?.stops ?? []
    route.forEach((p, i) => {
      if (p.map === m && (p.type === 'simple' || p.type === 'home')) drawStepBadge(ctx, toScreen(p.x, p.y), `#${i + 1}`)
    })
  }

  // The robot is placed on whichever map was clicked.
  const handlePlace = (m) => (type, world) => {
    if (type !== POSE_TYPE) return
    setPosePin({ id: POSE_ID, type: POSE_TYPE, map: m, x: world.x, y: world.y, yaw: 0, headingSet: false, label: '' })
    setReloc('placed')
  }

  // Clicking a destination picks it; anything else just shows its name.
  const handleSelect = useCallback((id) => {
    if (!id || id === POSE_ID) return
    const p = named.find((q) => q.id === id)
    if (p && DESTINATION_TYPES.has(p.type) && !walking) setTargetId(id)
  }, [named, walking])

  // -- switch pairs drawn across the grid ----------------------------------
  const gridRef = useRef(null)
  const bodyRefs = useRef(new Map())
  const [bodyRects, setBodyRects] = useState({})
  useLayoutEffect(() => {
    const host = gridRef.current
    if (!host) return
    const base = host.getBoundingClientRect()
    const next = {}
    for (const m of tiles) {
      const el = bodyRefs.current.get(m)
      if (!el) continue
      const r = el.getBoundingClientRect()
      next[m] = { x: r.left - base.left, y: r.top - base.top }
    }
    setBodyRects((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }, [tiles, sizes])
  const pairLines = useMemo(() => {
    if (!allMaps) return NONE
    const out = []
    for (const p of pins) {
      const o = partnerOf(pins, p)
      if (!o || p.id > o.id) continue
      const ra = bodyRects[p.map]
      const rb = bodyRects[o.map]
      if (!ra || !rb || !byName.get(p.map) || !byName.get(o.map)) continue
      const a = toScreenOn(p.map, p)
      const b = toScreenOn(o.map, o)
      out.push({ key: p.id, x1: ra.x + a.x, y1: ra.y + a.y, x2: rb.x + b.x, y2: rb.y + b.y })
    }
    return out
  }, [allMaps, pins, bodyRects, byName, toScreenOn])

  // -- POI photos ------------------------------------------------------------
  const [viewerId, setViewerId] = useState(null)
  const hoveredMapPoint = useMemo(() => {
    if (!hover || viewerId || !byName.get(hover.map)) return null
    const h = toScreenOn(hover.map, hover)
    return (pinsByMap.get(hover.map) ?? NONE).find((p) => p.poi
      && Math.hypot(toScreenOn(hover.map, p).x - h.x, toScreenOn(hover.map, p).y - h.y) <= POI_HOVER_PX) ?? null
  }, [hover, viewerId, byName, pinsByMap, toScreenOn])
  const [cardId, setCardId] = useState(null)
  const onCardRef = useRef(false)
  useEffect(() => {
    if (hoveredMapPoint) { setCardId(hoveredMapPoint.id); return undefined }
    if (viewerId) { setCardId(null); return undefined }
    const t = setTimeout(() => { if (!onCardRef.current) setCardId(null) }, HOVER_CARD_LINGER_MS)
    return () => clearTimeout(t)
  }, [hoveredMapPoint, viewerId])
  const cardPoint = named.find((p) => p.id === cardId && p.poi) ?? null
  const viewerPoint = named.find((p) => p.id === viewerId && p.poi) ?? null

  // -- keyboard --------------------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (askUnpause) { setAskUnpause(false); return }
      if (confirm) { setConfirm(null); return }
      if (reloc === 'placing' || reloc === 'placed') { cancelReloc(); return }
      setRouteMode(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, reloc, cancelReloc, askUnpause])

  // -- robot card --------------------------------------------------------------
  const locFault = statusLive && (navState === 'unlocalized' || LOC_FAULTS.has(locStatus))
  const relocBlocked = tiles.length === 0 || busy || locStatus === 'pending'
  const robotMapKnown = Boolean(robotMap && byName.has(robotMap) && robotInGraph)
  const cancelOff = busy || (navState !== 'navigating' && navState !== 'map_switching')
  function locateRobot() {
    if (!robotMapKnown) return
    setFollow(true)
    centerOnRobot.current = Boolean(robot?.position)
    if (!allMaps) setViewMap(robotMap)
    setSizes((sz) => ({ ...sz }))
  }

  // -- cameras: a column the map's edge resizes, split between the two feeds ---
  const pageRef = useRef(null)
  const camColRef = useRef(null)
  const [camsOpen, setCamsOpen] = useState(true)
  // The robot card on the map folds down to one line; remembered per browser.
  const [cardMin, setCardMin] = useState(() => {
    try { return localStorage.getItem(CARD_MIN_KEY) === '1' } catch { return false }
  })
  const toggleCard = useCallback(() => setCardMin((v) => {
    try { localStorage.setItem(CARD_MIN_KEY, v ? '0' : '1') } catch {}
    return !v
  }), [])
  const [camW, setCamW] = useState(340)
  // The right-hand column: the two cameras, then teleop (the dashboard's QuadrupedWidget).
  // Each can be hidden; splits[i] is the bottom edge of section i as a fraction of the column.
  const [teleOpen, setTeleOpen] = useState(true)
  const sideSections = [camsOpen && 'topdown', camsOpen && 'wrist', teleOpen && 'teleop'].filter(Boolean)
  const [sideSplits, setSideSplits] = useState({})
  const splitsFor = (names) => sideSplits[names.join('|')] ?? (() => {
    const weight = { topdown: 1, wrist: 1, teleop: 1.6 }
    const total = names.reduce((t, n) => t + weight[n], 0)
    let at = 0
    return names.slice(0, -1).map((n) => (at += weight[n] / total))
  })()
  const resizeSide = (i, pct) => setSideSplits((all) => {
    const key = sideSections.join('|')
    const sp = [...splitsFor(sideSections)]
    const lo = (i > 0 ? sp[i - 1] : 0) + 0.1
    const hi = (i < sp.length - 1 ? sp[i + 1] : 1) - 0.1
    sp[i] = Math.min(hi, Math.max(lo, pct))
    return { ...all, [key]: sp }
  })
  const resizeCams = useCallback((pct) => {
    const width = pageRef.current?.getBoundingClientRect().width
    if (width) setCamW(Math.round(width * (1 - pct)))
  }, [])

  // -- steps -------------------------------------------------------------------
  const running = Boolean(walking) || Boolean(recovery) || navState === 'navigating' || navState === 'map_switching'
  const stepState = (n) => {
    const done = [Boolean(graph), ready, !destReason, running]
    if (n <= 4 && done[n - 1]) return 'done'
    const firstOpen = done.findIndex((d) => !d) + 1 || 5
    return n === firstOpen || (n === 5 && running) ? 'active' : n < firstOpen ? 'done' : 'waiting'
  }
  const sortedGraphs = graphs.slice().sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  const stops = activePlan?.stops ?? walking?.stops ?? NONE

  return (
    <div ref={pageRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      <C2PoiViewer point={viewerPoint} mapName={viewerPoint?.map} onClose={() => setViewerId(null)} />
      <WarningModal
        open={askUnpause}
        heading="UNPAUSE"
        title="Robot will stand up"
        body="It goes into balance stand and navigation takes control. Manual teleop stops. Keep the area around the robot clear."
        onConfirm={() => setPaused(false)}
        onCancel={() => setAskUnpause(false)}
      />
      <ConfirmSendModal
        open={Boolean(confirm)}
        navplanId={confirm?.navplanId}
        waypoints={confirm?.waypoints ?? []}
        robotStart={robotAt ? { x: robotAt.x, y: robotAt.y, yaw: robot?.yaw } : null}
        onConfirm={confirmSend}
        onCancel={() => setConfirm(null)}
        extra={photoable && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-h)', cursor: 'pointer' }}>
            <input type="checkbox" checked={photoOnArrival} onChange={(e) => setPhotoOnArrival(e.target.checked)} />
            📷 Take photos when it gets to {target.name}
          </label>
        )}
      />

      {/* ---- the guide ---- */}
      <div className="panel flex flex-col" style={{ width: 360, flexShrink: 0, overflow: 'hidden' }}>
        <div className="panel-header">
          <span>C2 — MISSION</span>
          <span className="val-mono" style={{ fontSize: 10, color: statusLive ? TONE.ok : 'var(--text-dim)' }}>
            {statusLive ? '● ROBOT LIVE' : '○ NO ROBOT DATA'}
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>

          <Step n={1} title="ROUTE" state={stepState(1)} summary={graph && !choosing ? graph.name : null}>
            {graph && !choosing ? (
              <>
                <Note>
                  {graphMaps.length} map{graphMaps.length === 1 ? '' : 's'}: {graphMaps.join(', ')} ·{' '}
                  {destinations.length} destination{destinations.length === 1 ? '' : 's'}
                </Note>
                <button className="btn-icon" style={{ ...btn, alignSelf: 'flex-start' }} disabled={running} onClick={() => setChoosing(true)}>
                  Change route
                </button>
              </>
            ) : (
              <>
                <Note>Load a route made in the Path Editor tab.</Note>
                {storeStatus === 'offline' && <Note color={TONE.bad}>Route storage is not reachable.</Note>}
                {sortedGraphs.length === 0 && storeStatus !== 'loading' && (
                  <Note color={TONE.warn}>No routes yet. Make one in the ✏️ Path Editor tab first.</Note>
                )}
                {sortedGraphs.map((g) => (
                  <button
                    key={g.id}
                    className="btn-icon"
                    onClick={() => pickGraph(g.id)}
                    style={{
                      textAlign: 'left', padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 2,
                      ...(g.id === graphId && { borderColor: 'var(--accent-bright)' }),
                    }}
                  >
                    <span className="val-mono" style={{ fontSize: 12, color: 'var(--text-h)' }}>{g.name}</span>
                    <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                      {g.maps.join(', ') || 'no maps'}
                      {robotMap && g.maps.includes(robotMap) && <span style={{ color: TONE.ok }}> · robot is on {robotMap}</span>}
                    </span>
                  </button>
                ))}
                {graph && <button className="btn-icon" style={btn} onClick={() => setChoosing(false)}>Keep {graph.name}</button>}
              </>
            )}
          </Step>

          <Step n={2} title="ROBOT READY" state={stepState(2)} summary={ready ? `on ${robotMap}` : null}>
            <Check ok={statusLive}>{statusLive ? 'Connected' : 'No status from the robot'}</Check>
            <Check ok={robotInGraph && locStatus === 'localized'}>
              {!robotMap ? 'Not localized on any map'
                : !robotInGraph ? `Localized on ${robotMap}, which is not in this route`
                  : locStatus === 'localized' ? `Localized on ${robotMap}`
                    : `Localization: ${locStatus || 'unknown'}`}
            </Check>
            {statusLive && !(robotInGraph && locStatus === 'localized') && reloc === 'idle' && (
              <>
                <Note>Press Relocalize, then click where the robot really is, on the map it is on.</Note>
                <button className="btn-icon" style={primaryBtn} disabled={relocBlocked} onClick={startReloc}>
                  ⌖ Relocalize
                </button>
              </>
            )}
            {reloc !== 'idle' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 4, border: '1px solid var(--robot-marker, #22D3EE)' }}>
                <Note color="var(--text-h)">
                  {reloc === 'placing' ? `Click where the robot is${allMaps ? ', on its map' : ` on ${shownMap}`}.`
                    : reloc === 'sending' ? 'Relocalizing…'
                      : 'Drag the ring to the way it faces, then send.'}
                </Note>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-icon" style={{ ...btn, flex: 1 }} disabled={reloc === 'sending'} onClick={cancelReloc}>Cancel</button>
                  <button className="btn-icon" style={{ ...primaryBtn, flex: 2 }} disabled={!posePin || busy} onClick={handleSendReloc}>
                    {reloc === 'sending' ? <><Spinner />Relocalizing…</> : 'Send pose ▶'}
                  </button>
                </div>
              </div>
            )}
            <Check ok={statusLive && !notStanding}>
              {notStanding ? `The robot is ${notStanding}. Stand it up (Dashboard → WALK, or the remote).` : 'Standing'}
            </Check>
            <Check ok={statusLive && !robot?.paused}>
              {robot?.paused ? 'Paused: routes will not move it' : 'Not paused'}
            </Check>
            {statusLive && robot?.paused && (
              <button className="btn-icon" style={{ ...btn, alignSelf: 'flex-start', borderColor: TONE.warn, color: TONE.warn }} onClick={handlePause}>
                ▶ Unpause
              </button>
            )}
          </Step>

          <Step n={3} title="DESTINATION" state={stepState(3)} summary={target && !destReason ? target.name : null}>
            <Note>Click a Point of Interest or Home on the map, or pick one here. Hover a mapped POI for its photos.</Note>
            <div>
              {graphMaps.map((m) => {
                const here = destinations.filter((p) => p.map === m)
                if (!here.length) return null
                return (
                  <Fragment key={m}>
                    <div className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, padding: '2px 4px', borderBottom: '1px solid var(--border)' }}>
                      {m}{m === robotMap ? ' · robot here' : ''}
                    </div>
                    {here.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => { if (!walking) { setTargetId(p.id); if (!allMaps) showMap(p.map) } }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderRadius: 4,
                          cursor: walking ? 'default' : 'pointer', fontSize: 12,
                          background: p.id === targetId ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
                        }}
                      >
                        <C2PinGlyph type={p.type} size={13} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-h)' }}>{p.name}</span>
                        {p.poi?.snapshots?.length > 0 && (
                          <button
                            className="btn-icon"
                            style={{ fontSize: 10, padding: '1px 6px' }}
                            onClick={(e) => { e.stopPropagation(); setViewerId(p.id) }}
                            title="Photos taken while mapping"
                          >
                            📷 {p.poi.snapshots.length}
                          </button>
                        )}
                      </div>
                    ))}
                  </Fragment>
                )
              })}
              {destinations.length === 0 && <Note color={TONE.warn}>This route has no Points of Interest or Home. Add some in the Path Editor.</Note>}
            </div>
            {target && destReason && <Note color={TONE.warn}>{destReason}</Note>}

          </Step>

          <Step n={4} title="SEND" state={stepState(4)} summary={running ? 'sent' : null}>

            {activePlan ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 4, border: '1px solid var(--accent-bright)' }}>
                <div className="val-mono" style={{ fontSize: 11, color: 'var(--text-h)' }}>
                  {routeMode === 'to' ? 'Go to' : 'Go through links to'} {target?.name}
                </div>
                <Note>
                  {activePlan.stops.length} stop{activePlan.stops.length === 1 ? '' : 's'}
                  {' · '}{[...new Set(activePlan.stops.map((p) => p.map))].join(' → ')}
                  {' · '}~{activePlan.lengthM.toFixed(1)} m
                  {routeMode === 'to' ? '. The robot plans its own way between them.' : '. Shown in purple on the map.'}
                </Note>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-icon" style={{ ...btn, flex: 1 }} onClick={() => setRouteMode(null)}>Back</button>
                  <button className="btn-icon" style={{ ...primaryBtn, flex: 2 }} disabled={busy || !ready} onClick={reviewRoute}>
                    Review &amp; send ▶
                  </button>
                </div>
                {!ready && <Note color={TONE.warn}>Finish step 2 first.</Note>}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn-icon"
                    style={{ ...primaryBtn, flex: 1 }}
                    disabled={Boolean(toBlocker) || busy || running}
                    onClick={() => setRouteMode('to')}
                    title={toBlocker ?? 'Send only the destination (and any map switches); the robot plans its own way'}
                  >
                    ▶ Go to
                  </button>
                  <button
                    className="btn-icon"
                    style={{ ...primaryBtn, flex: 1 }}
                    disabled={Boolean(goBlocker) || !plan || busy || running}
                    onClick={() => setRouteMode('through')}
                    title={goBlocker ?? "Follow the route's links, shortest way (Dijkstra)"}
                  >
                    ▶ Go through links
                  </button>
                </div>
                <Note>Go to: the robot finds its own way. Go through links: it follows your route's links, shortest way.</Note>
                {!destReason && goBlocker && <Note color={TONE.warn}>Go through links: {goBlocker}</Note>}
              </>
            )}
          </Step>

          <Step n={5} title="RUNNING" state={stepState(5)} summary={segmentText || null}>

            {recovery && (
              <div
                style={{
                  display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 4,
                  border: `1px solid ${recovery.phase === 'failed' ? TONE.bad : TONE.busy}`,
                }}
              >
                <div className="val-mono" style={{ fontSize: 11, color: recovery.phase === 'failed' ? TONE.bad : TONE.busy }}>
                  {recovery.phase === 'failed'
                    ? `Map switch recovery stopped (${recovery.tries}/${RECOVER_TRIES} tries)`
                    : recovery.phase === 'resend'
                      ? <><Spinner />Localized again. Continuing the same route to {recovery.name}…</>
                      : <><Spinner />Map switch didn't localize. Retrying {Math.max(1, recovery.tries)}/{RECOVER_TRIES}…</>}
                </div>
                {recovery.message && <Note>{recovery.message}</Note>}
                {recovery.phase === 'failed' ? (
                  <>
                    <Note>Relocalize by hand (step ② or the robot card: click where the robot really is). The same route then carries on by itself.</Note>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-icon" style={{ ...btn, flex: 1 }} onClick={() => setRecovery(null)}>Dismiss</button>
                      <button className="btn-icon" style={{ ...primaryBtn, flex: 1 }} onClick={() => setRecovery((rc) => rc && { ...rc, tries: 0, phase: 'start', message: '' })}>
                        Try again
                      </button>
                    </div>
                  </>
                ) : (
                  <button className="btn-icon" style={{ ...btn, alignSelf: 'flex-start' }} onClick={() => setRecovery(null)}>Stop recovering</button>
                )}
              </div>
            )}
            {walking ? (
              <div className="val-mono" style={{ fontSize: 11, color: 'var(--text-h)' }}>
                Walking to {walking.name} · {walking.reached} of {walking.stops.length} stops
              </div>
            ) : running ? <Note>A route is running.</Note> : null}
            {navState === 'map_switching' && (
              <Note color={TONE.busy}><Spinner />Switching map: loading the next map and relocalizing. Cancel waits until this ends.</Note>
            )}
            {walking?.mode === 'to' && (
              <Note>{navPath?.length ? "The dotted purple line is the robot's own planned path." : 'Waiting for the robot to send its planned path…'}</Note>
            )}
            {stops.length > 0 && (
              <div>
                {stops.map((p, i) => {
                  const done = walking && !activePlan && i < walking.reached
                  return (
                    <Fragment key={`${p.id}:${i}`}>
                      {(i === 0 || stops[i - 1].map !== p.map) && (
                        <div className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, padding: '2px 4px', borderBottom: '1px solid var(--border)' }}>
                          {p.map}{p.map === robotMap ? ' · robot here' : ''}
                        </div>
                      )}
                      <div className="val-mono" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 4px', opacity: done ? 0.45 : 1 }}>
                        <span style={{ width: 18, textAlign: 'right' }}>{i + 1}.</span>
                        <C2PinGlyph type={p.type} size={12} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      </div>
                    </Fragment>
                  )
                })}
              </div>
            )}
            {running && (
              <button
                className="btn-icon"
                style={{ ...btn, borderColor: '#DC2626', color: '#DC2626' }}
                disabled={cancelOff}
                onClick={handleCancelGoal}
              >
                ✕ Cancel route
              </button>
            )}
            {result && (
              <Note color={result.ok ? TONE.ok : TONE.bad}>{result.ok ? '✓ ' : '✕ '}{result.message}</Note>
            )}
            <details>
              <summary className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', cursor: 'pointer' }}>
                Route log ({planLog.length})
              </summary>
              {planLog.slice().reverse().map((e, i) => (
                <div key={i} className="val-mono" style={{ fontSize: 10, color: 'var(--text)' }}>
                  {e.at} · {e.id} → <span style={{ color: TONE[PLAN_TONE[e.status]] }}>{e.status}</span>
                </div>
              ))}
            </details>
          </Step>

        </div>
      </div>

      {/* ---- the map(s) ---- */}
      <div className="panel flex flex-col" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {graphMaps.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Load a route to see its maps.</span>}
          {graphMaps.length > 1 && (
            <button
              className="btn-icon"
              onClick={() => setAllMaps(true)}
              style={{
                fontSize: 11, padding: '4px 10px',
                ...(allMaps && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)', background: 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' }),
              }}
              title="Every map of the route side by side"
            >
              ▦ All maps ({graphMaps.length})
            </button>
          )}
          {graphMaps.map((m) => (
            <button
              key={m}
              className="btn-icon val-mono"
              onClick={() => showMap(m)}
              style={{
                fontSize: 11, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6,
                ...(!allMaps && m === shownMap && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)', background: 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' }),
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: m === robotMap ? TONE.ok : 'var(--border)' }} />
              {m}
              {stops.some((p) => p.map === m) && <span style={{ fontSize: 9, color: 'var(--accent-bright)' }}>ROUTE</span>}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {graphMaps.length > 1 && !allMaps && (
            <label className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              follow robot
            </label>
          )}
          {!camsOpen && (
            <button className="btn-icon" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setCamsOpen(true)}>📷 Cameras</button>
          )}
          {!teleOpen && (
            <button className="btn-icon" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setTeleOpen(true)}>🎮 Teleop</button>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          <div
            ref={gridRef}
            style={{
              position: 'absolute', inset: 0, display: 'grid', gap: allMaps ? 6 : 0, padding: allMaps ? 6 : 0,
              gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(tiles.length || 1))}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${Math.ceil((tiles.length || 1) / Math.ceil(Math.sqrt(tiles.length || 1)))}, minmax(0, 1fr))`,
            }}
          >
            {tiles.map((m) => {
              const mi = byName.get(m)
              const robotHere = robotMap === m ? robot : null
              const tilePins = pinsByMap.get(m) ?? NONE
              return (
                <div key={m} className={allMaps ? 'panel' : undefined} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
                  {allMaps && (
                    <div className="panel-header" onClick={() => showMap(m)} style={{ cursor: 'pointer' }} title={`Show ${m} on its own`}>
                      <span className="val-mono" style={{ textTransform: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: m === robotMap ? TONE.ok : 'var(--border)' }} />
                        {m}
                      </span>
                      <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        {m === robotMap ? 'robot here · ' : ''}⤢ expand
                      </span>
                    </div>
                  )}
                  <div
                    ref={(el) => { if (el) bodyRefs.current.set(m, el); else bodyRefs.current.delete(m) }}
                    style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
                  >
                    {mi ? (
                      <>
                        <C2MapCanvas
                          info={mi}
                          image={images.get(m) ?? null}
                          pins={posePin?.map === m ? [...tilePins, posePin] : tilePins}
                          selectedId={reloc !== 'idle' ? POSE_ID : targetId}
                          placingType={reloc === 'placing' ? POSE_TYPE : null}
                          editable={reloc === 'placed' && posePin?.map === m}
                          view={views[m] ?? BLANK_VIEW}
                          robot={robotHere}
                          onViewChange={viewSetter(m)}
                          onPlace={handlePlace(m)}
                          onSelect={handleSelect}
                          onMovePin={(id, world) => { if (id === POSE_ID) setPosePin((p) => (p ? { ...p, x: world.x, y: world.y } : p)) }}
                          onSetYaw={(id, yaw) => { if (id === POSE_ID) setPosePin((p) => (p ? { ...p, yaw: yaw ?? 0, headingSet: yaw != null } : p)) }}
                          onHover={(w) => setHover(w ? { ...w, map: m } : null)}
                          onSizeChange={sizeSetter(m)}
                          drawUnder={drawUnderFor(m)}
                        />
                        <MapOverlay
                          info={mi}
                          view={views[m] ?? BLANK_VIEW}
                          size={sizes[m] ?? { width: 0, height: 0 }}
                          robot={robotHere}
                          waypoints={[]}
                          scan={scanLive && robotHere ? scan : null}
                          ghost={null}
                        />
                        {cardPoint?.map === m && (
                          <C2PoiHoverCard
                            point={cardPoint}
                            at={toScreenOn(m, cardPoint)}
                            mapName={m}
                            bounds={sizes[m] ?? { width: 0, height: 0 }}
                          />
                        )}
                        {!images.get(m) && (
                          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12, pointerEvents: 'none' }}>
                            Loading {m}…
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', padding: 16 }}>
                        {m} is not in the robot's map store.
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {pairLines.length > 0 && (
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 3 }}>
              {pairLines.map((l) => (
                <g key={l.key}>
                  <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={SWITCH_LINE} strokeWidth="2" strokeDasharray="6 5" opacity="0.85" />
                  <circle cx={l.x1} cy={l.y1} r="4" fill={SWITCH_LINE} />
                  <circle cx={l.x2} cy={l.y2} r="4" fill={SWITCH_LINE} />
                </g>
              ))}
            </svg>
          )}

          {tiles.length > 0 && (
            <div style={{ position: 'absolute', top: allMaps ? 40 : 10, left: allMaps ? 16 : 10, zIndex: 4, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 'calc(100% - 20px)', pointerEvents: 'none' }}>
              <div
                className="val-mono"
                style={{
                  alignSelf: 'flex-start', padding: '4px 8px', borderRadius: 4, fontSize: 11,
                  background: 'var(--panel-bg)', border: '1px solid var(--border)',
                  color: reloc === 'idle' ? 'var(--text-dim)' : 'var(--robot-marker, #22D3EE)',
                }}
              >
                {reloc === 'placing' ? 'Click the robot’s position, on the map it is on'
                  : reloc === 'placed' ? `Drag the ring to set its heading · on ${posePin?.map}`
                    : reloc === 'sending' ? 'Relocalizing…'
                      : recovery && recovery.phase !== 'failed' ? 'Map switch did not localize: recovering automatically…'
                        : walking ? `Walking to ${walking.name}`
                        : 'Click a Point of Interest or Home to pick it'}
              </div>
              {/* Photos are a side thing: a chip here, not part of the steps. */}
              {((photoable && atTarget && !running) || photoJob) && (
                <div
                  className="val-mono"
                  style={{
                    alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
                    borderRadius: 4, fontSize: 11, background: 'var(--panel-bg)', border: '1px solid var(--border)',
                    pointerEvents: 'auto',
                    color: photoJob?.phase === 'failed' ? TONE.bad : photoJob?.phase === 'done' ? TONE.ok : 'var(--text-h)',
                  }}
                >
                  {photoJob ? <>{photoJob.phase === 'taking' && <Spinner />}{photoJob.message}</> : <span>At {target.name}</span>}
                  {photoable && atTarget && !running && photoJob?.phase !== 'taking' && (
                    <button
                      className="btn-icon"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={() => snapPhotos(target.id, target.name)}
                      title="A photo from each camera here; they replace any taken before"
                    >
                      📷 Take photos now
                    </button>
                  )}
                  {photoJob && photoJob.phase !== 'taking' && (
                    <button className="btn-icon" style={{ fontSize: 11, padding: '0 6px' }} onClick={() => setPhotoJob(null)} aria-label="Dismiss">✕</button>
                  )}
                </div>
              )}
              {lidarHint && (
                <div className="val-mono" style={{ alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 4, border: `1px solid ${TONE.warn}`, background: 'var(--panel-bg)', color: TONE.warn, fontSize: 11 }}>
                  ⚠ LIDAR · {lidarHint}
                </div>
              )}
              {!allMaps && robotMap && !robotOnThisMap && (
                <div className="val-mono" style={{ alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 4, border: `1px solid ${TONE.warn}`, background: 'var(--panel-bg)', color: TONE.warn, fontSize: 11 }}>
                  Robot is on {robotMap}{robotInGraph ? '' : ' (not in this route)'}
                </div>
              )}
            </div>
          )}
          {mapError && (
            <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 4, fontSize: 11, color: TONE.bad, background: 'var(--panel-bg)', padding: '4px 8px', borderRadius: 4 }}>{mapError}</div>
          )}

          {tiles.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13, pointerEvents: 'none' }}>
              Step 1: load a route.
            </div>
          )}

          <div style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 5 }}>
            {cardMin ? (
              <button
                className="npt-card val-mono"
                onClick={toggleCard}
                title="Show the robot card"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 11,
                  cursor: 'pointer', color: 'var(--text-h)', border: '1px solid var(--border)', borderRadius: 6,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusLive ? TONE.ok : 'var(--border)' }} />
                <span style={{ color: 'var(--text-dim)', letterSpacing: '0.08em' }}>ROBOT</span>
                <span style={{ fontWeight: 700, color: statusLive ? NAV_TONE[navState] ?? 'var(--text-h)' : 'var(--text-dim)' }}>
                  {statusLive ? (navState || 'unknown').replace(/_/g, ' ').toUpperCase() : 'NO DATA'}
                </span>
                {statusLive && robot?.position && (
                  <span style={{ color: 'var(--text-dim)' }}>
                    {robot.position.x.toFixed(2)}, {robot.position.y.toFixed(2)}
                  </span>
                )}
                <span style={{ color: 'var(--text-dim)' }}>▴</span>
              </button>
            ) : (
              <div style={{ position: 'relative' }}>
                <button
                  className="btn-icon"
                  onClick={toggleCard}
                  title="Minimise the robot card"
                  aria-label="Minimise the robot card"
                  style={{ position: 'absolute', top: -26, right: 0, fontSize: 11, padding: '1px 10px', background: 'var(--panel-bg)' }}
                >
                  ▾
                </button>
                <RobotCard
                  live={statusLive}
                  status={status}
                  robot={robot}
                  segmentText={segmentText}
                  isPaused={Boolean(robot?.paused)}
                  busy={busy}
                  cancelOff={cancelOff}
                  result={result}
                  onRobotMap={allMaps ? robotInGraph : robotOnThisMap}
                  robotMapKnown={robotMapKnown}
                  onLocate={locateRobot}
                  reloc={reloc}
                  posePin={posePin}
                  mapName={posePin?.map ?? (allMaps ? 'the map it is on' : shownMap)}
                  mapMismatch={Boolean(robotMap && posePin?.map && posePin.map !== robotMap)}
                  locFault={locFault}
                  relocBlocked={relocBlocked}
                  onRelocStart={startReloc}
                  onRelocCancel={cancelReloc}
                  onRelocSend={handleSendReloc}
                  onPause={handlePause}
                  onCancel={handleCancelGoal}
                />
              </div>
            )}
          </div>
          {!allMaps && info && (
            <>
              <div style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 4 }}>
                <ZoomControls
                  zoom={(views[shownMap] ?? BLANK_VIEW).scale}
                  onZoomIn={() => zoomBy(shownMap, ZOOM_STEP)}
                  onZoomOut={() => zoomBy(shownMap, 1 / ZOOM_STEP)}
                  onFit={() => viewSetter(shownMap)(fitView(info, sizes[shownMap] ?? { width: 0, height: 0 }, 0.94, rotOf(shownMap)))}
                />
              </div>
              <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'flex-end', gap: 16, pointerEvents: 'none', zIndex: 4 }}>
                <CoordReadout world={hover?.map === shownMap ? hover : null} />
                <ScaleBar scale={(views[shownMap] ?? BLANK_VIEW).scale} resolution={info.resolution} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- cameras and teleop: drag the edge to widen, the bars between to share ---- */}
      {sideSections.length > 0 && (
        <>
          <ResizeHandle direction="h" containerRef={pageRef} onResize={resizeCams} min={0.4} max={0.9} />
          <div ref={camColRef} style={{ width: camW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {sideSections.map((name, i) => {
              const sp = splitsFor(sideSections)
              const last = i === sideSections.length - 1
              const style = last
                ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
                : { height: `${(sp[i] - (i > 0 ? sp[i - 1] : 0)) * 100}%`, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
              const header = (label, onHide, title) => (
                <div className="panel-header">
                  <span>{label}</span>
                  <button className="btn-icon" style={{ fontSize: 11, padding: '0 8px' }} onClick={onHide} title={title}>✕</button>
                </div>
              )
              return (
                <Fragment key={name}>
                  {i > 0 && (
                    <ResizeHandle direction="v" containerRef={camColRef} onResize={(pct) => resizeSide(i - 1, pct)} min={0} max={1} />
                  )}
                  <div style={style}>
                    {name === 'topdown' && (
                      <>
                        {header('CAMERAS', () => setCamsOpen(false), 'Hide the cameras')}
                        <div style={{ flex: 1, minHeight: 0 }}>
                          <CameraWidget topicName="/topdown_cam/compressed" title="TOPDOWN" />
                        </div>
                      </>
                    )}
                    {name === 'wrist' && (
                      <div style={{ flex: 1, minHeight: 0 }}>
                        <CameraWidget topicName="/wrist_cam/compressed" title="WRIST CAM" />
                      </div>
                    )}
                    {name === 'teleop' && (
                      <>
                        {header('TELEOP', () => setTeleOpen(false), 'Hide teleop (robot and arm)')}
                        {/* One scroll for both: robot controls, then the arm under them. */}
                        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                          <QuadrupedWidget compact heldKeys={heldKeys} blocked={!isPaused} onPause={() => setPaused(true)} />
                          <Z1ArmWidget compact heldKeys={heldKeys} />
                        </div>
                      </>
                    )}
                  </div>
                </Fragment>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
