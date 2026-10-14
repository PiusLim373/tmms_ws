// The tester's route: one row per pin, in route order, across any number of maps.
//
// A map switch is two map_switch rows on different maps, linked to each other and kept next
// to each other: the first is where the robot stops on its map, the second where it
// relocalizes on the next. They collapse into the single map_switch waypoint a navplan
// carries, with the second row as its new_map_name / new_map_pose.
import { yawToQuaternion } from './quat'

export const TYPES = ['simple', 'poi', 'home', 'map_switch']
export const TYPE_LABEL = {
  simple: 'Simple', poi: 'POI', home: 'Home', map_switch: 'Map switch',
}

const STORE_KEY = 'tmms.navplanTester.route'

let seq = 0
const nextId = () => `wp_${Date.now().toString(36)}_${(seq++).toString(36)}`

export function makeRow(map, world, extra = {}) {
  return {
    id: nextId(), map, type: 'simple', x: world.x, y: world.y, yaw: 0, headingSet: false,
    label: '', link: null, ...extra,
  }
}

// Added from a map.yaml POI: pose and type come from the file and stay as they are.
export const isLocked = (row) => row?.poiId != null

export const partnerOf = (rows, row) => (row?.link ? rows.find((r) => r.id === row.link) ?? null : null)

// The second row of a pair: a relocalize pose, not a stop of its own.
export function isArrival(rows, i) {
  const row = rows[i]
  return row?.type === 'map_switch' && row.link != null && i > 0 && rows[i - 1].id === row.link
}

// Same rule as C2's effectiveYaw: a simple waypoint has no heading.
const yawOf = (row) => (row.type !== 'simple' && row.headingSet ? row.yaw : 0)

export const updateRow = (rows, id, patch) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r))

export function unlink(rows, id) {
  const other = rows.find((r) => r.id === id)?.link
  if (!other) return rows
  return rows.map((r) => (r.id === id || r.id === other ? { ...r, link: null } : r))
}

// A map switch always has a heading: the robot relocalizes facing it. Until someone turns it,
// it is the default (map +X), flagged so linking can still replace it with the pair's.
const DEFAULT_HEADING = { yaw: 0, headingSet: true, headingDefault: true }

export function setType(rows, id, type) {
  const row = rows.find((r) => r.id === id)
  if (!row || isLocked(row) || row.type === type) return rows
  const patch = type === 'map_switch' && !row.headingSet ? { type, ...DEFAULT_HEADING } : { type }
  return updateRow(row.type === 'map_switch' ? unlink(rows, id) : rows, id, patch)
}

// Links two unlinked map switches on different maps and moves `secondId` to right after
// `firstId`, which makes `firstId` the side the robot drives to.
export function linkRows(rows, firstId, secondId) {
  const a = rows.find((r) => r.id === firstId)
  const b = rows.find((r) => r.id === secondId)
  const ok = a && b && a.map !== b.map && a.type === 'map_switch' && b.type === 'map_switch'
    && !a.link && !b.link
  if (!ok) return rows
  // Crops of one map share a frame, so a heading someone set on one side is the best guess
  // for the other, where that one is still unset or the default.
  const chosen = (r) => r.headingSet && !r.headingDefault
  const heading = (r, o) => (!chosen(r) && chosen(o)
    ? { yaw: o.yaw, headingSet: true, headingDefault: false }
    : {})
  const first = { ...a, link: b.id, ...heading(a, b) }
  const second = { ...b, link: a.id, ...heading(b, a) }
  const rest = rows.filter((r) => r.id !== secondId).map((r) => (r.id === firstId ? first : r))
  const at = rest.findIndex((r) => r.id === firstId)
  return [...rest.slice(0, at + 1), second, ...rest.slice(at + 1)]
}

