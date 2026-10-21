import { worldToPixel } from './c2Coords'
import { displayName, rotationTurn } from './c2Pins'

export const CLEARANCE_M = 0.35
const FREE_MIN = 217
const STEP_PX = 0.5
const CURVE_CELL_M = 0.05
export const MAX_CURVE_RATIO = 1.5
const CURVE_MARGIN_M = 1.5

export const linkKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export function buildClearanceGrid(image, info) {
  const { width, height } = info
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, width, height)
  const px = ctx.getImageData(0, 0, width, height).data

  const INF = 1e9
  const dist = new Float32Array(width * height)
  for (let i = 0, j = 0; i < dist.length; i++, j += 4) {
    dist[i] = px[j + 3] > 0 && px[j] >= FREE_MIN ? INF : 0
  }

  const D = Math.SQRT2
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : dist[y * width + x])

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (dist[i] === 0) continue
      dist[i] = Math.min(dist[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + D, at(x + 1, y - 1) + D)
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (dist[i] === 0) continue
      dist[i] = Math.min(dist[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + D, at(x - 1, y + 1) + D)
    }
  }
  return { width, height, dist }
}

export function clearanceAt(p, grid, info) {
  const q = worldToPixel(p.x, p.y, info)
  const x = Math.floor(q.x)
  const y = Math.floor(q.y)
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return 0
  return grid.dist[y * grid.width + x] * info.resolution
}

export function lineIsClear(a, b, grid, info, clearanceM = CLEARANCE_M) {
  const pa = worldToPixel(a.x, a.y, info)
  const pb = worldToPixel(b.x, b.y, info)
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y)
  const need = clearanceM / info.resolution
  const steps = Math.max(1, Math.ceil(len / STEP_PX))
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const x = Math.floor(pa.x + (pb.x - pa.x) * t)
    const y = Math.floor(pa.y + (pb.y - pa.y) * t)
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false
    const fromEnd = Math.min(t, 1 - t) * len
    if (grid.dist[y * grid.width + x] < Math.min(need, 1 + fromEnd)) return false
  }
  return true
}

function heapPush(h, item) {
  h.push(item)
  let i = h.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (h[p][0] <= h[i][0]) break
    ;[h[p], h[i]] = [h[i], h[p]]
    i = p
  }
}
function heapPop(h) {
  const top = h[0]
  const last = h.pop()
  if (h.length) {
    h[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < h.length && h[l][0] < h[m][0]) m = l
      if (r < h.length && h[r][0] < h[m][0]) m = r
      if (m === i) break
      ;[h[m], h[i]] = [h[i], h[m]]
      i = m
    }
  }
  return top
}

export function curvedPath(a, b, grid, info, {
  clearanceM = CLEARANCE_M, maxRatio = MAX_CURVE_RATIO, marginM = CURVE_MARGIN_M,
} = {}) {
  const straight = Math.hypot(b.x - a.x, b.y - a.y)
  const limit = straight * maxRatio
  const cell = CURVE_CELL_M
  const x0 = Math.min(a.x, b.x) - marginM
  const y0 = Math.min(a.y, b.y) - marginM
  const cols = Math.ceil((Math.max(a.x, b.x) + marginM - x0) / cell)
  const rows = Math.ceil((Math.max(a.y, b.y) + marginM - y0) / cell)
  const need = clearanceM / info.resolution
  const res = info.resolution

  const centre = (c, r) => ({ x: x0 + (c + 0.5) * cell, y: y0 + (r + 0.5) * cell })
  const walkable = (c, r) => {
    const w = centre(c, r)
    const q = worldToPixel(w.x, w.y, info)
    const px = Math.floor(q.x)
    const py = Math.floor(q.y)
    if (px < 0 || py < 0 || px >= grid.width || py >= grid.height) return false
    const fromEnd = Math.min(Math.hypot(w.x - a.x, w.y - a.y), Math.hypot(w.x - b.x, w.y - b.y)) / res
    return grid.dist[py * grid.width + px] >= Math.min(need, 1 + fromEnd)
  }

  const toCell = (p) => [Math.floor((p.x - x0) / cell), Math.floor((p.y - y0) / cell)]
  const [sc, sr] = toCell(a)
  const [gc, gr] = toCell(b)
  const idx = (c, r) => r * cols + c
  const g = new Float32Array(cols * rows).fill(Infinity)
  const parent = new Int32Array(cols * rows).fill(-1)
  const state = new Uint8Array(cols * rows)
  const h = (c, r) => {
    const dx = Math.abs(c - gc)
    const dy = Math.abs(r - gr)
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * cell
  }
  const open = []
  g[idx(sc, sr)] = 0
  heapPush(open, [h(sc, sr), idx(sc, sr)])
  const STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]]

  while (open.length) {
    const [f, i] = heapPop(open)
    if (state[i] === 3) continue
    if (f > limit) return null
    state[i] = 3
    const c = i % cols
    const r = (i - c) / cols
    if (c === gc && r === gr) {
      const cells = []
      for (let k = i; k !== -1; k = parent[k]) cells.push(k)
      cells.reverse()
      const path = [{ x: a.x, y: a.y }]
      for (let n = 3; n < cells.length - 1; n += 4) {
        const cc = cells[n] % cols
        path.push(centre(cc, (cells[n] - cc) / cols))
      }
      path.push({ x: b.x, y: b.y })
      return { len: Math.max(straight, g[i]), path }
    }
    for (const [dc, dr, k] of STEPS) {
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const j = idx(nc, nr)
      if (state[j] === 3 || state[j] === 2) continue
      if (state[j] === 0) state[j] = walkable(nc, nr) ? 1 : 2
      if (state[j] === 2) continue
      const ng = g[i] + k * cell
      if (ng < g[j]) {
        g[j] = ng
        parent[j] = i
        heapPush(open, [ng + h(nc, nr), j])
      }
    }
  }
  return null
}

