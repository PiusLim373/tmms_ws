import { pixelToWorld } from './c2Coords'
import { applyFrame } from './c2Graph'

const LINK_COLOR = 'rgba(100, 116, 139, 0.9)'
const WALL_COLOR = 'rgba(217, 119, 6, 0.95)'
const DONE_COLOR = 'rgba(148, 163, 184, 0.75)'

export function drawGraphLayer(ctx, toScreen, { points, links, selectedKey, pending, plan, accent }) {
  const byId = new Map(points.map((p) => [p.id, p]))
  const polyline = (pts) => {
    if (!pts || pts.length < 2) return
    ctx.beginPath()
    pts.forEach((p, k) => {
      const s = toScreen(p.x, p.y)
      if (k === 0) ctx.moveTo(s.x, s.y)
      else ctx.lineTo(s.x, s.y)
    })
    ctx.stroke()
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const l of links) {
    const a = byId.get(l.a)
    const b = byId.get(l.b)
    if (!a || !b) continue
    const selected = l.key === selectedKey
    ctx.strokeStyle = selected ? accent : l.crossesWall ? WALL_COLOR : LINK_COLOR
    ctx.lineWidth = selected ? 4 : 2.5
    ctx.setLineDash(l.crossesWall && !selected ? [6, 5] : [])
    polyline([a, b])
  }
  ctx.setLineDash([])

  if (pending?.from && pending?.to) {
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    polyline([pending.from, pending.to])
    ctx.setLineDash([])
  }

  if (plan) {
    ctx.lineWidth = 5
    if (plan.dashed) ctx.setLineDash([2, 9])
    const done = plan.doneLegs ?? 0
    plan.legs.forEach((leg, k) => {
      ctx.strokeStyle = (plan.doneFlags ? plan.doneFlags[k] : k < done) ? DONE_COLOR : accent
      polyline(leg)
    })
    ctx.setLineDash([])
    ctx.strokeStyle = accent
    ctx.setLineDash([7, 5])
    polyline(plan.robotLeg)
    ctx.setLineDash([])
  }
  ctx.restore()
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// -- Combined view (Path Editor and C2) ------------------------------------------
// Each other map's walls drawn in its own colour over the base map, so double walls show where
// the maps disagree. The tinted copy of each image is built once.
const COMBINED_COLORS = ['#2563EB', '#DB2777', '#059669', '#D97706', '#7C3AED', '#0891B2']
export const combinedColor = (maps, m) => COMBINED_COLORS[Math.max(0, maps.indexOf(m) - 1) % COMBINED_COLORS.length]

const tintCache = new WeakMap()
function tintedWalls(img, color) {
  const hit = tintCache.get(img)
  if (hit?.color === color) return hit.canvas
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, img.width, img.height)
  const px = data.data
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i]
    const wall = px[i + 3] > 0 && v < 100
    const free = px[i + 3] > 0 && v > 225
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    // Walls solid, floor faintly tinted (so the shared area shows), unknown left out.
    px[i + 3] = wall ? 235 : free ? 26 : 0
  }
  ctx.putImageData(data, 0, 0)
  tintCache.set(img, { color, canvas })
  return canvas
}

// Draws every map in `frames` but the base onto the base map's canvas: its pixels -> its world
// -> the base map's world -> screen, as one affine per map.
export function drawMapsOnto(ctx, toScreen, frames, base, images, byName, colorOf) {
  for (const [m, f] of frames ?? []) {
    if (m === base) continue
    const img = images.get(m)
    const info = byName.get(m)
    if (!img || !info) continue
    const at = (px, py) => {
      const w = applyFrame(f, pixelToWorld(px, py, info))
      return toScreen(w.x, w.y)
    }
    const o = at(0, 0)
    const ax = at(1, 0)
    const ay = at(0, 1)
    ctx.save()
    ctx.setTransform(ax.x - o.x, ax.y - o.y, ay.x - o.x, ay.y - o.y, o.x, o.y)
    ctx.drawImage(tintedWalls(img, colorOf(m)), 0, 0)
    ctx.restore()
  }
}
