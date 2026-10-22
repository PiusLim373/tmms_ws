// Lines two maps up by their walls. One linked Map Switch pair says "this spot is the same on
// both"; the search then turns and shifts the other map about that spot and keeps the place
// where the most of its walls land on walls of the base map, inside the area both have mapped.
// Works from the map images alone, so pins placed by eye only need to be roughly right.
//
// A frame { turn, tx, ty } takes a point on one map to the other: x_to = R(turn) x_from + t.

const CELL_M = 0.1            // both maps are compared on a 10 cm grid
const WALL_MAX = 100          // pixel value at or below which a pixel is a wall
const FREE_MIN = 226          // at or above which it is mapped floor; between is unknown
const NEAR_CELLS = 1.5        // a wall point this close to a base wall counts as matching
const COARSE_POINTS = 1500
const FINE_POINTS = 12000
const SHIFT_M = 1.5           // how far from the pins the search looks
const MIN_OVERLAP = 60        // wall points that must land in mapped base area to trust a score

function pixels(img) {
  if (img.data) return img.data  // already decoded RGBA (tests)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, img.width, img.height).data
}

// Built once per image: a re-match, or scoring a frame placed by hand, reuses them.
const gridCache = new WeakMap()
const pointsCache = new WeakMap()
function cached(cache, img, build) {
  if (!cache.has(img)) cache.set(img, build())
  return cache.get(img)
}

// The base map on the 10 cm grid: which cells are mapped, and how far each is from a wall.
function baseGrid(img, info) {
  const px = pixels(img)
  const k = CELL_M / info.resolution
  const cols = Math.ceil(info.width / k)
  const rows = Math.ceil(info.height / k)
  const wall = new Uint8Array(cols * rows)
  const known = new Uint8Array(cols * rows)
  for (let py = 0; py < info.height; py++) {
    // Cell rows count up from the map origin, as world y does.
    const r = Math.min(rows - 1, Math.floor((info.height - 1 - py) / k))
    for (let pxl = 0; pxl < info.width; pxl++) {
      const i = (py * info.width + pxl) * 4
      if (px[i + 3] === 0) continue
      const v = px[i]
      const c = Math.min(cols - 1, Math.floor(pxl / k))
      if (v <= WALL_MAX) { wall[r * cols + c] = 1; known[r * cols + c] = 1 } else if (v >= FREE_MIN) known[r * cols + c] = 1
    }
  }
  // Distance to the nearest wall, in cells (two-pass chamfer).
  const INF = 1e6
  const dist = new Float32Array(cols * rows)
  for (let i = 0; i < dist.length; i++) dist[i] = wall[i] ? 0 : INF
  const D = Math.SQRT2
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? INF : dist[r * cols + c])
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!dist[i]) continue
      dist[i] = Math.min(dist[i], at(c - 1, r) + 1, at(c, r - 1) + 1, at(c - 1, r - 1) + D, at(c + 1, r - 1) + D)
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c
      if (!dist[i]) continue
      dist[i] = Math.min(dist[i], at(c + 1, r) + 1, at(c, r + 1) + 1, at(c + 1, r + 1) + D, at(c - 1, r + 1) + D)
    }
  }
  return { cols, rows, known, dist, ox: info.origin.x, oy: info.origin.y }
}

// The other map's walls, one point per 10 cm cell, in its own world coordinates.
function wallPoints(img, info) {
  const px = pixels(img)
  const k = CELL_M / info.resolution
  const seen = new Set()
  const out = []
  for (let py = 0; py < info.height; py++) {
    for (let pxl = 0; pxl < info.width; pxl++) {
      const i = (py * info.width + pxl) * 4
      if (px[i + 3] === 0 || px[i] > WALL_MAX) continue
      const key = Math.floor(pxl / k) * 100003 + Math.floor(py / k)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ x: info.origin.x + pxl * info.resolution, y: info.origin.y + (info.height - py) * info.resolution })
    }
  }
  return out
}