export function wayBetween(a, b, grid, info, opts) {
  if (lineIsClear(a, b, grid, info)) {
    return { len: Math.hypot(b.x - a.x, b.y - a.y), path: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], curved: false }
  }
  const c = curvedPath(a, b, grid, info, opts)
  return c ? { ...c, curved: true } : null
}

export function linksFromKeys(points, keys, grid, info) {
  const byId = new Map(points.map((p) => [p.id, p]))
  const links = []
  for (const key of keys) {
    const [ida, idb] = key.split('|')
    const a = byId.get(ida)
    const b = byId.get(idb)
    if (!a || !b) continue
    links.push({
      key,
      a: ida,
      b: idb,
      len: Math.hypot(b.x - a.x, b.y - a.y),
      crossesWall: grid ? !lineIsClear(a, b, grid, info, info.resolution) : false,
    })
  }
  return links
}

const ROBOT_LEG = { maxRatio: 3, marginM: 3 }

// A pair counts only when both switches name each other, on different maps of the graph.
// One side alone (an undone link, a deleted partner) reads as unlinked.
export function partnerOf(pins, pin) {
  if (pin?.type !== 'map_switch' || !pin.pair) return null
  const p = pins.find((q) => q.id === pin.pair)
  return p?.type === 'map_switch' && p.pair === pin.id && p.map !== pin.map ? p : null
}

// Switch pairs closer together than this give too short a line to read a turn from.
export const MIN_PAIR_SPREAD_M = 1.0

// How map `to` is turned from map `from`, worked out from the switch pairs linked between
// them: the line from one switch to another has to point the same real way on both maps, so
// its direction on `to` minus its direction on `from` is the turn. Least squares over every
// pair, about their centres. null with fewer than two pairs, or pairs too close together.
// `mismatchM` is the worst difference between how far apart two switches are on one map and
// on the other: switches at the same spots are the same distance apart on both, so a big one
// means a switch is not at the same spot on both maps.
export function pinTurn(pins, from, to) {
  const pairs = []
  for (const p of pins) {
    if (p.map !== from) continue
    const o = partnerOf(pins, p)
    if (o?.map === to) pairs.push([p, o])
  }
  if (pairs.length < 2) return null
  const mean = (pts) => ({
    x: pts.reduce((t, q) => t + q.x, 0) / pts.length,
    y: pts.reduce((t, q) => t + q.y, 0) / pts.length,
  })
  const ca = mean(pairs.map(([a]) => a))
  const cb = mean(pairs.map(([, b]) => b))
  let dot = 0
  let cross = 0
  let spread = 0
  for (const [a, b] of pairs) {
    const ax = a.x - ca.x
    const ay = a.y - ca.y
    const bx = b.x - cb.x
    const by = b.y - cb.y
    dot += ax * bx + ay * by
    cross += ax * by - ay * bx
    spread = Math.max(spread, Math.hypot(ax, ay))
  }
  if (spread * 2 < MIN_PAIR_SPREAD_M) return null
  let worst = 0
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const da = Math.hypot(pairs[i][0].x - pairs[j][0].x, pairs[i][0].y - pairs[j][0].y)
      const db = Math.hypot(pairs[i][1].x - pairs[j][1].x, pairs[i][1].y - pairs[j][1].y)
      worst = Math.max(worst, Math.abs(da - db))
    }
  }
  return { turn: Math.atan2(cross, dot), pairs: pairs.length, mismatchM: worst }
}

