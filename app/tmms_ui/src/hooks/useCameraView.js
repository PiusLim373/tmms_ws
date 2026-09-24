import { useRef, useState, useCallback, useEffect } from 'react'

// Zoom ceiling as a multiple of the fit scale, so it means the same thing on a 640x480
// feed as on the 780x1040 topdown one.
const MAX_ZOOM = 8
const WHEEL_STEP = 1.15

// Pan/zoom for a camera canvas, driven entirely by a CSS transform so the decode path in
// useCameraFeed is untouched — the canvas keeps its intrinsic bitmap size and the GPU does
// the scaling. Mirrors MapEditorModal's view model: state lives in a ref and is written to
// the element imperatively, because a drag samples far faster than React should re-render.
//
// transformOrigin must be '0 0' on the canvas for zoomAbout's arithmetic to hold.
export function useCameraView(canvasRef, frameSize) {
  const { width: frameW, height: frameH } = frameSize

  const viewportRef = useRef(null)
  const viewRef = useRef({ scale: 1, x: 0, y: 0 })
  const fitRef = useRef(1)
  const dragRef = useRef(null)

  const [scale, setScale] = useState(1)
  const [atFit, setAtFit] = useState(true)

  const apply = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { scale: s, x, y } = viewRef.current
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${s})`
  }, [canvasRef])

  // Largest scale that shows the whole frame, centred — this is what Reset View returns to,
  // and it doubles as the minimum zoom so the image can never be smaller than its panel.
  const measureFit = useCallback(() => {
    const vp = viewportRef.current
    if (!vp || !frameW || !frameH) return null
    const { width: cw, height: ch } = vp.getBoundingClientRect()
    if (!cw || !ch) return null
    const s = Math.min(cw / frameW, ch / frameH)
    fitRef.current = s
    return { s, cw, ch }
  }, [frameW, frameH])

  const reset = useCallback(() => {
    const m = measureFit()
    if (!m) return
    viewRef.current = {
      scale: m.s,
      x: (m.cw - frameW * m.s) / 2,
      y: (m.ch - frameH * m.s) / 2,
    }
    setScale(m.s)
    setAtFit(true)
    apply()
  }, [measureFit, frameW, frameH, apply])

  // Keeps the point under (mx, my) pinned while the scale changes — anchoring on the centre
  // instead would walk whatever you are looking at out of the panel.
  const zoomAbout = useCallback((mx, my, factor) => {
    const { scale: s, x, y } = viewRef.current
    const min = fitRef.current
    const next = Math.min(min * MAX_ZOOM, Math.max(min, s * factor))
    if (next === s) return
    viewRef.current = {
      scale: next,
      x: mx - (mx - x) * (next / s),
      y: my - (my - y) * (next / s),
    }
    setScale(next)
    setAtFit(false)
    apply()
  }, [apply])

  const onWheel = useCallback((e) => {
    const vp = viewportRef.current
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    zoomAbout(
      e.clientX - rect.left,
      e.clientY - rect.top,
      e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
    )
  }, [zoomAbout])

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    const vp = viewportRef.current
    if (!vp) return
    dragRef.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: viewRef.current.x,
      oy: viewRef.current.y,
    }
    // Capture keeps the drag alive past the panel edge. Never let it throw: losing the
    // capture is survivable, a handler that dies mid-teleop is not.
    try { vp.setPointerCapture(e.pointerId) } catch { /* no capture; drag still tracks */ }
  }, [])

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    viewRef.current = {
      ...viewRef.current,
      x: d.ox + (e.clientX - d.sx),
      y: d.oy + (e.clientY - d.sy),
    }
    setAtFit(false)
    apply()
  }, [apply])

  const onPointerUp = useCallback((e) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    const vp = viewportRef.current
    if (vp?.hasPointerCapture?.(e.pointerId)) vp.releasePointerCapture(e.pointerId)
  }, [])

  // Fit once the frame's real size is known, i.e. on the first decoded frame of a stream.
  useEffect(() => { reset() }, [reset])

  // These panels are user-resizable via ResizeHandle. Re-fit only while the operator is
  // already at fit; once they have zoomed in, dragging a panel edge must not throw away
  // the view they were lining up. The fit scale is still refreshed so Reset and the lower
  // clamp stay correct.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const ro = new ResizeObserver(() => {
      if (atFit) {
        reset()
        return
      }
      const m = measureFit()
      if (m && viewRef.current.scale < m.s) {
        viewRef.current = { ...viewRef.current, scale: m.s }
        setScale(m.s)
        apply()
      }
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [atFit, reset, measureFit, apply])

  return {
    viewportRef,
    scale,
    atFit,
    reset,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  }
}
