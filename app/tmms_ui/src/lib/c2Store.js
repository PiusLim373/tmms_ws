import { POI_CAMS, frameToBlob } from './poi'
import { subscribeCamera } from '../services/rosbridge'

async function asJson(res) {
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).error ?? '' } catch {}
    throw new Error(detail || `HTTP ${res.status}`)
  }
  return res.json()
}

export function listGraphs() {
  return fetch('/api/c2/graphs').then(asJson)
}

export function saveGraph(graph, { keepalive = false } = {}) {
  return fetch(`/api/c2/graphs/${encodeURIComponent(graph.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: graph.name,
      maps: graph.maps,
      rotations: graph.rotations ?? {},
      hiddenPois: graph.hiddenPois ?? [],
      pins: graph.pins,
      links: graph.links ?? [],
    }),
    keepalive,
  }).then(asJson)
}

// -- Photos of a route's own Points of Interest --------------------------------
// Taken as the mapping POI snapshots are: one frame per POI camera, uploaded as multipart to
// ui_backend, kept there as files. A new set replaces the old one.

const FRAME_WAIT_MS = 4000

export const routePhotoUrl = (routeId, file) =>
  `/api/route-photos/${encodeURIComponent(routeId)}/file/${encodeURIComponent(file)}`

export function listRoutePhotos(routeId) {
  return fetch(`/api/route-photos/${encodeURIComponent(routeId)}`).then(asJson)
}

// The next frame on `topic`, or null if none comes in time.
function grabFrame(topic) {
  return new Promise((resolve) => {
    let done = false
    let unsub = null
    const finish = (msg) => {
      if (done) return
      done = true
      unsub?.()
      resolve(msg)
    }
    unsub = subscribeCamera(topic, finish)
    setTimeout(() => finish(null), FRAME_WAIT_MS)
  })
}

export async function takeRoutePhotos(routeId, pinId) {
  const frames = await Promise.all(POI_CAMS.map(async ({ key, topic }) => [key, frameToBlob(await grabFrame(topic))]))
  const form = new FormData()
  let count = 0
  for (const [key, blob] of frames) {
    if (!blob) continue
    form.append(key, blob, `${key}.${blob.type === 'image/png' ? 'png' : 'jpg'}`)
    count++
  }
  if (!count) throw new Error('No camera sent a frame. Are the cameras running?')
  const res = await fetch(`/api/route-photos/${encodeURIComponent(routeId)}/${encodeURIComponent(pinId)}`, {
    method: 'POST', body: form,
  })
  return asJson(res)
}

// A route's own POIs with their photos attached as `poi`, like mapping POIs carry theirs,
// so the hover card and viewer show both the same way.
export function withRoutePhotos(pins, photos, routeId) {
  return pins.map((p) => {
    const set = p.source !== 'mapping' && photos?.[p.id]
    if (!set) return p
    const bust = `?t=${encodeURIComponent(set.takenAt)}`
    return {
      ...p,
      poi: {
        description: p.action?.description ?? '',
        snapshots: set.snapshots,
        timestamp: set.takenAt,
        urls: Object.fromEntries(set.snapshots.map((f) => [f, routePhotoUrl(routeId, f) + bust])),
      },
    }
  })
}