// Reverses which side of a pair the robot drives to.
export function swapPair(rows, id) {
  const i = rows.findIndex((r) => r.id === id)
  const j = rows.findIndex((r) => r.id === rows[i]?.link)
  if (i < 0 || j < 0 || Math.abs(i - j) !== 1) return rows
  const next = [...rows]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

export const removeRow = (rows, id) => unlink(rows, id).filter((r) => r.id !== id)

// Map switches waiting for a pair, on any map but `exceptMap`. Steps are 1-based list numbers.
export function unlinkedSwitches(rows, exceptMap) {
  return rows
    .map((row, i) => ({ row, step: i + 1 }))
    .filter(({ row }) => row.type === 'map_switch' && !row.link && row.map !== exceptMap)
}

/**
 * Everything that stops the route being sent, as sentences naming list steps. Mirrors
 * navplan_processor's own checks, so a plan that passes here is not refused for its shape.
 */
export function validateRoute(rows, robotMap) {
  if (!rows.length) return ['Add at least one waypoint.']
  const problems = []

  rows.forEach((row, i) => {
    if (row.type !== 'map_switch') return
    const partner = partnerOf(rows, row)
    if (!partner) {
      problems.push(`#${i + 1} on ${row.map} is a map switch with no pair. Plot its pair on the `
        + 'next map and link them.')
      return
    }
    const j = rows.indexOf(partner)
    if (i < j && j !== i + 1) problems.push(`#${i + 1} and its pair #${j + 1} must be next to each other.`)
    if (!row.headingSet) {
      problems.push(isArrival(rows, i)
        ? `#${i + 1}: set the heading the robot relocalizes facing on ${row.map}.`
        : `#${i + 1}: set the heading the robot stops facing before switching map.`)
    }
  })

  if (robotMap && rows[0].map !== robotMap) {
    problems.push(`The route starts on ${rows[0].map} but the robot is on ${robotMap}. `
      + 'Relocalize it there first.')
  }

  // Only a map switch pair changes map. Reported once: every row after a break would repeat it.
  let cur = rows[0].map
  for (let i = 1; i < rows.length; i++) {
    if (isArrival(rows, i)) { cur = rows[i].map; continue }
    if (rows[i].map !== cur) {
      problems.push(`#${i + 1} is on ${rows[i].map} but the route is still on ${cur} there. `
        + 'Link a map switch pair before it.')
      break
    }
  }
  return problems
}

const poseOf = (row) => ({
  position: { x: row.x, y: row.y, z: 0 },
  orientation: yawToQuaternion(yawOf(row)),
})
const IDENTITY = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }

export const defaultName = (row, step) => `${TYPE_LABEL[row.type]} ${step}`

/**
 * tmms_msgs/Waypoint[] for the route. A pair becomes one map_switch waypoint carrying its
 * second row as new_map_name / new_map_pose; ids are list steps, so the backend's error
 * messages point at the same rows the list shows.
 */
export function buildWaypoints(rows) {
  const out = []
  rows.forEach((row, i) => {
    if (isArrival(rows, i)) return
    const partner = row.type === 'map_switch' ? partnerOf(rows, row) : null
    out.push({
      id: i + 1,
      name: row.label || defaultName(row, i + 1),
      map_name: row.map,
      type: row.type,
      pose: poseOf(row),
      new_map_name: partner ? partner.map : '',
      new_map_pose: partner ? poseOf(partner) : IDENTITY,
    })
  })
  return out
}

const validRow = (r) => r && typeof r.id === 'string' && typeof r.map === 'string'
  && TYPES.includes(r.type) && Number.isFinite(r.x) && Number.isFinite(r.y)

export function loadRows() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')
    const rows = Array.isArray(stored) ? stored.filter(validRow) : []
    // A pair half-lost to an older version or a hand edit is unlinked rather than dangling,
    // and a map switch saved before headings were required gets the default.
    const ids = new Set(rows.map((r) => r.id))
    return rows.map((r) => ({
      ...r,
      ...(r.link && !ids.has(r.link) && { link: null }),
      ...(r.type === 'map_switch' && !r.headingSet && DEFAULT_HEADING),
    }))
  } catch {
    return []
  }
}

export function saveRows(rows) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(rows)) } catch { /* private window */ }
}
