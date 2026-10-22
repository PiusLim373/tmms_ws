import { yawToQuaternion } from '../navplan_tester/lib/quat'
import { degToRad } from './c2Coords'

export const PIN_TYPES = ['action', 'simple', 'home', 'map_switch']

export const PIN_META = {
  action: {
    label: 'Point of Interest',
    hint: 'Somewhere to investigate. The robot can be sent here, and can also pass through it.',
    colorVar: '--pin-poi',
  },
  simple: {
    label: 'Simple Waypoint',
    hint: 'A place the robot passes through on the way to a Point of Interest or Home.',
    colorVar: '--pin-simple',
  },
  home: {
    label: 'Home',
    hint: 'Where the robot returns to. Link it into the route like any other point. One per route.',
    colorVar: '--pin-home',
  },
  map_switch: {
    label: 'Map Switch',
    hint: 'Where the robot changes map. Pair it with a Map Switch at the same spot on another map of the route.',
    colorVar: '--pin-simple',
  },
}

export const POSE_TYPE = 'pose'
export const POSE_ID = 'relocalize_pose'

export const HEADING_TYPES = new Set(['action', 'home', 'map_switch', POSE_TYPE])

let seq = 0
const nextId = () => `pin_${Date.now().toString(36)}_${(seq++).toString(36)}`

export function makePin(type, world, existing) {
  const pin = {
    id: nextId(),
    type,
    order: existing.length,
    x: world.x,
    y: world.y,
    yaw: 0,
    headingSet: false,
    label: '',
    createdAt: new Date().toISOString(),
  }

  if (type === 'action') {
    pin.action = { description: '' }
  }
  // The robot relocalizes facing this way, so a switch always has a heading.
  if (type === 'map_switch') {
    pin.headingSet = true
    pin.headingDefault = true
    pin.pair = null
  }

  return pin
}

export const routeOrder = (pins) => pins.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

export const pinsOfType = (pins, type) => routeOrder(pins.filter((p) => p.type === type && p.source !== 'mapping'))

export function displayNumber(pin, pins = []) {
  const i = pinsOfType(pins, pin.type).findIndex((p) => p.id === pin.id)
  return i === -1 ? (pin.order ?? 0) + 1 : i + 1
}

export function defaultName(pin, pins = []) {
  const n = displayNumber(pin, pins)
  if (pin.type === 'home') return 'Home'
  if (pin.type === 'map_switch') return `Map switch ${n}`
  return pin.type === 'action' ? `POI${n}` : `Simple waypoint ${n}`
}

export function displayName(pin, pins = []) {
  return pin.label || defaultName(pin, pins)
}

export function effectiveYaw(pin) {
  if (!pin || !HEADING_TYPES.has(pin.type) || !pin.headingSet) return null
  return pin.yaw
}

export function reindexOrder(pins) {
  const orderById = new Map(routeOrder(pins).map((p, i) => [p.id, i]))
  return pins.map((p) => (p.order === orderById.get(p.id) ? p : { ...p, order: orderById.get(p.id) }))
}

// A point through a frame { turn, tx, ty } (c2Graph's applyFrame; kept here to avoid an import
// cycle).
function through(f, p) {
  const c = Math.cos(f.turn)
  const s = Math.sin(f.turn)
  return { x: c * p.x - s * p.y + f.tx, y: s * p.x + c * p.y + f.ty }
}

const WAYPOINT_TYPE = { action: 'poi', simple: 'simple', home: 'home' }

const poseOf = (p) => ({
  position: { x: p.x, y: p.y, z: 0 },
  orientation: yawToQuaternion(effectiveYaw(p) ?? 0),
})

// How far map `to` is turned from map `from` (radians), read from the ↻ angles: two maps
// turned to look alike on screen differ by the difference of their angles. `rotations` is in
// degrees. c2Graph's mapTurner prefers the turn worked out from linked switch pins.
export const rotationTurn = (rotations = {}) => (from, to) => degToRad(rotations[to]) - degToRad(rotations[from])

// A linked switch pair shares one heading: yaw on map `from` is this yaw on map `to`.
// `turnOf(from, to)` is how far `to` is turned from `from` (mapTurner, or rotationTurn).
export function pairedYaw(yaw, from, to, turnOf) {
  return yaw + turnOf(from, to)
}

