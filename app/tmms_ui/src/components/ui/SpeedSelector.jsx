// Order top→bottom: HIGH → MID → LOW
const LEVELS = ['HIGH', 'MID', 'LOW']

export function SpeedSelector({ speed, onChange, disabled }) {
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
        SPEED
      </span>

      {LEVELS.map((level) => {
        const active = speed === level
        return (
          <button
            key={level}
            onClick={() => !disabled && onChange(level)}
            style={{
              width: '100%',
              padding: '10px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              textAlign: 'center',
              borderRadius: 4,
              border: active ? '1px solid var(--accent-bright)' : '1px solid var(--border)',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#E5E7EB' : 'var(--text-dim)',
              cursor: 'pointer',
              pointerEvents: disabled ? 'none' : 'auto',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              if (!active && !disabled) {
                e.currentTarget.style.borderColor = 'var(--accent-bright)'
                e.currentTarget.style.color = 'var(--text-h)'
              }
            }}
            onMouseLeave={(e) => {
              if (!active && !disabled) {
                e.currentTarget.style.borderColor = 'var(--border)'
                e.currentTarget.style.color = 'var(--text-dim)'
              }
            }}
          >
            {level}
          </button>
        )
      })}
    </div>
  )
}
