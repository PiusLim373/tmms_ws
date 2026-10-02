// c2Coords has quaternionToYaw but not the inverse, and nothing in the UI publishes a pose
// yet. Yaw-only, since every pose this page sends is a ground-plane pose in map.
export function yawToQuaternion(yaw) {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }
}

export function degFromYaw(yaw) {
  return ((yaw * 180) / Math.PI + 360) % 360
}
