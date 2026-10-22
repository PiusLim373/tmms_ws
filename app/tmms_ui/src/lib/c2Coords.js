
export function pixelToWorld(px, py, info) {
  return {
    x: info.origin.x + px * info.resolution,
    y: info.origin.y + (info.height - py) * info.resolution,
  }
}

export function worldToPixel(wx, wy, info) {
  return {
    x: (wx - info.origin.x) / info.resolution,
    y: info.height - (wy - info.origin.y) / info.resolution,
  }
}

export function distanceM(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function formatMetres(v) {
  return v.toFixed(2)
}

export function degFromYaw(yaw) {
  return Math.round(((yaw * 180) / Math.PI + 360) % 360)
}

// A view is { scale, x, y, rot }: where map pixel (0, 0) lands on screen, screen px per map
// px, and how far the whole map is turned on screen (radians, clockwise; missing = 0). The
// turn is display only -- world coordinates, and everything sent to the robot, are unchanged.
export function pixelToScreen(px, py, view) {
  const r = view.rot ?? 0
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: view.x + view.scale * (px * c - py * s), y: view.y + view.scale * (px * s + py * c) }
}

export function screenToPixel(sx, sy, view) {
  const r = view.rot ?? 0
  const c = Math.cos(r)
  const s = Math.sin(r)
  const dx = (sx - view.x) / view.scale
  const dy = (sy - view.y) / view.scale
  return { x: dx * c + dy * s, y: -dx * s + dy * c }
}

export function worldToScreen(wx, wy, info, view) {
  const p = worldToPixel(wx, wy, info)
  return pixelToScreen(p.x, p.y, view)
}

export function screenToWorld(sx, sy, info, view) {
  const p = screenToPixel(sx, sy, view)
  return pixelToWorld(p.x, p.y, info)
}

// The whole map, turned by `rot`, fitted and centred in `size`.
export function fitView(info, size, margin = 0.94, rot = 0) {
  if (!info || !size.width || !size.height) return { scale: 1, x: 0, y: 0, rot }
  const c = Math.abs(Math.cos(rot))
  const s = Math.abs(Math.sin(rot))
  const bw = info.width * c + info.height * s
  const bh = info.width * s + info.height * c
  const scale = Math.min(size.width / bw, size.height / bh) * margin
  return centreOn({ scale, x: 0, y: 0, rot }, info.width / 2, info.height / 2, size)
}

// The same view with map pixel (px, py) moved to the middle of `size`.
export function centreOn(view, px, py, size) {
  const at = pixelToScreen(px, py, { ...view, x: 0, y: 0 })
  return { ...view, x: size.width / 2 - at.x, y: size.height / 2 - at.y }
}

// The view turned to `rot`, about whatever is in the middle of the screen.
export function rotateView(view, rot, size) {
  const mid = screenToPixel(size.width / 2, size.height / 2, view)
  return centreOn({ ...view, rot }, mid.x, mid.y, size)
}

export const degToRad = (d) => ((Number(d) || 0) * Math.PI) / 180

export function quaternionToYaw(q) {
  if (!q) return null
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
}

export function normaliseMapEntry(entry) {
  const resolution = typeof entry.resolution === 'number' && entry.resolution > 0
    ? entry.resolution
    : null
  const origin = Array.isArray(entry.origin) && entry.origin.length >= 2
    ? { x: Number(entry.origin[0]), y: Number(entry.origin[1]) }
    : null

  if (resolution === null || origin === null || !entry.width || !entry.height) return null

  return { ...entry, resolution, origin }
}
