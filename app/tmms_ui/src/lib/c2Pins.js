
// 'action' is the stored type of a Point of Interest (POI1, POI2, ...). The UI calls it a Point
// of Interest everywhere; the stored value stays 'action' so saved graphs keep loading.
export const PIN_TYPES = ['action', 'simple', 'home']

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
    hint: 'Where the robot returns to. Link it into the graph like any other point. One per graph.',
    colorVar: '--pin-home',
  },
}

// Not a mission pin: the relocalize marker. It lives outside the graph, is never saved, and is
// not in PIN_TYPES, so it never shows up as something the operator can arm.
export const POSE_TYPE = 'pose'
export const POSE_ID = 'relocalize_pose'

export const HEADING_TYPES = new Set(['action', 'home', POSE_TYPE])

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
    pin.action = { description: '', dwellSeconds: 0, approach: 'go_to' }
  }

  return pin
}

export const routeOrder = (pins) => pins.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

// Points copied in from mapping keep their own names, so they don't take a number from POI1, POI2...
export const pinsOfType = (pins, type) => routeOrder(pins.filter((p) => p.type === type && p.source !== 'mapping'))

export function displayNumber(pin, pins = []) {
  const i = pinsOfType(pins, pin.type).findIndex((p) => p.id === pin.id)
  return i === -1 ? (pin.order ?? 0) + 1 : i + 1
}

export function defaultName(pin, pins = []) {
  const n = displayNumber(pin, pins)
  if (pin.type === 'home') return 'Home'
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
