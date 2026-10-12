// Draws the point network for C2MapCanvas, which calls this after the map and before the pins,
// so lines run under the pin glyphs instead of across them.
//
// Bottom to top:
//   links          the operator's links: slate; amber dashes when the line crosses a wall
//   selected link  accent
//   pending link   while linking: from the first point to the pointer
//   planned route  bright accent: robot -> first stop dashed (drawn round walls), then the stops;
//                  Go to's nav2 path is dotted instead
//                  while it is being walked, legs already done are grey
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
    // Go to draws nav2's own path dotted (`dashed`), so it reads apart from a route along links.
    if (plan.dashed) ctx.setLineDash([2, 9])
    // While a route is being walked, the legs already done turn grey (`doneLegs` of them).
    const done = plan.doneLegs ?? 0
    plan.legs.forEach((leg, k) => {
      ctx.strokeStyle = k < done ? DONE_COLOR : accent
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

// Screen distance from p to the segment a-b, for clicking a link.
export function distToSegment(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
