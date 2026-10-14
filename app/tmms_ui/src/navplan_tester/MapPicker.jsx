import { useEffect, useRef, useState } from 'react'
import { TONE } from './lib/tone'

function Dot({ on }) {
  return (
    <span
      style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: on ? TONE.ok : 'var(--border)',
      }}
    />
  )
}

// Which map the canvas shows, and nothing else. Browsing only: picking one never moves the robot.
export function MapPicker({ maps, value, robotMap, counts, disabled, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const shown = open && !disabled

  useEffect(() => {
    if (!shown) return undefined
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false) }
    // Capture, so the page's own Escape (cancel relocalize, deselect) does not fire as well.
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [shown])

  const count = value ? counts.get(value) : 0

  return (
    <div ref={rootRef} className="npt-card" style={{ position: 'relative' }}>
      <button
        className="npt-picker-btn val-mono"
        aria-haspopup="listbox"
        aria-expanded={shown}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 10px 0 12px',
          border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12,
        }}
      >
        <span style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-dim)' }}>MAP</span>
        <Dot on={Boolean(value) && value === robotMap} />
        <span style={{ whiteSpace: 'nowrap', color: value ? 'var(--text-h)' : 'var(--text-dim)' }}>
          {value ?? (maps === null ? 'loading…' : 'select a map…')}
        </span>
        {count > 0 && (
          <span
            style={{
              padding: '1px 6px', borderRadius: 999, background: 'var(--panel-bg-alt)',
              color: 'var(--text)', fontSize: 10, whiteSpace: 'nowrap',
            }}
          >
            {count} wp
          </span>
        )}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          style={{ color: 'var(--text-dim)', transform: shown ? 'rotate(180deg)' : 'none' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {shown && (
        <div
          role="listbox"
          aria-label="Map"
          className="npt-card"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 280, maxHeight: 360,
            overflowY: 'auto', padding: 4, display: 'flex', flexDirection: 'column', gap: 2,
            background: 'var(--panel-bg)',
          }}
        >
          {(maps ?? []).length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-dim)' }}>
              {maps === null ? 'Loading maps…' : 'No 2D maps on the robot.'}
            </div>
          )}
          {(maps ?? []).map((m) => (
            <button
              key={m.name}
              role="option"
              aria-selected={m.name === value}
              className="npt-menu-item val-mono"
              onClick={() => { setOpen(false); if (m.name !== value) onChange(m.name) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 10px',
                border: 'none', borderRadius: 4, cursor: 'pointer', textAlign: 'left', fontSize: 12,
                fontWeight: m.name === value ? 600 : 400,
              }}
            >
              <Dot on={m.name === robotMap} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.name}
              </span>
              {m.name === robotMap && (
                <span
                  style={{
                    fontSize: 9, letterSpacing: '0.08em', padding: '1px 6px', borderRadius: 999,
                    color: TONE.ok, border: `1px solid ${TONE.ok}`,
                  }}
                >
                  ROBOT
                </span>
              )}
              <span style={{ minWidth: 36, textAlign: 'right', fontSize: 11, color: 'var(--text-dim)' }}>
                {counts.get(m.name) ? `${counts.get(m.name)} wp` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
