import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { suspendKeyboard } from '../../hooks/useKeyboard'
import {
  cellsToImageData, cellsToPngBlob, cropCells, cropOrigin, OBSTACLE, FREE, PALETTE,
} from '../../lib/gridCodec'
import {
  applyUndo, beginStroke, drawCircle, drawLine, drawRect, stampBrush,
} from '../../lib/raster'
import { defaultMapName } from '../../lib/dates'

// A flattened lidar map always has junk in it — someone who walked through the scan, a parked
// pallet, a doorway the beam clipped through — and nav2 plans around or into every one. This
// is where that gets fixed before the map is written to disk.
//
// Full-screen rather than a card: the Mapping Tool panel is ~35% x 50% of the viewport, which
// is not enough to edit a several-thousand-pixel map in.

// Drawn rather than typed: the glyphs these replace (✎ ⌫ ╱ ▭ ○ ✋) are font-dependent, so they
// arrive at a different weight and baseline on every machine, and they only look worse the
// larger they get -- which is the wrong direction for an icon-only rail. One 24x24 grid,
// currentColor, so the active/hover states in ToolButton drive them for free.
const ICONS = {
  hand: (
    <>
      <path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M14 11V5.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M17 8.5a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4l-2.2-3.7a1.5 1.5 0 0 1 2.5-1.6L8 14" />
    </>
  ),
  // Photoshop's: two interlocking corners.
  crop: (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </>
  ),
  rect: <rect x="3.5" y="5.5" width="17" height="13" rx="1" />,
  circle: <circle cx="12" cy="12" r="8.5" />,
  line: <path d="M4 20 20 4" />,
  pencil: (
    <>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  eraser: (
    <>
      <path d="M8.5 20 3.8 15.3a2 2 0 0 1 0-2.8l8.4-8.4a2 2 0 0 1 2.8 0l4.9 4.9a2 2 0 0 1 0 2.8L13.5 20Z" />
      <path d="M8.5 20H20" />
      <path d="M9 9l6.5 6.5" />
    </>
  ),
}

// Order is the rail's order, top to bottom: navigation and crop first, then shapes, then
// freehand -- grouped the way Photoshop separates them, with the non-painting tools above the
// rule. C is Crop, as in Photoshop, so Circle takes O.
const TOOLS = [
  { key: 'hand', label: 'Pan', hotkey: 'Space' },
  { key: 'crop', label: 'Crop', hotkey: 'C' },
  { key: 'rect', label: 'Rectangle', hotkey: 'R' },
  { key: 'circle', label: 'Circle', hotkey: 'O' },
  { key: 'line', label: 'Line', hotkey: 'L' },
  { key: 'pencil', label: 'Pencil', hotkey: 'B' },
  { key: 'eraser', label: 'Eraser', hotkey: 'E' },
]
const PAINT_RULE_INDEX = 2
const SHAPE_TOOLS = new Set(['line', 'rect', 'circle'])
// rect and circle only. `line` ignores the flag, so offering it there is a lie about what the
// next stroke will do.
const FILLABLE_TOOLS = new Set(['rect', 'circle'])
const HOTKEY_TO_TOOL = {
  KeyB: 'pencil', KeyE: 'eraser', KeyL: 'line', KeyR: 'rect', KeyO: 'circle', KeyC: 'crop',
}

const ZOOM_STEP = 1.4

const MIN_BRUSH = 1
const MAX_BRUSH = 200
const MIN_ZOOM = 0.02
const MAX_ZOOM = 40
const UNDO_LIMIT = 50

const MAP_NAME_RE = /^[A-Za-z0-9_]+$/

// A crop selection from two corner cells: ordered, clamped to the map, both corners included.
function boxFrom(a, b, width, height) {
  const clamp = (v, hi) => Math.min(hi, Math.max(0, v))
  const x0 = clamp(Math.min(a.x, b.x), width - 1)
  const x1 = clamp(Math.max(a.x, b.x), width - 1)
  const y0 = clamp(Math.min(a.y, b.y), height - 1)
  const y1 = clamp(Math.max(a.y, b.y), height - 1)
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function boxLabel(box, resolution) {
  return `${box.w} × ${box.h} px · ${(box.w * resolution).toFixed(2)} × `
    + `${(box.h * resolution).toFixed(2)} m`
}

/**
 * props:
 *   open        bool
 *   source        { cells, width, height, resolution, origin, pcdName, name|null, pois? }
 *                 `name` null in create mode, which is what disables Save.
 *   existingNames string[]  2D maps already on disk, for the overwrite warning
 *   onSave        (name, blob, meta) => Promise   resolves when written
 *   onClose       () => void
 */
export function MapEditorModal({ open, source, existingNames = [], onSave, onClose }) {
  const [tool, setTool] = useState('pencil')
  const [colour, setColour] = useState(OBSTACLE)
  const [brush, setBrush] = useState(8)
  const [filled, setFilled] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [undoDepth, setUndoDepth] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [namePrompt, setNamePrompt] = useState(null)   // null | { value, overwriteOk }
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [mapName, setMapName] = useState(source?.name ?? null)
  // Drives the rail's tooltips. A CSS :hover rule would be cheaper, but it needs a descendant
  // selector, which the inline styles used throughout this file cannot express -- and the
  // alternative, global class names in index.css for one component, is worse. Six buttons.
  const [hoveredTool, setHoveredTool] = useState(null)
  // The open map's size and origin. They start as the source's but change on crop, so nothing
  // past setup reads them off `source`. docRef is what the draw loop reads; this is for render.
  const [doc, setDoc] = useState(null)
  const [cropBox, setCropBoxState] = useState(null)   // null | { x, y, w, h } in cells
  const [confirmReplace, setConfirmReplace] = useState(null)   // null | name about to be replaced

  const viewportRef = useRef(null)
  const displayRef = useRef(null)
  const overlayRef = useRef(null)

  // Everything the draw loop touches lives in refs: it runs from pointer events at up to
  // 120 Hz and must not re-render React per sample.
  const cellsRef = useRef(null)
  const bufRef = useRef(null)          // offscreen canvas at native map size
  const viewRef = useRef({ scale: 1, x: 0, y: 0 })
  const strokeRef = useRef(null)
  const lastPtRef = useRef(null)
  const startPtRef = useRef(null)
  const panRef = useRef(null)
  const undoRef = useRef([])
  const cursorRef = useRef(null)
  const docRef = useRef(null)          // { width, height, origin, resolution }
  const cropBoxRef = useRef(null)
  // Size and origin last read from or written to disk under `savedRef.current.name`, so Save
  // can tell when it would replace that map with a cropped one.
  const savedRef = useRef(null)

  const setCropBox = useCallback((box) => {
    cropBoxRef.current = box
    setCropBoxState(box)
  }, [])

  // Offscreen copy of the whole map at native size. Rebuilt whenever the size changes.
  const rebuildBuffer = useCallback(() => {
    const { width, height } = docRef.current
    const buf = document.createElement('canvas')
    buf.width = width
    buf.height = height
    buf.getContext('2d').putImageData(cellsToImageData(cellsRef.current, width, height), 0, 0)
    bufRef.current = buf
  }, [])

  // -- setup ---------------------------------------------------------------

  useEffect(() => {
    if (!open || !source) return
    // Copied, so Cancel really does discard: the caller keeps the grid it handed in.
    cellsRef.current = new Uint8Array(source.cells)
    docRef.current = {
      width: source.width,
      height: source.height,
      origin: source.origin,
      resolution: source.resolution,
    }
    savedRef.current = { name: source.name ?? null, width: source.width, height: source.height,
      origin: source.origin }
    setDoc(docRef.current)
    setCropBox(null)
    undoRef.current = []
    setUndoDepth(0)
    setDirty(false)
    setError(null)
    setMapName(source.name ?? null)
    rebuildBuffer()
  }, [open, source, rebuildBuffer, setCropBox])

  // The whole reason suspendKeyboard exists: space, B, E, L, R and C are all quadruped teleop
  // keys, and QuadrupedWidget is still mounted behind this modal.
  useEffect(() => {
    if (!open) return
    suspendKeyboard(true)
    return () => suspendKeyboard(false)
  }, [open])

  const render = useCallback(() => {
    const display = displayRef.current
    const buf = bufRef.current
    if (!display || !buf) return
    const ctx = display.getContext('2d')
    const { scale, x, y } = viewRef.current

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // Cleared, not filled: the viewport div behind supplies --bg, and a canvas cannot resolve
    // a CSS custom property anyway.
    ctx.clearRect(0, 0, display.width, display.height)
    // Nearest-neighbour: at the zoom levels this is used at, a smoothed map is a lie about
    // which cells are which.
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(buf, x, y, buf.width * scale, buf.height * scale)

    // Where the map ends. Unknown cells are drawn mid-grey and the surround is near-black, so
    // the boundary is usually visible -- but a map whose edge is all obstacle or all free has
    // no visible edge at all, and there is then no way to tell "off the map" from "empty part
    // of the map" while panning. Half-pixel offset so the 1px line lands on a pixel.
    ctx.strokeStyle = 'rgba(148, 130, 180, 0.55)'
    ctx.lineWidth = 1
    ctx.strokeRect(
      Math.round(x) + 0.5, Math.round(y) + 0.5,
      Math.round(buf.width * scale), Math.round(buf.height * scale))
  }, [])

  // Size the backing store to the element's real pixels, so the map is not blurred by CSS
  // scaling, and re-fit on resize.
  useEffect(() => {
    if (!open) return
    const fit = () => {
      const vp = viewportRef.current
      const display = displayRef.current
      const overlay = overlayRef.current
      if (!vp || !display || !overlay) return
      const rect = vp.getBoundingClientRect()
      for (const c of [display, overlay]) {
        c.width = Math.max(1, Math.floor(rect.width))
        c.height = Math.max(1, Math.floor(rect.height))
      }
      render()
    }
    fit()
    const ro = new ResizeObserver(fit)
    if (viewportRef.current) ro.observe(viewportRef.current)
    return () => ro.disconnect()
  }, [open, render])

  // Shared by the open-the-editor effect below and the Fit button in the status bar, so the
  // two can never drift apart on what "fit" means.
  const fitToView = useCallback(() => {
    const d = docRef.current
    const vp = viewportRef.current
    if (!d || !vp) return
    const rect = vp.getBoundingClientRect()
    const scale = Math.min(rect.width / d.width, rect.height / d.height) * 0.95
    viewRef.current = {
      scale,
      x: (rect.width - d.width * scale) / 2,
      y: (rect.height - d.height * scale) / 2,
    }
    setZoom(scale)
    render()
  }, [render])

  // Fit-to-view once the map and the viewport both exist.
  useEffect(() => {
    if (!open) return
    fitToView()
  }, [open, source, fitToView])

  // Repaint only the rectangle a stroke touched. On a 4600x3550 map a full putImageData is
  // ~65 MB of copying, which is visible as lag on every brush dab.
  const blitDirty = useCallback((rect) => {
    const buf = bufRef.current
    const cells = cellsRef.current
    if (!buf || !cells || !rect) return
    const { minX, minY, maxX, maxY } = rect
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    const img = new ImageData(w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = cells[(minY + y) * buf.width + (minX + x)]
        const p = (y * w + x) * 4
        img.data[p] = v
        img.data[p + 1] = v
        img.data[p + 2] = v
        img.data[p + 3] = 255
      }
    }
    buf.getContext('2d').putImageData(img, minX, minY)
    render()
  }, [render])

  // -- coordinates ---------------------------------------------------------

  const toPixel = useCallback((clientX, clientY) => {
    const rect = viewportRef.current.getBoundingClientRect()
    const { scale, x, y } = viewRef.current
    return {
      x: Math.floor((clientX - rect.left - x) / scale),
      y: Math.floor((clientY - rect.top - y) / scale),
    }
  }, [])

  // -- overlay (previews + brush cursor) -----------------------------------

  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    const ctx = overlay.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, overlay.width, overlay.height)

    const { scale, x: ox, y: oy } = viewRef.current
    const toScreen = (px, py) => [ox + px * scale, oy + py * scale]

    // Anti-aliased on purpose — this canvas is never committed. It sits ABOVE the map and is
    // cleared the moment the shape is rasterised properly.
    ctx.strokeStyle = '#7C3AED'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])

    const start = startPtRef.current
    const last = lastPtRef.current
    if (start && last && SHAPE_TOOLS.has(tool)) {
      const [sx, sy] = toScreen(start.x, start.y)
      const [lx, ly] = toScreen(last.x, last.y)
      ctx.beginPath()
      if (tool === 'line') {
        ctx.moveTo(sx, sy)
        ctx.lineTo(lx, ly)
      } else if (tool === 'rect') {
        ctx.rect(Math.min(sx, lx), Math.min(sy, ly), Math.abs(lx - sx), Math.abs(ly - sy))
      } else {
        const r = Math.hypot(last.x - start.x, last.y - start.y) * scale
        ctx.arc(sx, sy, r, 0, Math.PI * 2)
      }
      ctx.stroke()
    }

    // The box being dragged, or the one waiting for Apply. Everything outside it is dimmed so
    // what is left reads as the result.
    const d = docRef.current
    const box = tool === 'crop' && d
      ? (start && last ? boxFrom(start, last, d.width, d.height) : cropBoxRef.current)
      : null
    if (box) {
      const [bx, by] = toScreen(box.x, box.y)
      const bw = box.w * scale
      const bh = box.h * scale
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.fillRect(0, 0, overlay.width, overlay.height)
      ctx.clearRect(bx, by, bw, bh)
      ctx.strokeRect(bx, by, bw, bh)

      const label = boxLabel(box, d.resolution)
      ctx.setLineDash([])
      ctx.font = '11px monospace'
      ctx.textBaseline = 'middle'
      const ly = by > 24 ? by - 22 : by + 4
      ctx.fillStyle = 'rgba(15, 10, 25, 0.85)'
      ctx.fillRect(bx, ly, ctx.measureText(label).width + 12, 18)
      ctx.fillStyle = '#FFFFFF'
      ctx.fillText(label, bx + 6, ly + 9)
    }

    // Brush outline, so the operator can see what a dab will cover before committing to it.
    const cur = cursorRef.current
    if (cur && (tool === 'pencil' || tool === 'eraser')) {
      const [cx, cy] = toScreen(cur.x + 0.5, cur.y + 0.5)
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(cx, cy, Math.max(2, (brush / 2) * scale), 0, Math.PI * 2)
      ctx.stroke()
    }
  }, [tool, brush])

  // -- drawing -------------------------------------------------------------

  const activeValue = tool === 'eraser' ? FREE : colour

  const pushUndo = useCallback((patch) => {
    if (!patch) return
    undoRef.current.push(patch)
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift()
    setUndoDepth(undoRef.current.length)
    setDirty(true)
  }, [])

  // Swap in a whole document -- a crop, or the undo of one -- and show it fitted.
  const replaceDoc = useCallback((cells, width, height, origin) => {
    cellsRef.current = cells
    docRef.current = { ...docRef.current, width, height, origin }
    setDoc(docRef.current)
    setCropBox(null)
    rebuildBuffer()
    fitToView()
  }, [rebuildBuffer, fitToView, setCropBox])

  // Undo is LIFO, so a stroke patch recorded before a crop -- indexed against the larger map --
  // is only ever replayed after the crop entry above it has put that size back.
  const undo = useCallback(() => {
    const patch = undoRef.current.pop()
    if (!patch) return
    setUndoDepth(undoRef.current.length)
    if (patch.crop) {
      const { cells, width, height, origin } = patch.crop
      replaceDoc(cells, width, height, origin)
    } else {
      blitDirty(applyUndo(cellsRef.current, patch))
    }
  }, [blitDirty, replaceDoc])

  const applyCrop = useCallback(() => {
    const box = cropBoxRef.current
    const d = docRef.current
    if (!box || !d || (box.w === d.width && box.h === d.height)) return
    // The whole pre-crop document, since a crop is not a patch of the map it came from.
    pushUndo({ crop: { cells: cellsRef.current, width: d.width, height: d.height, origin: d.origin } })
    replaceDoc(
      cropCells(cellsRef.current, d.width, box.x, box.y, box.w, box.h),
      box.w, box.h,
      cropOrigin(d.origin, d.resolution, d.height, box.x, box.y, box.h))
  }, [pushUndo, replaceDoc])

  const isPanning = tool === 'hand' || spaceHeld

  function onPointerDown(e) {
    if (!open || busy) return
    e.currentTarget.setPointerCapture(e.pointerId)

    if (isPanning || e.button === 1) {
      panRef.current = { x: e.clientX, y: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y }
      return
    }

    const p = toPixel(e.clientX, e.clientY)
    startPtRef.current = p
    lastPtRef.current = p

    if (tool === 'crop') setCropBox(null)   // a new drag replaces the waiting box
    if (SHAPE_TOOLS.has(tool) || tool === 'crop') {
      drawOverlay()   // committed on pointer up, previewed until then
      return
    }
    const stroke = beginStroke(cellsRef.current, docRef.current.width, docRef.current.height)
    strokeRef.current = stroke
    stampBrush(stroke, p.x, p.y, brush, activeValue)
    blitDirty(stroke.dirty)
  }

  function onPointerMove(e) {
    if (!open) return

    if (panRef.current) {
      const pan = panRef.current
      viewRef.current = {
        ...viewRef.current,
        x: pan.ox + (e.clientX - pan.x),
        y: pan.oy + (e.clientY - pan.y),
      }
      render()
      drawOverlay()
      return
    }

    const p = toPixel(e.clientX, e.clientY)
    cursorRef.current = p

    if (strokeRef.current) {
      // Joined to the previous sample: a fast drag reports positions tens of pixels apart and
      // dabbing only at those would draw a dotted line.
      const last = lastPtRef.current
      drawLine(strokeRef.current, last.x, last.y, p.x, p.y, brush, activeValue)
      lastPtRef.current = p
      blitDirty(strokeRef.current.dirty)
      drawOverlay()
      return
    }

    if (startPtRef.current && (SHAPE_TOOLS.has(tool) || tool === 'crop')) lastPtRef.current = p
    drawOverlay()
  }

  function onPointerUp(e) {
    if (!open) return
    if (panRef.current) {
      panRef.current = null
      return
    }

    const start = startPtRef.current
    const end = lastPtRef.current
    startPtRef.current = null

    if (strokeRef.current) {
      pushUndo(strokeRef.current.commit())
      strokeRef.current = null
    } else if (start && end && tool === 'crop') {
      // Kept for Apply rather than cropped on release. A click, or a box a cell thin, clears it.
      const d = docRef.current
      const box = boxFrom(start, end, d.width, d.height)
      setCropBox(box.w > 1 && box.h > 1 ? box : null)
    } else if (start && end && SHAPE_TOOLS.has(tool)) {
      const stroke = beginStroke(cellsRef.current, docRef.current.width, docRef.current.height)
      if (tool === 'line') {
        drawLine(stroke, start.x, start.y, end.x, end.y, brush, activeValue)
      } else if (tool === 'rect') {
        drawRect(stroke, start.x, start.y, end.x, end.y, brush, activeValue, filled)
      } else {
        drawCircle(stroke, start.x, start.y,
          Math.hypot(end.x - start.x, end.y - start.y), brush, activeValue, filled)
      }
      blitDirty(stroke.dirty)
      pushUndo(stroke.commit())
    }

    lastPtRef.current = null
    drawOverlay()
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Keeps the point under (mx, my) pinned while the scale changes. Shared by the wheel, which
  // passes the cursor, and the status bar's +/- buttons, which pass the viewport centre.
  const zoomAbout = useCallback((mx, my, factor) => {
    const { scale, x, y } = viewRef.current
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * factor))
    viewRef.current = {
      scale: next,
      x: mx - (mx - x) * (next / scale),
      y: my - (my - y) * (next / scale),
    }
    setZoom(next)
    render()
    drawOverlay()
  }, [render, drawOverlay])

  // Zoom about the cursor rather than the centre: at 20x the centre is somewhere off-screen
  // and zooming toward it walks the map away from whatever you were looking at.
  function onWheel(e) {
    if (!open) return
    const rect = viewportRef.current.getBoundingClientRect()
    zoomAbout(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  // The buttons have no cursor to anchor to, so they hold the middle of the view still.
  function zoomByButton(factor) {
    const vp = viewportRef.current
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    zoomAbout(rect.width / 2, rect.height / 2, factor)
  }

  // -- keyboard ------------------------------------------------------------

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      const typing = e.target && (e.target.tagName === 'INPUT' || e.target.isContentEditable)
      if (typing) return

      if (e.code === 'Space') {
        e.preventDefault()
        setSpaceHeld(true)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault()
        undo()
        return
      }
      if (cropBoxRef.current && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
        e.preventDefault()
        applyCrop()
        return
      }
      if (cropBoxRef.current && e.code === 'Escape') {
        setCropBox(null)
        drawOverlay()
        return
      }
      if (e.code === 'BracketLeft') {
        setBrush((b) => Math.max(MIN_BRUSH, b - Math.max(1, Math.round(b * 0.2))))
        return
      }
      if (e.code === 'BracketRight') {
        setBrush((b) => Math.min(MAX_BRUSH, b + Math.max(1, Math.round(b * 0.2))))
        return
      }
      if (HOTKEY_TO_TOOL[e.code]) setTool(HOTKEY_TO_TOOL[e.code])
    }
    const onUp = (e) => { if (e.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [open, undo, applyCrop, setCropBox, drawOverlay])

  // A waiting crop box belongs to the crop tool; any other tool drops it.
  useEffect(() => { if (tool !== 'crop') setCropBox(null) }, [tool, setCropBox])

  useEffect(() => { drawOverlay() }, [drawOverlay, cropBox])

  // -- save ----------------------------------------------------------------

  async function writeMap(name) {
    setBusy(true)
    setError(null)
    setConfirmReplace(null)
    try {
      const { width, height, origin } = docRef.current
      const blob = await cellsToPngBlob(cellsRef.current, width, height)
      await onSave(name, blob, {
        resolution: source.resolution,
        origin,
        pcdName: source.pcdName ?? null,
        // Where POIs and their snapshots come from when the 3D map's own POI file is gone.
        pois: source.pois ?? null,
        sourceName: source.name ?? null,
      })
      savedRef.current = { name, width, height, origin }
      setMapName(name)      // a saved-as map becomes the Save target from here on
      setDirty(false)
      setNamePrompt(null)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  // Writing a cropped map back under the name it was opened (or last saved) as replaces that
  // map with the smaller area, so that one is confirmed. Any other write goes straight through.
  function requestWrite(name) {
    const s = savedRef.current
    const d = docRef.current
    const replacesWithCrop = s && name === s.name && (s.width !== d.width || s.height !== d.height
      || s.origin[0] !== d.origin[0] || s.origin[1] !== d.origin[1])
    if (replacesWithCrop) setConfirmReplace(name)
    else writeMap(name)
  }

  if (!open || !source) return null

  // Rendered before the setup effect has filled `doc` -- the canvases must exist for the
  // sizing and fit effects -- so the source stands in for that first frame.
  const shown = doc ?? source
  const nameValid = namePrompt != null && MAP_NAME_RE.test(namePrompt.value)
  const megapixels = (shown.width * shown.height) / 1e6
  const cropIsWhole = cropBox && cropBox.w === shown.width && cropBox.h === shown.height

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}
      role="dialog"
      aria-modal="true"
    >
      {/* Title bar. Taller than the shared .panel-header default, which is sized for the small
          dashboard panels and looks squeezed at full-screen width. */}
      <div className="panel-header" style={{ background: 'var(--panel-bg)', padding: '10px 14px' }}>
        <span style={{ color: 'var(--text-h)' }}>Map Editor — {mapName ?? 'unsaved'}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
          {shown.width} × {shown.height} px · {source.resolution} m/px
          {' '}· origin ({shown.origin[0].toFixed(2)}, {shown.origin[1].toFixed(2)})
          {' '}· {megapixels.toFixed(1)} MP
          {dirty && <span style={{ color: '#F59E0B' }}> · unsaved changes</span>}
        </span>
      </div>

      {/* Options bar — everything that modifies the NEXT stroke, contextual to the active tool.
          Photoshop's arrangement: the rail says which tool, this says how it behaves. */}
      <div
        className="flex items-center"
        style={{
          flexShrink: 0, gap: 16, padding: '0 12px', height: 44,
          background: 'var(--panel-bg)', borderBottom: '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center"
          style={{ gap: 6, opacity: tool === 'eraser' || tool === 'crop' ? 0.45 : 1 }}
        >
          {PALETTE.map(({ value, label, swatch }) => (
            <button
              key={value}
              onClick={() => {
                setColour(value)
                if (tool === 'eraser' || tool === 'crop') setTool('pencil')
              }}
              title={label}
              aria-label={label}
              aria-pressed={colour === value && tool !== 'eraser'}
              style={{
                width: 26, height: 26, borderRadius: 4, background: swatch, cursor: 'pointer',
                padding: 0,
                border: colour === value && tool !== 'eraser'
                  ? '2px solid var(--accent-bright)'
                  : '1px solid var(--border)',
                boxShadow: colour === value && tool !== 'eraser'
                  ? '0 0 0 1px var(--panel-bg) inset' : 'none',
              }}
            />
          ))}
        </div>

        <Divider />

        {/* The eraser is the one tool whose colour is not the swatch above, so say so rather
            than leaving the dimmed swatches to be read as "colour does nothing here". */}
        {tool === 'eraser' ? (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Eraser paints free space</span>
        ) : null}

        <div
          className="flex items-center"
          style={{ gap: 8, opacity: tool === 'hand' || tool === 'crop' ? 0.45 : 1 }}
        >
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--text-dim)',
          }}>
            Brush
          </span>
          <input
            type="range" min={MIN_BRUSH} max={MAX_BRUSH} value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
            disabled={tool === 'hand' || tool === 'crop'}
            style={{ width: 130, accentColor: 'var(--accent-bright)' }}
          />
          <span className="val-mono" style={{ width: 46, textAlign: 'right' }}>{brush} px</span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>[ ]</span>
        </div>

        {FILLABLE_TOOLS.has(tool) && (
          <>
            <Divider />
            <label className="flex items-center" style={{ gap: 6, fontSize: 11, cursor: 'pointer' }}>
              <input
                type="checkbox" checked={filled} onChange={() => setFilled((f) => !f)}
                style={{ accentColor: 'var(--accent-bright)' }}
              />
              Fill
            </label>
          </>
        )}

        {tool === 'crop' && (
          <>
            <Divider />
            {cropBox ? (
              <div className="flex items-center" style={{ gap: 8 }}>
                <span className="val-mono">{boxLabel(cropBox, source.resolution)}</span>
                <button
                  className="btn-icon" style={{ height: 26, borderColor: 'var(--accent-bright)' }}
                  onClick={applyCrop}
                  disabled={cropIsWhole}
                  title={cropIsWhole ? 'The box covers the whole map' : 'Keep only the box (Enter)'}
                >
                  Apply ✓
                </button>
                <button
                  className="btn-icon" style={{ height: 26 }}
                  onClick={() => setCropBox(null)}
                  title="Drop the box (Esc)"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Drag a box around the area to keep
              </span>
            )}
          </>
        )}

        {/* The rail is icon-only now, so the active tool's name has to be readable somewhere. */}
        <div style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-h)' }}>
          {TOOLS.find((t) => t.key === tool)?.label}
          {spaceHeld && tool !== 'hand' && (
            <span style={{ color: 'var(--text-dim)' }}> · panning</span>
          )}
        </div>
      </div>

      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        {/* Tool rail */}
        <div
          style={{
            width: 52, flexShrink: 0, background: 'var(--panel-bg)',
            borderRight: '1px solid var(--border)', padding: '8px 0',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            // Anchors the tooltips, which sit outside the rail's right edge.
            position: 'relative',
          }}
          onMouseLeave={() => setHoveredTool(null)}
        >
          {TOOLS.map(({ key, label, hotkey }, i) => (
            <Fragment key={key}>
              {/* Pan and crop above the rule, painting below it. */}
              {i === PAINT_RULE_INDEX && (
                <div style={{
                  width: 28, height: 1, background: 'var(--border)', margin: '4px 0', flexShrink: 0,
                }} />
              )}
              <ToolButton
                icon={ICONS[key]}
                label={label}
                hotkey={hotkey}
                active={tool === key}
                showTip={hoveredTool === key}
                onHover={(on) => setHoveredTool(on ? key : null)}
                onClick={() => setTool(key)}
              />
            </Fragment>
          ))}
        </div>

        {/* Canvas */}
        <div
          ref={viewportRef}
          style={{
            flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden',
            background: 'var(--bg)',
            cursor: isPanning ? 'grab' : 'crosshair',
            touchAction: 'none', userSelect: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => { cursorRef.current = null; drawOverlay() }}
          onWheel={onWheel}
        >
          <canvas ref={displayRef} style={{ position: 'absolute', inset: 0 }} />
          <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
        </div>
      </div>

      {/* Status bar — view state on the left, document actions on the right */}
      <div
        className="flex items-center"
        style={{
          background: 'var(--panel-bg)', borderTop: '1px solid var(--border)',
          padding: '8px 14px', gap: 12, flexShrink: 0,
        }}
      >
        <div className="flex items-center" style={{ gap: 6 }}>
          <span className="val-mono" style={{ width: 52, textAlign: 'right' }}>
            {(zoom * 100).toFixed(0)}%
          </span>
          <button
            className="btn-icon" style={{ width: 26, height: 24, padding: 0, fontSize: 14 }}
            onClick={() => zoomByButton(1 / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            title="Zoom out"
          >
            −
          </button>
          <button
            className="btn-icon" style={{ width: 26, height: 24, padding: 0, fontSize: 14 }}
            onClick={() => zoomByButton(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            title="Zoom in"
          >
            +
          </button>
          <button
            className="btn-icon" style={{ height: 24 }}
            onClick={fitToView}
            title="Fit the whole map in the view"
          >
            Fit
          </button>
        </div>

        <Divider />

        <button
          className="btn-icon" style={{ height: 24, gap: 6 }}
          onClick={undo} disabled={undoDepth === 0}
          title={`Undo (Ctrl+Z) — last ${UNDO_LIMIT} steps kept`}
        >
          ⟲ Undo
          <span className="val-mono" style={{ color: 'var(--text-dim)' }}>{undoDepth}</span>
        </button>

        <Divider />

        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Scroll to zoom · hold Space to pan · Ctrl+Z to undo
        </span>

        <div style={{
          marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: '#EF4444',
        }}>
          {error}
        </div>
        <div className="flex gap-3">
          <button
            className="btn-icon px-4 py-1.5 text-xs"
            onClick={() => (dirty ? setConfirmCancel(true) : onClose())}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="btn-icon px-4 py-1.5 text-xs"
            onClick={() => requestWrite(mapName)}
            disabled={busy || !mapName}
            title={mapName ? undefined : 'This map has no name yet — use Save as'}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="px-4 py-1.5 rounded text-xs font-medium"
            style={{
              background: 'var(--accent-bright)', color: '#fff',
              fontFamily: 'var(--font-mono)', border: 'none',
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1,
            }}
            // Only a brand-new map gets the date seed; re-saving an existing one keeps its
            // own name so the operator does not accidentally fork it under a new date.
            onClick={() => setNamePrompt({ value: mapName ?? defaultMapName(source.pcdName) })}
            disabled={busy}
          >
            Save as ▶
          </button>
        </div>
      </div>

      {namePrompt && (
        <NamePromptModal
          prompt={namePrompt}
          setPrompt={setNamePrompt}
          valid={nameValid}
          // Same rule as the .pcd upload: warn, then let them through. Re-cutting a map under
          // its existing name is a normal thing to want.
          overwrites={nameValid && namePrompt.value !== mapName &&
            existingNames.includes(namePrompt.value)}
          busy={busy}
          onConfirm={() => requestWrite(namePrompt.value)}
        />
      )}

      {confirmReplace && (
        <Scrim>
          <Card title={`Replace ${confirmReplace} with the cropped area?`}>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>
              {confirmReplace} is {savedRef.current.width} × {savedRef.current.height} px; saving
              replaces it with this {shown.width} × {shown.height} px area, and the rest is lost from{' '}
              {confirmReplace}.png. Use Save as to keep both.
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              A robot with {confirmReplace} loaded keeps the old one until it loads it again.
            </div>
            <div className="flex gap-3 justify-end mt-1">
              <button
                className="btn-icon px-4 py-1.5 text-xs"
                onClick={() => setConfirmReplace(null)}
                disabled={busy}
                autoFocus
              >
                Keep editing
              </button>
              <button
                className="btn-icon px-4 py-1.5 text-xs"
                style={{ borderColor: '#DC2626', color: '#DC2626' }}
                onClick={() => writeMap(confirmReplace)}
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Replace ▶'}
              </button>
            </div>
          </Card>
        </Scrim>
      )}

      {confirmCancel && (
        <Scrim>
          <Card title="Discard unsaved changes?">
            <div style={{ fontSize: 13, color: 'var(--text)' }}>
              Everything painted since the last save will be lost. On a map created from a .pcd
              that means starting the edit over from the flattened grid.
            </div>
            <div className="flex gap-3 justify-end mt-1">
              <button className="btn-icon px-4 py-1.5 text-xs" onClick={() => setConfirmCancel(false)} autoFocus>
                Keep editing
              </button>
              <button
                className="btn-icon px-4 py-1.5 text-xs"
                style={{ borderColor: '#DC2626', color: '#DC2626' }}
                onClick={() => { setConfirmCancel(false); onClose() }}
              >
                Discard
              </button>
            </div>
          </Card>
        </Scrim>
      )}
    </div>
  )
}

function NamePromptModal({ prompt, setPrompt, valid, overwrites, busy, onConfirm }) {
  return (
    <Scrim>
      <Card title={overwrites ? 'Overwrite existing map' : 'Save map as'}>
        <input
          value={prompt.value}
          autoFocus
          onChange={(e) => setPrompt({ ...prompt, value: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) onConfirm() }}
          placeholder="e.g. warehouse_floor_2"
          className="val-mono"
          style={{
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
            padding: '6px 8px', fontSize: 12, color: 'var(--text-h)',
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Letters, numbers and underscores only — the name becomes a ROS map name and a filename.
        </div>
        {prompt.value.length > 0 && !valid && (
          <div style={{ fontSize: 11, color: '#EF4444' }}>Invalid name.</div>
        )}
        {overwrites && (
          <div style={{ fontSize: 12, color: '#EF4444' }}>
            <span style={{ marginRight: 4 }}>⚠</span>
            <strong>&quot;{prompt.value}&quot; already exists.</strong> Saving replaces both{' '}
            {prompt.value}.png and {prompt.value}.yaml on disk. This cannot be undone.
          </div>
        )}
        <div className="flex gap-3 justify-end mt-1">
          <button className="btn-icon px-4 py-1.5 text-xs" onClick={() => setPrompt(null)} disabled={busy}>
            Cancel
          </button>
          <button
            className="px-4 py-1.5 rounded text-xs font-medium"
            style={{
              background: overwrites ? '#DC2626' : 'var(--accent-bright)', color: '#fff',
              fontFamily: 'var(--font-mono)',
              border: 'none', cursor: !valid || busy ? 'not-allowed' : 'pointer',
              opacity: !valid || busy ? 0.5 : 1,
            }}
            onClick={onConfirm}
            disabled={!valid || busy}
          >
            {busy ? 'Saving…' : (overwrites ? 'Overwrite ▶' : 'Save ▶')}
          </button>
        </div>
      </Card>
    </Scrim>
  )
}

// Icon-only, 40x40, with the name in a tooltip. NOT the native `title` attribute: that waits
// about a second before showing and is styled by the OS, which is the wrong trade on the one
// control whose label has been taken away.
function ToolButton({ icon, label, hotkey, active, showTip, onHover, onClick }) {
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={onClick}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        // Focus as well as hover, so the rail is usable from the keyboard.
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        aria-label={`${label} (${hotkey})`}
        aria-pressed={active}
        style={{
          width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 5, cursor: 'pointer',
          // Filled when active rather than merely outlined: at icon size a border tint is not
          // enough to find the current tool at a glance. showTip doubles as "is hovered or
          // focused" -- deriving the hover tint from it keeps this a pure render, where
          // mutating style.background from a mouse handler would be undone by the very
          // re-render that showTip triggers.
          background: active ? 'var(--accent)' : (showTip ? 'var(--border)' : 'transparent'),
          border: `1px solid ${active ? 'var(--accent-bright)' : 'transparent'}`,
          // White, not --text-h: --accent is the same dark purple in both themes, and --text-h
          // goes near-black in light mode, which would be unreadable on it.
          color: active ? '#FFFFFF' : (showTip ? 'var(--text-h)' : 'var(--text)'),
          transition: 'background 0.12s, color 0.12s, border-color 0.12s',
        }}
      >
        <svg
          width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        >
          {icon}
        </svg>
      </button>

      {showTip && (
        <div
          role="tooltip"
          style={{
            position: 'absolute', left: 46, top: '50%', transform: 'translateY(-50%)',
            zIndex: 55, whiteSpace: 'nowrap', pointerEvents: 'none',
            background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 4,
            padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 11,
            color: 'var(--text-h)', boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}
        >
          {label} <span style={{ color: 'var(--text-dim)' }}>{hotkey}</span>
        </div>
      )}
    </div>
  )
}

function Divider() {
  return (
    <div style={{ width: 1, height: 20, background: 'var(--border)', flexShrink: 0 }} />
  )
}

// zIndex inline rather than a Tailwind z-* class: the editor shell is already z-50 and these
// have to sit above it, which is outside Tailwind's default scale.
function Scrim({ children }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 60, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      role="dialog"
      aria-modal="true"
    >
      {children}
    </div>
  )
}

function Card({ title, children }) {
  return (
    <div
      className="rounded-lg p-6 w-80 flex flex-col gap-4"
      style={{ background: 'var(--panel-bg)', border: '1px solid var(--accent)' }}
    >
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-dim)',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}
