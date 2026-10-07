import { useRef, useState } from 'react'
import { pixelToWorld, worldToPixel } from '../lib/c2Coords'
import { camOfSnapshot, map2dSnapshotUrl } from '../lib/poi'

export const POI_COLOR = '#3B82F6'

const GLYPH = 13          // half-diagonal of the diamond, px
const RING = 28           // half-diagonal of the ring drawn around a route pin (radius 14)
const ARROW = 30          // same heading arrow as C2MapCanvas's drawHeadingArrow
const WING = 7
const BOX = 2 * (ARROW + 8)
const DRAG_PX = 4

// Points of interest, laid over C2MapCanvas as DOM rather than drawn into it: that canvas
// belongs to the C2 work and only knows its own pin types. The layer itself takes no pointer
// events, so clicks, drags and wheel on the map still reach the canvas; only the markers
// answer, and a wheel over one is handed on to the canvas so zoom keeps working there.
//
// A POI already in the route is drawn as a ring around its route pin (stroke-only hit area),
// so the pin's number stays visible and the pin itself stays clickable.
//
// props: info, view, mapName, pois (yaw in radians), linked (Set of POI ids in the route),
//        onMove(id, world), onOpen(id)
export function PoiLayer({ info, view, mapName, pois, linked, onMove, onOpen }) {
  const rootRef = useRef(null)
  const dragRef = useRef(null)
  const [hoverId, setHoverId] = useState(null)

  if (!info) return null

  const toScreen = (x, y) => {
    const p = worldToPixel(x, y, info)
    return { x: view.x + p.x * view.scale, y: view.y + p.y * view.scale }
  }
  const toWorld = (e) => {
    const rect = rootRef.current.getBoundingClientRect()
    return pixelToWorld(
      (e.clientX - rect.left - view.x) / view.scale,
      (e.clientY - rect.top - view.y) / view.scale, info)
  }

  const handlers = (id) => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { id, x: e.clientX, y: e.clientY, moved: false }
    },
    onPointerMove: (e) => {
      const d = dragRef.current
      if (!d || d.id !== id) return
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX) {
        d.moved = true
        setHoverId(null)
      }
      if (d.moved) onMove(id, toWorld(e))
    },
    onPointerUp: (e) => {
      const d = dragRef.current
      dragRef.current = null
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      if (d && d.id === id && !d.moved) onOpen(id)
    },
    onPointerEnter: () => { if (!dragRef.current) setHoverId(id) },
    onPointerLeave: () => setHoverId((h) => (h === id ? null : h)),
    onWheel: (e) => {
      const canvas = rootRef.current?.parentElement?.querySelector('canvas')
      canvas?.dispatchEvent(new WheelEvent('wheel', {
        clientX: e.clientX, clientY: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY,
        deltaMode: e.deltaMode, bubbles: true, cancelable: true,
      }))
    },
  })

  const hovered = pois.find((p) => p.id === hoverId)

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {pois.map((p) => {
        const s = toScreen(p.x, p.y)
        const inRoute = linked.has(p.id)
        const c = BOX / 2
        // Screen angle: y points down, so the heading is drawn at -yaw.
        const a = -p.yaw
        const tipX = c + Math.cos(a) * ARROW
        const tipY = c + Math.sin(a) * ARROW
        const head = [a - 0.45, a + 0.45]
          .map((w) => `${tipX - Math.cos(w) * WING},${tipY - Math.sin(w) * WING}`)
          .join(' ')
        const diamond = (r) => `${c},${c - r} ${c + r},${c} ${c},${c + r} ${c - r},${c}`
        return (
          <div key={p.id} style={{ position: 'absolute', left: s.x - c, top: s.y - c, width: BOX, height: BOX }}>
            <svg width={BOX} height={BOX} style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
              {/* In the route, the route pin's own arrow already shows this heading. */}
              {!inRoute && (
                <>
                  <line
                    x1={c} y1={c} x2={tipX} y2={tipY}
                    stroke={POI_COLOR} strokeWidth="2.5" strokeLinecap="round"
                  />
                  <polygon points={`${tipX},${tipY} ${head}`} fill={POI_COLOR} />
                </>
              )}
              {inRoute ? (
                <>
                  <polygon points={diamond(RING)} fill="none" stroke="#FFFFFF" strokeWidth="6" />
                  <polygon points={diamond(RING)} fill="none" stroke={POI_COLOR} strokeWidth="3.5" />
                  <polygon
                    points={diamond(RING)} fill="none" stroke="transparent" strokeWidth="12"
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    {...handlers(p.id)}
                  />
                </>
              ) : (
                <>
                  <polygon
                    points={diamond(GLYPH)} fill={POI_COLOR} stroke="#FFFFFF" strokeWidth="2.2"
                    style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}
                  />
                  <text
                    x={c} y={c + 0.5} textAnchor="middle" dominantBaseline="middle"
                    fill="#FFFFFF" fontSize="10" fontWeight="700" fontFamily="Inter, system-ui, sans-serif"
                  >
                    {p.id}
                  </text>
                  <circle
                    cx={c} cy={c} r={GLYPH + 4} fill="transparent"
                    style={{ pointerEvents: 'all', cursor: 'pointer' }}
                    {...handlers(p.id)}
                  />
                </>
              )}
            </svg>
            {/* A route pin already shows the name above itself, so only a free POI labels itself. */}
            {!inRoute && (
              <div
                className="val-mono"
                style={{
                  position: 'absolute', top: c + GLYPH + 4, left: '50%', transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                  color: '#FFFFFF', background: 'rgba(11, 7, 16, 0.88)', border: `1px solid ${POI_COLOR}`,
                }}
              >
                {p.name}
              </div>
            )}
          </div>
        )
      })}

      {hovered && <HoverCard poi={hovered} at={toScreen(hovered.x, hovered.y)} mapName={mapName} root={rootRef.current} />}
    </div>
  )
}

function HoverCard({ poi, at, mapName, root }) {
  const width = 300
  const rect = root?.getBoundingClientRect()
  // Flipped to the other side of the marker when it would run off the map.
  const left = rect && at.x + 24 + width > rect.width ? at.x - 24 - width : at.x + 24
  const top = Math.max(8, Math.min(at.y - 20, (rect?.height ?? 0) - 230))
  return (
    <div
      className="panel"
      style={{
        position: 'absolute', left, top, width, padding: 8, pointerEvents: 'none', zIndex: 5,
        display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
      }}
    >
      <div className="val-mono" style={{ fontSize: 12, color: 'var(--text-h)' }}>
        <span style={{ color: POI_COLOR }}>#{poi.id}</span> {poi.name}
      </div>
      {poi.description && (
        <div style={{
          fontSize: 11, color: 'var(--text)', display: '-webkit-box', WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap',
        }}
        >
          {poi.description}
        </div>
      )}
      {poi.snapshots.length > 0 ? (
        <div style={{ display: 'flex', gap: 4 }}>
          {poi.snapshots.map((f) => (
            <img
              key={f}
              src={map2dSnapshotUrl(mapName, f)}
              alt={camOfSnapshot(f)}
              style={{ flex: 1, minWidth: 0, height: 120, objectFit: 'cover', borderRadius: 3, background: '#000' }}
            />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>No snapshots.</div>
      )}
      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Click to open · drag to move</div>
    </div>
  )
}