// An even spread of `n` of the points (deterministic, so a re-run gives the same answer).
function spread(points, n) {
  if (points.length <= n) return points
  const step = points.length / n
  const out = []
  for (let i = 0; i < n; i++) out.push(points[Math.floor(i * step)])
  return out
}

// How many points land near a base wall, and how many land in mapped base area at all. With
// `soft`, a hit counts less the further it is from the wall, which settles the final pass.
function score(grid, points, f, near, soft = false) {
  const c = Math.cos(f.turn)
  const s = Math.sin(f.turn)
  let hits = 0
  let inside = 0
  for (const p of points) {
    const x = c * p.x - s * p.y + f.tx
    const y = s * p.x + c * p.y + f.ty
    const col = Math.floor((x - grid.ox) / CELL_M)
    const row = Math.floor((y - grid.oy) / CELL_M)
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue
    const i = row * grid.cols + col
    if (!grid.known[i]) continue
    inside++
    const d = grid.dist[i]
    if (d <= near) hits += soft ? 1 - d / (near + 1) : 1
  }
  return { hits, inside }
}

// The frame turning by `turn` about the pinned spot: the pin on the other map lands on the pin
// on the base map, then shifted by (dx, dy).
function aboutPin(turn, from, to, dx, dy) {
  const c = Math.cos(turn)
  const s = Math.sin(turn)
  return { turn, tx: to.x - (c * from.x - s * from.y) + dx, ty: to.y - (s * from.x + c * from.y) + dy }
}

function search(grid, points, from, to, turns, dxs, dys, near, soft = false) {
  let best = null
  for (const turn of turns) {
    for (const dx of dxs) {
      for (const dy of dys) {
        const f = aboutPin(turn, from, to, dx, dy)
        const sc = score(grid, points, f, near, soft)
        if (!best || sc.hits > best.hits) best = { ...f, dx, dy, ...sc }
      }
    }
  }
  return best
}

const range = (centre, half, step) => {
  const out = []
  for (let v = -half; v <= half + 1e-9; v += step) out.push(centre + v)
  return out
}

/**
 * Lines map `from` up onto map `to`. `fromPin`/`toPin` are the linked switch's position on each
 * map; `guess` (a frame, optional) narrows the turn to ±20° around it, otherwise every turn is
 * tried. Returns { turn, tx, ty, score, overlap } -- score is the share of the other map's walls
 * in the shared area that land on the base map's walls -- or null when they share too little.
 */
export function matchMaps(to, from, fromPin, toPin, guess = null, guessTurnDeg = 20) {
  const grid = cached(gridCache, to.img, () => baseGrid(to.img, to.info))
  const all = cached(pointsCache, from.img, () => wallPoints(from.img, from.info))
  // With a guess (e.g. placed by hand), search about where the guess puts the pin, not the pin.
  if (guess) {
    const c = Math.cos(guess.turn)
    const s = Math.sin(guess.turn)
    toPin = { x: c * fromPin.x - s * fromPin.y + guess.tx, y: s * fromPin.x + c * fromPin.y + guess.ty }
  }
  const coarse = spread(all, COARSE_POINTS)
  const fine = spread(all, FINE_POINTS)
  const rad = Math.PI / 180

  const turns = guess ? range(guess.turn, guessTurnDeg * rad, Math.min(2, guessTurnDeg / 5) * rad) : range(0, 180 * rad, 3 * rad)
  // Coarse to fine: each pass searches around the best of the one before.
  let best = search(grid, coarse, fromPin, toPin, turns, range(0, SHIFT_M, 0.3), range(0, SHIFT_M, 0.3), 3)
  best = search(grid, fine, fromPin, toPin, range(best.turn, 3 * rad, 0.5 * rad),
    range(best.dx, 0.3, 0.1), range(best.dy, 0.3, 0.1), 2)
  best = search(grid, fine, fromPin, toPin, range(best.turn, 0.6 * rad, 0.1 * rad),
    range(best.dx, 0.1, 0.025), range(best.dy, 0.1, 0.025), NEAR_CELLS, true)
  if (best.inside < MIN_OVERLAP) return null
  // Reported as the plain share of walls that match, whatever the last pass weighed.
  const plain = score(grid, fine, best, NEAR_CELLS)
  return { turn: best.turn, tx: best.tx, ty: best.ty, score: plain.hits / plain.inside, overlap: plain.inside }
}

