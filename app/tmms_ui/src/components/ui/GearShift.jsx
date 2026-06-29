// Order top→bottom: WALK(3) → STAND LOCK(2) → SIT(1)
// User clicks ▲/▼ arrows to cycle modes. Mode labels are display-only.
const MODES = [
  { mode: 3, label: 'WALK' },
  { mode: 2, label: 'STAND\nLOCK' },
  { mode: 1, label: 'SIT' },
]

const arrowBtn = (disabled, label, onClick) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      width: '100%',
      padding: '6px 0',
      fontFamily: 'var(--font-mono)',
      fontSize: 14,
      background: 'transparent',
      border: '1px solid var(--border)',
      borderRadius: 4,
      color: disabled ? 'var(--border)' : 'var(--text)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.35 : 1,
      transition: 'all 0.15s',
      lineHeight: 1,
    }}
    onMouseEnter={(e) => {
      if (!disabled) {
        e.currentTarget.style.borderColor = 'var(--accent-bright)'
        e.currentTarget.style.color = 'var(--text-h)'
      }
    }}
    onMouseLeave={(e) => {
      if (!disabled) {
        e.currentTarget.style.borderColor = 'var(--border)'
        e.currentTarget.style.color = 'var(--text)'
      }
    }}
  >
    {label}
  </button>
)

export function GearShift({ mode, onModeChange, disabled }) {
  return (
    <div className="flex flex-col gap-1" style={{ width: '100%' }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-dim)',
          letterSpacing: '0.06em',
          marginBottom: 4,
        }}
      >
        ROBOT MODE
      </span>

      {arrowBtn(disabled || mode >= 3, '▲', () => onModeChange(mode + 1))}

      {MODES.map((m) => {
        const isActive = mode === m.mode
        return (
          <div
            key={m.mode}
            style={{
              width: '100%',
              padding: '10px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              whiteSpace: 'pre-line',
              lineHeight: 1.3,
              textAlign: 'center',
              borderRadius: 4,
              border: isActive
                ? '1px solid var(--accent-bright)'
                : '1px solid var(--border)',
              background: isActive ? 'var(--accent)' : 'transparent',
              color: isActive ? '#E5E7EB' : 'var(--text-dim)',
              userSelect: 'none',
            }}
          >
            <span
              style={{
                fontSize: 9,
                opacity: 0.6,
                display: 'block',
                marginBottom: 2,
                color: isActive ? '#C4B5FD' : 'inherit',
              }}
            >
              {m.mode}
            </span>
            {m.label}
          </div>
        )
      })}

      {arrowBtn(disabled || mode <= 1, '▼', () => onModeChange(mode - 1))}
    </div>
  )
}
