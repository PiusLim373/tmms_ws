// Conversions between the three ways a 2D map exists in this app.
//
//   nav_msgs/OccupancyGrid   what map_flattener publishes    int8, -1 / 0 / 100
//   cells (Uint8Array)       what the editor edits           grey, 0 / 205 / 255
//   PNG                      what goes on disk               grey, 0 / 205 / 255
//
// THE FLIP. OccupancyGrid row 0 is the BOTTOM row of the map: `origin` is the bottom-left
// corner and y increases upward. PNG row 0 is the TOP. So one of these conversions has to
// flip vertically, and it is this one — `cells` is kept in image orientation throughout, which
// makes the PNG write and the PNG read straight copies and leaves exactly one place where the
// flip can be wrong.
//
// Getting it wrong does not look like a bug. The map still renders, still has the right
// dimensions, still saves — it is simply mirrored about its horizontal centreline, and only
// shows up when someone overlays it on the point cloud it came from.

export const OBSTACLE = 0
export const UNKNOWN = 205
export const FREE = 255

// 205 is the conventional ROS unknown grey. ui_backend.js writes free_thresh: 0.15 so that
// map_server reads it back as unknown rather than free; see the comment there.
export const PALETTE = [
  { value: OBSTACLE, label: 'Obstacle', swatch: '#000000' },
  { value: FREE, label: 'Free space', swatch: '#FFFFFF' },
  { value: UNKNOWN, label: 'Unknown', swatch: '#CDCDCD' },
]

function occupancyToGrey(v) {
  if (v < 0) return UNKNOWN      // -1, never seen
  if (v >= 50) return OBSTACLE   // 100
  return FREE                    // 0
}

/**
 * OccupancyGrid message -> { cells, width, height, resolution, origin }.
 * `msg.data` may be a typed array (cbor) or a plain array (json); both index the same.
 */
export function gridToCells(msg) {
  const width = msg.info.width
  const height = msg.info.height
  const data = msg.data
  const cells = new Uint8Array(width * height)

  for (let row = 0; row < height; row++) {
    const src = row * width
    const dst = (height - 1 - row) * width   // <- the flip
    for (let col = 0; col < width; col++) {
      cells[dst + col] = occupancyToGrey(data[src + col])
    }
  }

  return {
    cells,
    width,
    height,
    resolution: msg.info.resolution,
    origin: [msg.info.origin.position.x, msg.info.origin.position.y, 0],
  }
}

/** cells -> ImageData, for both on-screen rendering and PNG export. Opaque greyscale. */
export function cellsToImageData(cells, width, height) {
  const img = new ImageData(width, height)
  const rgba = img.data
  for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
    const v = cells[i]
    rgba[p] = v
    rgba[p + 1] = v
    rgba[p + 2] = v
    rgba[p + 3] = 255
  }
  return img
}

/**
 * Decode a saved map PNG back into cells. No flip — the file is already in image orientation.
 *
 * Snapped to the nearest palette value rather than taken verbatim: a map that has been through
 * an external tool can carry near-but-not-exact greys, and letting those through would put
 * values in the canvas that the palette cannot represent and map_server would classify by
 * whichever side of a threshold they happened to land on.
 */
export function imageToCells(image) {
  const { width, height } = image
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, 0, 0)

  const rgba = ctx.getImageData(0, 0, width, height).data
  const cells = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
    const v = rgba[p]
    // Midpoints of 0/205/255.
    cells[i] = v < 103 ? OBSTACLE : (v < 230 ? UNKNOWN : FREE)
  }
  return { cells, width, height }
}

/** cells -> PNG Blob, via a detached canvas. */
export function cellsToPngBlob(cells, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.putImageData(cellsToImageData(cells, width, height), 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('canvas.toBlob returned null — the map may be too large'))
    }, 'image/png')
  })
}

/** Load <PNG_DIR>/<name>.png into an Image. */
export function loadMapImage(name) {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`could not load ${name}.png`))
    img.src = `/api/maps2d/${name}/image`
  })
}
