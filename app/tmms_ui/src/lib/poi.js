// Points of interest: captured while mapping, stored per 3D map by ui_backend.js and copied
// into every 2D map cut from it. x, y are metres and yaw is DEGREES in the map frame.

// `key` is the snapshot filename's camera part: <id>_<key>.jpg
export const POI_CAMS = [
  { key: 'topdown', title: 'TOPDOWN', topic: '/topdown_cam/compressed' },
  { key: 'wrist', title: 'WRIST CAM', topic: '/wrist_cam/compressed' },
  { key: 'thirdperson', title: '3RD PERSON', topic: '/third_person_cam/compressed' },
]

export const camOfSnapshot = (file) => file.replace(/^\d+_/, '').replace(/\.\w+$/, '')

export const poiSnapshotUrl = (map, file) =>
  `/api/poi/${encodeURIComponent(map)}/snapshots/${encodeURIComponent(file)}`

export const map2dSnapshotUrl = (name, file) =>
  `/api/maps2d/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(file)}`

// ISO 8601 with the local offset, e.g. 2026-10-06T15:22:31+08:00 -- readable as the robot's
// own wall-clock time without losing the instant.
export function isoLocal(date = new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const off = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}

export const formatPoiTime = (ts) => (ts ? ts.replace('T', ' ').replace(/(\.\d+)?([+-]\d\d:\d\d|Z)$/, '') : '—')

// A cbor-raw frame carries the encoded bytes; a JSON one carries them as base64.
export function frameToBlob(msg) {
  if (!msg?.data?.length) return null
  const type = msg.format?.includes('png') ? 'image/png' : 'image/jpeg'
  const bytes = typeof msg.data === 'string'
    ? Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0))
    : msg.data
  return new Blob([bytes], { type })
}

export const isDuplicateName = (name, others) => {
  const n = name.trim().toLowerCase()
  return Boolean(n) && others.some((o) => o.trim().toLowerCase() === n)
}
