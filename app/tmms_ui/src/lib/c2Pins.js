
export const PIN_TYPES = ['action', 'simple', 'home']

export const PIN_META = {
  action: {
    label: 'Action Waypoint',
    hint: 'Somewhere to investigate — the robot drives here, faces the way you set, and stops.',
    colorVar: '--pin-action',
  },
  simple: {
    label: 'Simple Waypoint',
    hint: 'A point on the route to an action waypoint. Just a place to pass through.',
    colorVar: '--pin-simple',
  },
  home: {
    label: 'Home',
    hint: 'Where the robot returns to when a job ends or is aborted. One per graph.',
    colorVar: '--pin-home',
  },
}

export const HEADING_TYPES = new Set(['action', 'home'])

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

export const pinsOfType = (pins, type) => routeOrder(pins.filter((p) => p.type === type))

export function displayNumber(pin, pins = []) {
  const i = pinsOfType(pins, pin.type).findIndex((p) => p.id === pin.id)
  return i === -1 ? (pin.order ?? 0) + 1 : i + 1
}

export function defaultName(pin, pins = []) {
  const n = displayNumber(pin, pins)
  if (pin.type === 'home') return 'Home'
  return pin.type === 'action' ? `WP${n}` : `Simple waypoint ${n}`
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
