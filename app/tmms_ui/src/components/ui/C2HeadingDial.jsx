import { useRef } from 'react'
import { degFromYaw } from '../../lib/c2Coords'

export function C2HeadingDial({ yaw, isSet, onChange, onClear, disabled = false }) {
  const svgRef = useRef(null)
  const size = 72
  const c = size / 2
  const r = c - 8

  const degrees = degFromYaw(yaw ?? 0)

  const angleFrom = (ev) => {
    const rect = svgRef.current.getBoundingClientRect()
    const dx = ev.clientX - (rect.left + rect.width / 2)
    const dy = ev.clientY - (rect.top + rect.height / 2)
    let next = Math.atan2(-dy, dx)
    if (ev.shiftKey) {
      const step = Math.PI / 12
      next = Math.round(next / step) * step
    }
    return next
  }

  const beginDrag = (ev) => {
    if (disabled) return
    ev.preventDefault()
    onChange(angleFrom(ev))
    const move = (e) => onChange(angleFrom(e))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const tipX = c + Math.cos(-(yaw ?? 0)) * r
  const tipY = c + Math.sin(-(yaw ?? 0)) * r
  const stroke = isSet ? 'var(--accent-bright)' : 'var(--text-dim)'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <svg
          ref={svgRef}
          width={size}
          height={size}
          onMouseDown={beginDrag}
          style={{ cursor: disabled ? 'not-allowed' : 'grab', flexShrink: 0, touchAction: 'none', opacity: disabled ? 0.5 : 1 }}
          role="slider"
          aria-label="Facing, degrees"
          aria-valuenow={degrees}
          aria-valuemin={0}
          aria-valuemax={359}
        >
          <circle cx={c} cy={c} r={r} fill="var(--bg)" stroke="var(--border)" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4
            return (
              <line
                key={i}
                x1={c + Math.cos(a) * (r - 3)} y1={c - Math.sin(a) * (r - 3)}
                x2={c + Math.cos(a) * r} y2={c - Math.sin(a) * r}
                stroke="var(--border)" strokeWidth="1.5"
              />
            )
          })}
          <line
            x1={c} y1={c} x2={tipX} y2={tipY}
            stroke={stroke} strokeWidth="2.2" strokeLinecap="round"
            strokeDasharray={isSet ? undefined : '3 3'}
            opacity={isSet ? 1 : 0.6}
          />
          <circle cx={tipX} cy={tipY} r="4" fill={stroke} opacity={isSet ? 1 : 0.6} />
          <circle cx={c} cy={c} r="2" fill="var(--text-dim)" />
        </svg>

        <div className="flex flex-col gap-1" style={{ minWidth: 0 }}>
          <div className="flex items-center gap-1">
            <input
              type="number"
              disabled={disabled}
              value={degrees}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) onChange(((n % 360) * Math.PI) / 180)
              }}
              className="val-mono"
              style={{
                width: 56, padding: '4px 6px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--bg)',
                color: isSet ? 'var(--text-h)' : 'var(--text-dim)', fontSize: 11, outline: 'none',
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>°</span>
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.35 }}>
            0° = map +X,<br />counter-clockwise
          </span>
        </div>
      </div>

      {isSet ? (
        <button
          className="btn-icon"
          style={{ fontSize: 11, padding: '4px 8px', alignSelf: 'flex-start' }}
          onClick={onClear}
          disabled={disabled}
        >
          Clear facing
        </button>
      ) : (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4 }}>
          Not set — drag the dial, or the ring handle on the map. Hold Shift to snap to 15°.
        </div>
      )}
    </div>
  )
}