// The share of `from`'s walls in the shared area that land on `to`'s walls, for a given frame
// (e.g. one placed by hand). null when they share too little to say.
export function scoreFrame(to, from, frame) {
  const grid = cached(gridCache, to.img, () => baseGrid(to.img, to.info))
  const pts = spread(cached(pointsCache, from.img, () => wallPoints(from.img, from.info)), FINE_POINTS)
  const sc = score(grid, pts, frame, NEAR_CELLS)
  return sc.inside < MIN_OVERLAP ? null : sc.hits / sc.inside
}

// -- Stitching: lined-up maps saved as one ----------------------------------------
// Every map in `frames` laid onto `base`'s coordinates in one grid: a wall in any map is a wall,
// otherwise mapped floor in any map is floor, otherwise unknown. Pixel values as map_saver
// writes them (0 wall, 254 floor, 205 unknown). The result's coordinates are `base`'s, so
// anything placed on the base map is in the same place on the stitched one.

export const MAX_STITCH_PIXELS = 25_000_000   // ~100 MB while drawing; the browser's limit is near

export function stitchSize(frames, byName, resolution) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [m, f] of frames) {
    const info = byName.get(m)
    if (!info) continue
    for (const [px, py] of [[0, 0], [info.width, 0], [0, info.height], [info.width, info.height]]) {
      const w = { x: info.origin.x + px * info.resolution, y: info.origin.y + (info.height - py) * info.resolution }
      const c = Math.cos(f.turn)
      const s = Math.sin(f.turn)
      const x = c * w.x - s * w.y + f.tx
      const y = s * w.x + c * w.y + f.ty
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  const width = Math.ceil((maxX - minX) / resolution)
  const height = Math.ceil((maxY - minY) / resolution)
  return { width, height, minX, minY, resolution }
}

export async function stitchMaps(frames, images, byName, resolution) {
  const size = stitchSize(frames, byName, resolution)
  const { width: W, height: H, minX, minY } = size
  if (W * H > MAX_STITCH_PIXELS) throw new Error(`too big at this resolution (${W}×${H} px); pick a coarser one`)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = false
  const state = new Uint8Array(W * H)  // 0 unknown, 1 floor, 2 wall
  for (const [m, f] of frames) {
    const img = images.get(m)
    const info = byName.get(m)
    if (!img || !info) continue
    // Map m's pixel -> its world -> base world -> stitched pixel, as one affine.
    const c = Math.cos(f.turn)
    const s = Math.sin(f.turn)
    const at = (px, py) => {
      const wx = info.origin.x + px * info.resolution
      const wy = info.origin.y + (info.height - py) * info.resolution
      const x = c * wx - s * wy + f.tx
      const y = s * wx + c * wy + f.ty
      return { x: (x - minX) / resolution, y: H - (y - minY) / resolution }
    }
    const o = at(0, 0)
    const ax = at(1, 0)
    const ay = at(0, 1)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.setTransform(ax.x - o.x, ax.y - o.y, ay.x - o.x, ay.y - o.y, o.x, o.y)
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, W, H).data
    for (let i = 0, j = 0; i < state.length; i++, j += 4) {
      if (px[j + 3] < 128) continue
      const v = px[j]
      if (v <= 100) state[i] = 2
      else if (v >= 226 && state[i] < 2) state[i] = 1
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const out = ctx.createImageData(W, H)
  for (let i = 0, j = 0; i < state.length; i++, j += 4) {
    const g = state[i] === 2 ? 0 : state[i] === 1 ? 254 : 205
    out.data[j] = g; out.data[j + 1] = g; out.data[j + 2] = g; out.data[j + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('the browser could not encode the stitched image')
  return { blob, ...size, origin: [minX, minY, 0] }
}
