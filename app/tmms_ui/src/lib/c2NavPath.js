import { Topic } from 'roslib'
import { ros } from '../services/rosbridge'

const ENCAPSULATION_BYTES = 4

export function decodePathCdr(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = (bytes[0] << 8) | bytes[1]
  const le = (kind & 1) === 1
  const maxAlign = kind <= 1 ? 8 : 4
  let o = ENCAPSULATION_BYTES
  const align = (n) => {
    const a = Math.min(n, maxAlign)
    const r = (o - ENCAPSULATION_BYTES) % a
    if (r) o += a - r
  }
  const u32 = () => { align(4); const v = view.getUint32(o, le); o += 4; return v }
  const i32 = () => { align(4); const v = view.getInt32(o, le); o += 4; return v }
  const f64 = () => { align(8); const v = view.getFloat64(o, le); o += 8; return v }
  const string = () => {
    const len = u32()
    const s = new TextDecoder().decode(bytes.subarray(o, o + Math.max(0, len - 1)))
    o += len
    return s
  }
  const header = () => { i32(); u32(); return string() }

  const frame = header()
  const n = u32()
  const points = new Array(n)
  for (let i = 0; i < n; i++) {
    header()
    const x = f64(); const y = f64(); f64()
    f64(); f64(); f64(); f64()
    points[i] = { x, y }
  }
  return { frame, points }
}

export function subscribeNavPlan(onPath) {
  const topic = new Topic({
    ros,
    name: '/plan',
    messageType: 'nav_msgs/Path',
    compression: 'cbor-raw',
    throttle_rate: 300,
    queue_length: 1,
  })
  let warned = false
  topic.subscribe((msg) => {
    try {
      onPath(decodePathCdr(msg.bytes))
    } catch (err) {
      if (!warned) console.error('[c2NavPath] /plan decode failed:', err)
      warned = true
    }
  })
  return () => topic.unsubscribe()
}
