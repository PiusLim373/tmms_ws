import { useState, useEffect } from 'react'
import { useTopicActivity } from '../hooks/useTopicActivity'

function batteryColor(pct) {
  if (pct > 50) return '#22C55E'
  if (pct > 20) return '#F59E0B'
  return '#EF4444'
}

export function Header({ connected, theme, onThemeToggle }) {
  const [time, setTime] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const { active: statusActive, lastMsg: statusMsg } = useTopicActivity(
    '/quadruped_main_status', 'tmms_msgs/QuadrupedMainStatus', 1000
  )
  const battery = statusActive ? statusMsg?.battery_percentage : undefined

  const hh = String(time.getHours()).padStart(2, '0')
  const mm = String(time.getMinutes()).padStart(2, '0')
  const ss = String(time.getSeconds()).padStart(2, '0')

  return (
    <header
      className="flex items-center justify-between px-4 flex-shrink-0"
      style={{
        height: 52,
        background: 'var(--panel-bg)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Left: logo + title */}
      <div className="flex items-center gap-3">
        <img src="/htx_logo.png" alt="HTX" style={{ height: 32 }} />
        <div
          style={{
            width: 1,
            height: 24,
            background: 'var(--border)',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            letterSpacing: '0.12em',
            color: 'var(--text-h)',
            fontWeight: 500,
          }}
        >
          TMMS DASHBOARD
        </span>
      </div>

      {/* Right: status + clock + toggle */}
      <div className="flex items-center gap-4">
        {/* ROS connection badge */}
        <div className="flex items-center gap-1.5">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              display: 'inline-block',
              background: connected ? 'var(--accent-blue)' : '#EF4444',
              boxShadow: connected
                ? '0 0 6px var(--accent-blue)'
                : '0 0 6px #EF4444',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: connected ? 'var(--accent-blue)' : '#EF4444',
              letterSpacing: '0.06em',
            }}
          >
            {connected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
        </div>

        {/* Clock */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--text-dim)',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.04em',
          }}
        >
          {hh}:{mm}:{ss}
        </span>

        {/* Battery */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: battery === undefined ? 'var(--text-dim)' : batteryColor(battery),
            letterSpacing: '0.04em',
            fontVariantNumeric: 'tabular-nums',
          }}
          title={battery === undefined ? 'No quadruped_main_status feed' : `Battery ${battery}%`}
        >
          🔋 {battery === undefined ? '--' : `${battery}%`}
        </span>

        {/* Light/dark toggle */}
        <button
          onClick={onThemeToggle}
          className="btn-icon text-sm"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{ width: 30, height: 28, fontSize: 14 }}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </header>
  )
}
