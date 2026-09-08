import { useEffect, useRef, useState } from 'react'

const REBOOT_ITEMS = [
  {
    target: 'rosbridge',
    label: 'Restart rosbridge',
    hint: 'Live data only. The robot keeps its map and pose.',
  },
  {
    target: 'tmms_ws',
    label: 'Restart tmms_ws',
    hint: 'Soft reboot of the whole ROS stack. Takes ~1 min.',
  },
]

// Uppercase mono section label — same treatment as the modal Card titles.
function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
        padding: '0 10px',
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  )
}

export function SettingsMenu({ theme, onThemeToggle, onReboot, busyTarget }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // First close-on-outside-click / Escape handler in this app. Bound only while open so the
  // header is not listening on every document event for the 99% of the time the menu is shut.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false)
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const busy = busyTarget != null

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-icon text-sm"
        title="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        // Same box as the theme toggle this replaced, so the header does not reflow.
        style={{ width: 30, height: 28, fontSize: 14 }}
      >
        ⚙
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 55,
            width: 250,
            padding: '10px 0',
            background: 'var(--bg)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}
        >
          <SectionLabel>Appearance</SectionLabel>
          <div style={{ display: 'flex', gap: 6, padding: '0 10px' }}>
            {[
              { mode: 'light', glyph: '☀', label: 'Light' },
              { mode: 'dark', glyph: '☾', label: 'Dark' },
            ].map(({ mode, glyph, label }) => {
              const active = theme === mode
              return (
                <button
                  key={mode}
                  // onThemeToggle flips; only call it when the other mode is wanted, so
                  // clicking the already-active half is a no-op rather than a flip-back.
                  onClick={() => { if (!active) onThemeToggle() }}
                  style={{
                    flex: 1,
                    padding: '6px 0',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    letterSpacing: '0.06em',
                    borderRadius: 4,
                    border: active
                      ? '1px solid var(--accent-bright)'
                      : '1px solid var(--border)',
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? '#E5E7EB' : 'var(--text-dim)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) {
                      e.currentTarget.style.borderColor = 'var(--accent-bright)'
                      e.currentTarget.style.color = 'var(--text-h)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!active) {
                      e.currentTarget.style.borderColor = 'var(--border)'
                      e.currentTarget.style.color = 'var(--text-dim)'
                    }
                  }}
                >
                  {glyph} {label}
                </button>
              )
            })}
          </div>

          <div
            style={{
              height: 1,
              background: 'var(--border)',
              margin: '12px 0 10px',
            }}
          />

          <SectionLabel>System</SectionLabel>
          {REBOOT_ITEMS.map(({ target, label, hint }) => {
            // Everything locks while any reboot runs: the two targets overlap (a tmms_ws
            // restart takes rosbridge with it) and the manager rejects a second job anyway.
            const isRunning = busyTarget === target
            return (
              <button
                key={target}
                role="menuitem"
                disabled={busy}
                onClick={() => { setOpen(false); onReboot(target) }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderLeft: '2px solid transparent',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy && !isRunning ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!busy) {
                    e.currentTarget.style.background = 'var(--panel-bg)'
                    e.currentTarget.style.borderLeftColor = 'var(--accent-bright)'
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.borderLeftColor = 'transparent'
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-h)',
                  }}
                >
                  {isRunning ? '⟳ ' : ''}{label}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                  {isRunning ? 'Restarting…' : hint}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