// turnOf(from, to) for the whole graph: from the linked pins where they allow it (pinTurn),
// otherwise from the ↻ angles. Same value both ways round, negated.
export function mapTurner(pins, rotations = {}) {
  const byAngle = rotationTurn(rotations)
  const memo = new Map()
  return (from, to) => {
    const key = `${from}|${to}`
    if (!memo.has(key)) {
      const t = pinTurn(pins, from, to)
      memo.set(key, t ? t.turn : byAngle(from, to))
    }
    return memo.get(key)
  }
}

// Dijkstra over one graph spanning several maps. Links (always within one map) weigh their
// length; a switch pair weighs nothing, so the robot changes map wherever the shortest way
// goes. gridFor(map) gives { grid, info } for the robot's map, to walk it onto the graph.
export function planRoute({ pins, links, robot, targetId, gridFor }) {
  const nodes = new Map(pins.map((p) => [p.id, { ...p, name: displayName(p, pins) }]))
  const goal = nodes.get(targetId)
  if (!goal) return { ok: false, reason: 'That point is not in the route.' }
  if (!robot) return { ok: false, reason: 'The robot is not localized on any map. Relocalize it first.' }

  const here = [...nodes.values()].filter((p) => p.map === robot.map)
  if (here.length === 0) {
    return { ok: false, reason: `The robot is on ${robot.map}, which is not in this route. Relocalize it on one of the route's maps.` }
  }
  const robotGrid = gridFor(robot.map)
  if (!robotGrid) return { ok: false, reason: `Still loading ${robot.map}, the map the robot is on.` }

  let entry = null
  let entryDist = Infinity
  let robotLeg = null
  const byStraight = here
    .map((p) => [Math.hypot(p.x - robot.x, p.y - robot.y), p])
    .sort((u, v) => u[0] - v[0])
  for (const [straight, p] of byStraight) {
    if (straight >= entryDist) break
    const way = wayBetween(robot, p, robotGrid.grid, robotGrid.info, ROBOT_LEG)
    if (way && way.len < entryDist) { entry = p; entryDist = way.len; robotLeg = way.path }
  }
  if (!entry) {
    return { ok: false, reason: 'The robot cannot walk to any of the points from where it is. Add a Simple waypoint near the robot in the Path Editor.' }
  }

  const adj = new Map([...nodes.keys()].map((k) => [k, []]))
  for (const lk of links) {
    const [ia, ib] = lk.split('|')
    const a = nodes.get(ia)
    const b = nodes.get(ib)
    if (!a || !b || a.map !== b.map) continue
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    adj.get(a.id).push([b.id, len])
    adj.get(b.id).push([a.id, len])
  }
  for (const p of pins) {
    const other = partnerOf(pins, p)
    if (other) adj.get(p.id).push([other.id, 0])
  }

  const dist = new Map([...nodes.keys()].map((k) => [k, Infinity]))
  const prev = new Map()
  const done = new Set()
  dist.set(entry.id, 0)
  for (;;) {
    let u = null
    for (const [id, d] of dist) {
      if (!done.has(id) && d < Infinity && (u === null || d < dist.get(u))) u = id
    }
    if (u === null || u === goal.id) break
    done.add(u)
    for (const [v, w] of adj.get(u)) {
      if (dist.get(u) + w < dist.get(v)) { dist.set(v, dist.get(u) + w); prev.set(v, u) }
    }
  }

  if (dist.get(goal.id) === Infinity) {
    return {
      ok: false,
      entry,
      reason: goal.map === robot.map
        ? `No linked way from ${entry.name} to ${goal.name}. Link the points in between in the Path Editor.`
        : `No linked way from ${entry.name} on ${robot.map} to ${goal.name} on ${goal.map}. `
          + "In the Path Editor, link each map's points to its Map Switch and link the switches.",
    }
  }

  const stops = []
  for (let k = goal.id; k !== undefined; k = prev.get(k)) stops.unshift(nodes.get(k))
  const legs = []
  for (let k = 1; k < stops.length; k++) {
    if (stops[k - 1].map === stops[k].map) legs.push([stops[k - 1], stops[k]])
  }
  return { ok: true, stops, entry, lengthM: entryDist + dist.get(goal.id), robotLeg, legs }
}
