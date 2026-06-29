import { callService } from '../services/rosbridge'

export function Footer({ connected }) {
  function handleEstop() {
    callService(
      '/quadruped_controller/quadruped_cmd',
      'damp',
      (res) => console.log('[ESTOP] damp result:', res),
      (err) => console.error('[ESTOP] damp error:', err)
    )
  }

  return (
    <footer
      className="flex items-center justify-center flex-shrink-0"
      style={{
        height: 58,
        background: 'var(--panel-bg)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <button
        onClick={handleEstop}
        className="flex items-center gap-2 rounded font-medium"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          letterSpacing: '0.08em',
          padding: '10px 48px',
          background: '#DC2626',
          color: '#ffffff',
          border: 'none',
          cursor: 'pointer',
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#B91C1C' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = '#DC2626' }}
        title="Send damp command — all quadruped motors will be disabled and robot will fall"
      >
        <span style={{ fontSize: 15 }}>⚠</span>
        ESTOP — ALL MOTORS DAMP
      </button>
    </footer>
  )
}
