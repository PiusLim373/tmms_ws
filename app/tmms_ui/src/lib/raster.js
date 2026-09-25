// Integer rasterisation into a Uint8Array of one byte per pixel.
//
// WHY NOT CANVAS 2D. Every drawing API the browser offers anti-aliases, and this canvas cannot
// tolerate that: the palette is exactly three greys, and map_server classifies a pixel by
// where its value falls between free_thresh and occupied_thresh. A blended edge pixel is not a
// slightly-soft edge, it is a cell that comes back as UNKNOWN — so an anti-aliased wall loads
// as a wall fringed on both sides with cells the planner refuses to route through.
//
// So shapes are rasterised here, by hand, writing only exact palette values. Canvas 2D is used
// for the in-progress preview overlay, which is never committed.
//
// Every draw call goes through a Stroke (see beginStroke), which is both the undo record and
// the dirty-rectangle tracker for the repaint.

/**
 * One pointer-down to pointer-up. Records the ORIGINAL value of each pixel it touches, once,
 * and the bounding box of everything it changed.
 *
 * Sized by what was painted, not by the canvas: a full snapshot of a 4600x3550 map is 16 MB,
 * so a 50-deep undo history of snapshots would be 800 MB. A brush stroke is a few thousand
 * pixels.
 */
export function beginStroke(cells, width, height) {
  const seen = new Set()
  const idx = []
  const prev = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  return {
    width,
    height,

    put(x, y, value) {
      if (x < 0 || y < 0 || x >= width || y >= height) return
      const i = y * width + x
      if (cells[i] === value) return   // no-op: neither an undo entry nor a repaint
      if (!seen.has(i)) {
        seen.add(i)
        idx.push(i)
        prev.push(cells[i])
      }
      cells[i] = value
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    },

    /** null if nothing changed — clicking a pixel already the target colour costs no undo. */
    commit() {
      if (idx.length === 0) return null
      return {
        idx: Int32Array.from(idx),
        prev: Uint8Array.from(prev),
        bounds: { minX, minY, maxX, maxY },
      }
    },

    get dirty() {
      return idx.length === 0 ? null : { minX, minY, maxX, maxY }
    },
  }
}

/**
 * Round brush of diameter `size`, centred on x,y. Round rather than square because it is what
 * a Photoshop-trained hand expects, and a square brush leaves visible corners on a diagonal
 * drag.
 */
export function stampBrush(stroke, cx, cy, size, value) {
  const r = Math.max(0, (size - 1) / 2)
  // +0.25 so size 1 lands exactly one pixel rather than none.
  const rr = (r + 0.25) * (r + 0.25)
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= rr) stroke.put(x, y, value)
    }
  }
}

/**
 * Bresenham, stamping the brush at each step.
 *
 * Used for the line TOOL and, just as importantly, to join consecutive pointermove samples: a
 * fast drag reports positions tens of pixels apart, and stamping only at those would draw a
 * dotted line.
 */
export function drawLine(stroke, x0, y0, x1, y1, size, value) {
  let x = Math.round(x0)
  let y = Math.round(y0)
  const ex = Math.round(x1)
  const ey = Math.round(y1)
  const dx = Math.abs(ex - x)
  const dy = -Math.abs(ey - y)
  const sx = x < ex ? 1 : -1
  const sy = y < ey ? 1 : -1
  let err = dx + dy

  for (;;) {
    stampBrush(stroke, x, y, size, value)
    if (x === ex && y === ey) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
}

export function drawRect(stroke, x0, y0, x1, y1, size, value, filled) {
  const lx = Math.round(Math.min(x0, x1))
  const hx = Math.round(Math.max(x0, x1))
  const ly = Math.round(Math.min(y0, y1))
  const hy = Math.round(Math.max(y0, y1))

  if (filled) {
    for (let y = ly; y <= hy; y++) {
      for (let x = lx; x <= hx; x++) stroke.put(x, y, value)
    }
    return
  }
  // Outline drawn with the brush, so its thickness tracks the brush size like the line tool.
  drawLine(stroke, lx, ly, hx, ly, size, value)
  drawLine(stroke, hx, ly, hx, hy, size, value)
  drawLine(stroke, hx, hy, lx, hy, size, value)
  drawLine(stroke, lx, hy, lx, ly, size, value)
}

/**
 * Circle centred at cx,cy with the given radius.
 *
 * The filled case uses a distance test over the bounding box rather than midpoint scanlines:
 * one comparison per pixel, and it cannot leave the seam a naive midpoint fill does.
 */
export function drawCircle(stroke, cx, cy, radius, size, value, filled) {
  const ccx = Math.round(cx)
  const ccy = Math.round(cy)
  const r = Math.max(0, Math.round(radius))
  if (r === 0) {
    stampBrush(stroke, ccx, ccy, size, value)
    return
  }

  if (filled) {
    const rr = r * r
    for (let y = ccy - r; y <= ccy + r; y++) {
      for (let x = ccx - r; x <= ccx + r; x++) {
        const dx = x - ccx
        const dy = y - ccy
        if (dx * dx + dy * dy <= rr) stroke.put(x, y, value)
      }
    }
    return
  }

  // Midpoint circle, stamping the brush at each of the eight symmetric points so the outline
  // picks up the brush thickness.
  let x = r
  let y = 0
  let err = 1 - r
  while (x >= y) {
    stampBrush(stroke, ccx + x, ccy + y, size, value)
    stampBrush(stroke, ccx + y, ccy + x, size, value)
    stampBrush(stroke, ccx - y, ccy + x, size, value)
    stampBrush(stroke, ccx - x, ccy + y, size, value)
    stampBrush(stroke, ccx - x, ccy - y, size, value)
    stampBrush(stroke, ccx - y, ccy - x, size, value)
    stampBrush(stroke, ccx + y, ccy - x, size, value)
    stampBrush(stroke, ccx + x, ccy - y, size, value)
    y++
    if (err < 0) {
      err += 2 * y + 1
    } else {
      x--
      err += 2 * (y - x) + 1
    }
  }
}

/** Undo one committed stroke. Returns the rect to repaint. */
export function applyUndo(cells, patch) {
  const { idx, prev } = patch
  for (let i = 0; i < idx.length; i++) cells[idx[i]] = prev[i]
  return patch.bounds
}
