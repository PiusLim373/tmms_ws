import { useCallback } from 'react'

// direction: 'v' = horizontal bar between rows (adjusts height split, row-resize cursor)
//            'h' = vertical bar between columns (adjusts width split, col-resize cursor)
// containerRef: ref on the parent flex container
// onResize(pct): called during drag with clamped [min, max] fractional position
export function ResizeHandle({ direction, containerRef, onResize, min = 0.15, max = 0.85 }) {
  const handleMouseDown = useCallback((e) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()

    // An iframe eats the mouse events over it, so a drag crossing the Lichtblick pane would
    // stall the moment the cursor touched it. This lid sits above everything for the duration
    // of the drag, keeping every mousemove on window.
    const lid = document.createElement('div')
    lid.style.cssText = 'position:fixed;inset:0;z-index:9999;'
      + `cursor:${direction === 'v' ? 'row-resize' : 'col-resize'}`
    document.body.appendChild(lid)

    const onMove = (me) => {
      const raw = direction === 'v'
        ? (me.clientY - rect.top)  / rect.height
        : (me.clientX - rect.left) / rect.width
      onResize(Math.min(max, Math.max(min, raw)))
    }
    const onUp = () => {
      lid.remove()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [containerRef, direction, onResize, min, max])

  const isVertical = direction === 'v'

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        flexShrink: 0,
        cursor: isVertical ? 'row-resize' : 'col-resize',
        background: 'var(--border)',
        transition: 'background 0.1s',
        ...(isVertical
          ? { width: '100%', height: 4 }
          : { width: 4, height: '100%' }),
        position: 'relative',
        zIndex: 10,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--border)' }}
    />
  )
}
