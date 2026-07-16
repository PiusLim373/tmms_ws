import { callService } from '../services/rosbridge'

export function Footer({ connected, page, onNavigate }) {
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
      className="flex items-center flex-shrink-0"
      style={{
        height: 58,
        background: 'var(--panel-bg)',
        borderTop: '1px solid var(--border)',
        padding: '0 16px',
      }}
    >
      {/* Left: page nav */}
      <div className="flex items-center" style={{ flex: 1 }}>
        <button
          onClick={onNavigate}
          className="btn-icon"
          style={{ padding: '8px 16px', fontSize: 12 }}
        >
          {page === 'dashboard' ? '🎬 Recordings' : '◂ Dashboard'}
        </button>
      </div>

      {/* Center: ESTOP */}
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

      {/* Right: spacer to balance left nav, keeps ESTOP centered */}
      <div style={{ flex: 1 }} />
    </footer>
  )
}