// Where the robot really is on the next map, from where it really stopped on this one. `from`
// is its pose {map, x, y, yaw} on the old map; the crossing is the switch pair in `stops` it
// stopped at. The pose keeps its offset from the switch, turned by the pair's turn, so a robot
// that stopped 20 cm short or 10° off is placed 20 cm short and 10° off on the new map too.
// With `frameOf` (matched walls, c2Graph mapFramer) the pose goes straight through the frame.
export function carryAcross(from, stops, turnOf = rotationTurn(), frameOf = () => null) {
  let best = null
  for (let k = 0; k + 1 < stops.length; k++) {
    const a = stops[k]
    const b = stops[k + 1]
    if (a.type !== 'map_switch' || b.type !== 'map_switch' || a.map === b.map || a.map !== from.map) continue
    const d = Math.hypot(a.x - from.x, a.y - from.y)
    if (!best || d < best.d) best = { a, b, d }
  }
  if (!best) return null
  const frame = frameOf(best.a.map, best.b.map)
  if (frame) return { map: best.b.map, ...through(frame, from), yaw: from.yaw + frame.turn }
  const turn = turnOf(best.a.map, best.b.map)
  const c = Math.cos(turn)
  const s = Math.sin(turn)
  const dx = from.x - best.a.x
  const dy = from.y - best.a.y
  return { map: best.b.map, x: best.b.x + dx * c - dy * s, y: best.b.y + dx * s + dy * c, yaw: from.yaw + turn }
}

// Planned stops (each carrying its map) as tmms_msgs/Waypoint. Two switches in a row on
// different maps are a pair crossing over: they become one map_switch waypoint, the second
// giving new_map_name / new_map_pose. A switch the route only passes by goes as simple.
// The relocalize heading on the new map is worked out from the switch the robot stops at, so a
// stale heading stored on the other side can never be sent.
// With `frameOf` (matched walls) the relocalize pose is the stop carried through the frame,
// rather than the partner pin as placed by eye.
export function stopsToWaypoints(stops, turnOf = rotationTurn(), frameOf = () => null) {
  const out = []
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]
    const next = stops[i + 1]
    const base = { id: out.length + 1, name: s.name ?? '', map_name: s.map, pose: poseOf(s) }
    if (s.type === 'map_switch' && next?.type === 'map_switch' && next.map !== s.map) {
      const frame = frameOf(s.map, next.map)
      const yaw = frame ? (effectiveYaw(s) ?? 0) + frame.turn : pairedYaw(effectiveYaw(s) ?? 0, s.map, next.map, turnOf)
      const at = frame ? through(frame, s) : next
      out.push({ ...base, type: 'map_switch', new_map_name: next.map, new_map_pose: poseOf({ ...next, ...at, yaw, headingSet: true }) })
      i++
    } else {
      out.push({ ...base, type: WAYPOINT_TYPE[s.type] ?? 'simple' })
    }
  }
  return out
}

// Points marked while mapping, from a map's yaml. Their ids carry the map, because two maps
// can each have a poi 1 and a graph now spans several maps.
export function mapPointsOf(entry) {
  return (entry?.pois ?? [])
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      id: `poi_${p.id}@${entry.name}`,
      type: 'action',
      source: 'mapping',
      map: entry.name,
      x: p.x,
      y: p.y,
      yaw: ((Number(p.yaw) || 0) * Math.PI) / 180,
      headingSet: Number.isFinite(p.yaw),
      label: p.name || `POI_${p.id}`,
      poi: { description: p.description ?? '', snapshots: p.snapshots ?? [], timestamp: p.timestamp ?? '' },
    }))
}

// The graph's pins plus any mapping point of its maps it does not have yet, except those
// deleted from this route (`hidden`). Same array back when nothing is missing.
export function withMapPoints(pins, entries, hidden = []) {
  const have = new Set([...pins.map((p) => p.id), ...hidden])
  const missing = entries.flatMap(mapPointsOf).filter((p) => !have.has(p.id))
  return missing.length ? [...missing, ...pins] : pins
}

// A graph saved before graphs spanned maps had one `map` and pins without one. It becomes a
// one-map graph; its old cross-graph switch pairs cannot carry over and come back unlinked.
export function normalizeGraph(g) {
  if (Array.isArray(g.maps)) return g
  const map = g.map ?? ''
  const rename = (id) => (/^poi_\d+$/.test(id) ? `${id}@${map}` : id)
  return {
    ...g,
    maps: map ? [map] : [],
    pins: (g.pins ?? []).map((p) => ({
      ...p,
      id: rename(p.id),
      map,
      ...(p.type === 'map_switch' && { pair: null }),
    })),
    links: (g.links ?? []).map((k) => k.split('|').map(rename).join('|')),
  }
}
