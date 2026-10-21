import { useLayoutEffect, useRef, useState } from 'react'
import { degFromYaw } from '../../lib/c2Coords'
import { HEADING_TYPES, PIN_META, PIN_TYPES } from '../../lib/c2Pins'
import { MarqueeText } from '../../navplan_tester/MarqueeText'
import { SWITCH_TEXT } from '../../navplan_tester/lib/routeStyle'
import { C2PinGlyph } from '../ui/C2PinGlyph'

// The navplan tester's WaypointPopover, for C2's graph pins. Same card and wording; there is
// no "Swap direction" because a link is not a direction here -- Dijkstra picks which way the
// route crosses.

// Wide enough for a map name to show whole, which is what linking a map switch is read by.
const WIDTH = 460
// Clear of C2MapCanvas's heading handle, which orbits the selected pin at 48 px.
const OFFSET_PX = 64
const MARGIN = 8

const WARN = '#FBBF24'
// Map names have no spaces to break at; let them wrap anywhere rather than overflow.
const WRAP = { overflowWrap: 'anywhere' }

function Button({ children, onClick, active, disabled, tone, title, style }) {
  return (
    <button
      className="btn-icon"
      disabled={disabled}
      onClick={onClick}
      title={title}
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
export function C2PinPopover({
  anchor, bounds, mapName, pin, name, step, editable, homeTaken, partner, candidates,
  turnInfo, onLineUp, onType, onLink, onUnlink, onDelete, onClose, inline = false,
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
  const off = !editable

  // Type, heading hint and linking: shared by the floating card and the side panel (inline).
  // Linking, for a Map Switch: all the side panel shows (inline); the card shows it too.
  const linkBlock = (
    pin.type === 'map_switch' && (
      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {partner ? (
          <>
            <div style={{ color: SWITCH_TEXT, ...WRAP }}>
              Linked to {partner.name} on {partner.map}. A route crossing here stops on this
              pin, then relocalizes on that one. The two share one heading: turn either and the
              other follows.
            </div>
            {turnInfo && (turnInfo.fromPins ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
                <div style={{ color: '#4ADE80', ...WRAP }}>
                  ✓ How these two maps are turned is worked out from {turnInfo.pairs} linked pairs:
                  {' '}{turnInfo.to} is turned {turnInfo.turnDeg}° from {turnInfo.from}. No ↻ needed.
                </div>
                {turnInfo.mismatchM > 0.2 && (
                  <div style={{ color: WARN, ...WRAP }}>
                    ⚠ The switches are {turnInfo.mismatchM.toFixed(2)} m further apart on one map than on
                    the other: one of them is not at the same spot on both maps, so the turn may be off.
                  </div>
                )}
                {!turnInfo.linedUp && (
                  <Button disabled={off} onClick={() => onLineUp(turnInfo)} style={{ justifyContent: 'center' }}>
                    ↻ Line up {turnInfo.to} with {turnInfo.from}, to check by eye
                  </Button>
                )}
              </div>
            ) : null)}
            <Button disabled={off} onClick={onUnlink} style={{ justifyContent: 'center' }}>Unlink</Button>
          </>
        ) : candidates.length ? (
          <>
            <div style={{ color: 'var(--text-dim)' }}>Link with its pair.</div>
            {candidates.map((c) => (
              <Button
                key={c.id}
                tone={SWITCH_TEXT}
                disabled={off}
                onClick={() => onLink(c)}
                style={{ textAlign: 'left' }}
              >
                <C2PinGlyph type="map_switch" size={15} unpaired />
                <span style={{ minWidth: 0, ...WRAP }}>
                  {c.name} on <b>{c.map}</b> · {c.x.toFixed(1)}, {c.y.toFixed(1)}
                </span>
              </Button>
            ))}
          </>
        ) : (
          <div style={{ color: WARN }}>
            Unlinked. Place a Map Switch at the same spot on another map of this route, then
            link the two.
          </div>
        )}
      </div>
    )
  )

  const details = (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      {PIN_TYPES.map((t) => {
        const taken = t === 'home' && homeTaken && pin.type !== 'home'
        return (
          <Button
            key={t}
            active={pin.type === t}
            disabled={off || taken}
            title={taken ? 'This route already has a Home' : PIN_META[t].hint}
            onClick={() => onType(t)}
          >
            <C2PinGlyph type={t} size={15} />
            {PIN_META[t].label}
          </Button>
        )
      })}
    </div>
    {off && (
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        Expand this map to change the pin.
      </div>
    )}

    {HEADING_TYPES.has(pin.type) && !off && (
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        Drag the ring around the pin to turn it. Hold Shift to snap to 15°.
      </div>
    )}

    {linkBlock}
    </>
  )
  if (inline) return linkBlock || null

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
      <div className="panel-header" style={{ fontSize: 12 }}>
        <span>#{step} · {PIN_META[pin.type]?.label.toUpperCase()}</span>
        <button className="btn-icon" style={{ fontSize: 12, padding: '0 8px' }} onClick={onClose}>✕</button>
      </div>
      <MarqueeText
        text={mapName}
        style={{
          fontSize: 13, fontWeight: 600, padding: '6px 12px', color: 'var(--text-h)',
          background: 'color-mix(in srgb, var(--accent-bright) 22%, transparent)',
          borderBottom: '1px solid var(--border)',
        }}
      />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <MarqueeText text={name} style={{ fontSize: 13, color: 'var(--text-h)' }} />
        <div className="val-mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {pin.x.toFixed(2)}, {pin.y.toFixed(2)}
          {pin.type !== 'simple' && (pin.headingSet
            ? ` · ${degFromYaw(pin.yaw)}°`
            : ' · heading not set')}
        </div>

        {details}

        <Button tone="#F87171" disabled={off} onClick={onDelete} style={{ justifyContent: 'center' }}>Delete</Button>
      </div>
    </div>
  )
}
