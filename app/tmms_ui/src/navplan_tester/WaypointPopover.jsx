import { useLayoutEffect, useRef, useState } from 'react'
import { degFromYaw } from './lib/quat'
import { TYPES, TYPE_LABEL } from './lib/routePlan'
import { SWITCH_TEXT } from './lib/routeStyle'
import { MarqueeText } from './MarqueeText'
import { TypeGlyph } from './TypeGlyph'

// Wide enough for a map name to show whole, which is what linking a map switch is read by.
const WIDTH = 460
// Clear of C2MapCanvas's heading handle, which orbits the selected pin at 48 px.
const OFFSET_PX = 64
const MARGIN = 8

const WARN = '#FBBF24'
const HEADING_TYPES = new Set(['poi', 'home', 'map_switch'])
// Map names have no spaces to break at; let them wrap anywhere rather than overflow.
const WRAP = { overflowWrap: 'anywhere' }

function Button({ children, onClick, active, disabled, tone, style }) {
  return (
    <button
      className="btn-icon"
      disabled={disabled}
      onClick={onClick}
      style={{
        fontSize: 12, padding: '7px 8px', display: 'flex', alignItems: 'center', gap: 6,
        borderColor: active ? 'var(--accent-bright)' : tone,
        color: tone,
        background: active ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : undefined,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// Non-modal, so the pin underneath can still be dragged while it is open.
export function WaypointPopover({
  anchor, bounds, mapName, row, step, locked, partner, partnerStep, arrival, candidates,
  poi, onType, onLink, onUnlink, onSwap, onDelete, onAddPoi, onPhotos, onClose,
}) {
  // Measured, so a tall card is kept inside the canvas rather than guessed at.
  const boxRef = useRef(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    const measure = () => setHeight(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const left = anchor.x + OFFSET_PX + WIDTH > bounds.width
    ? Math.max(MARGIN, anchor.x - OFFSET_PX - WIDTH)
    : anchor.x + OFFSET_PX
  const top = Math.max(MARGIN, Math.min(anchor.y - 40, bounds.height - height - MARGIN))

  const header = (title) => (
    <div className="panel-header" style={{ fontSize: 12 }}>
      <span>{title}</span>
      <button className="btn-icon" style={{ fontSize: 12, padding: '0 8px' }} onClick={onClose}>✕</button>
    </div>
  )

  const banner = (
    <MarqueeText
      text={mapName}
      style={{
        fontSize: 13, fontWeight: 600, padding: '6px 12px', color: 'var(--text-h)',
        background: 'color-mix(in srgb, var(--accent-bright) 22%, transparent)',
        borderBottom: '1px solid var(--border)',
      }}
    />
  )

  return (
    <div
      ref={boxRef}
      className="panel"
      style={{
        position: 'absolute', left, top, width: WIDTH, zIndex: 6,
        maxHeight: bounds.height - 2 * MARGIN, overflowY: 'auto',
        boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
      }}
    >
      {poi ? (
        <>
          {header(`POI #${poi.poiId} · from the map.yaml`)}
          {banner}
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <MarqueeText text={poi.label} style={{ fontSize: 13, color: 'var(--text-h)' }} />
            <div className="val-mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {poi.x.toFixed(2)}, {poi.y.toFixed(2)} · {degFromYaw(poi.yaw).toFixed(0)}°
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={onAddPoi} style={{ flex: 1, justifyContent: 'center' }}>＋ Add to route</Button>
              <Button onClick={onPhotos} style={{ flex: 1, justifyContent: 'center' }}>Photos</Button>
            </div>
          </div>
        </>
      ) : (
        <>
          {header(`#${step} · ${TYPE_LABEL[row.type]}`)}
          {banner}
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {row.label && <MarqueeText text={row.label} style={{ fontSize: 13, color: 'var(--text-h)' }} />}
            <div className="val-mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {row.x.toFixed(2)}, {row.y.toFixed(2)}
              {row.type !== 'simple' && (row.headingSet
                ? ` · ${degFromYaw(row.yaw).toFixed(0)}°`
                : ' · heading not set')}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {TYPES.map((t) => (
                <Button key={t} active={row.type === t} disabled={locked} onClick={() => onType(t)}>
                  <TypeGlyph type={t} size={15} />
                  {TYPE_LABEL[t]}
                </Button>
              ))}
            </div>
            {locked && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                From the map.yaml: its type, pose and heading are fixed.
              </div>
            )}

            {HEADING_TYPES.has(row.type) && !locked && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Drag the ring around the pin to turn it. Hold Shift to snap to 15°.
              </div>
            )}

            {row.type === 'map_switch' && (
              <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {partner ? (
                  <>
                    <div style={{ color: SWITCH_TEXT, ...WRAP }}>
                      {arrival
                        ? `Relocalizes here, after stopping at #${partnerStep} on ${partner.map}.`
                        : `Stops here, then relocalizes at #${partnerStep} on ${partner.map}.`}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button onClick={onSwap} style={{ flex: 1, justifyContent: 'center' }}>⇅ Swap direction</Button>
                      <Button onClick={onUnlink} style={{ flex: 1, justifyContent: 'center' }}>Unlink</Button>
                    </div>
                  </>
                ) : candidates.length ? (
                  <>
                    <div style={{ color: 'var(--text-dim)' }}>
                      Link with its pair. This pin moves to right after it.
                    </div>
                    {candidates.map(({ row: c, step: s }) => (
                      <Button key={c.id} tone={SWITCH_TEXT} onClick={() => onLink(c.id)} style={{ textAlign: 'left' }}>
                        <TypeGlyph type="map_switch" size={15} unlinked />
                        <span style={{ minWidth: 0, ...WRAP }}>
                          #{s} on <b>{c.map}</b> · {c.x.toFixed(1)}, {c.y.toFixed(1)}
                        </span>
                      </Button>
                    ))}
                  </>
                ) : (
                  <div style={{ color: WARN }}>
                    Unlinked. Plot its pair on the other map and make that a map switch too.
                  </div>
                )}
              </div>
            )}

            <Button tone="#F87171" onClick={onDelete} style={{ justifyContent: 'center' }}>Delete</Button>
          </div>
        </>
      )}
    </div>
  )
}
