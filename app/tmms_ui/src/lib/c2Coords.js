
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

export function fitView(info, size, margin = 0.94) {
  if (!info || !size.width || !size.height) return { scale: 1, x: 0, y: 0 }
  const scale = Math.min(size.width / info.width, size.height / info.height) * margin
  return {
    scale,
    x: (size.width - info.width * scale) / 2,
    y: (size.height - info.height * scale) / 2,
  }
}

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
