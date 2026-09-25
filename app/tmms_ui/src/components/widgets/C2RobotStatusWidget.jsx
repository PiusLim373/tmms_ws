import { degFromYaw, formatMetres } from '../../lib/c2Coords'

const LOCALIZATION_HINTS = {
  not_started: { tone: 'warn', text: 'Not localized yet — set an initial pose before sending the robot anywhere.' },
  pending: { tone: 'busy', text: 'Converging… holding the robot still.' },
  failed: { tone: 'bad', text: 'Localization did not converge — set the initial pose again, closer to the true position.' },
  localization_lost: { tone: 'bad', text: 'Localization lost. Set the initial pose again to recover.' },
}

const TONE_COLOR = {
  warn: '#FBBF24',
  busy: '#60A5FA',
  bad: '#F87171',
}

function batteryColor(pct) {
  if (pct == null) return 'var(--text-h)'
  if (pct > 50) return '#22C55E'
  if (pct > 20) return '#F59E0B'
  return '#EF4444'
}

function Stat({ label, value, color }) {
  const empty = value == null || value === ''
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 10, opacity: 0.5, letterSpacing: '0.06em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {label}
      </div>
      <div
        className="val-mono"
        style={{
          fontSize: 12, lineHeight: 1.45,
          color: color ?? 'var(--text-h)',
          opacity: empty ? 0.45 : 1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {empty ? '—' : value}
      </div>
    </div>
  )
}

export function C2RobotStatusWidget({ robot, live, mapName }) {
  const hint = LOCALIZATION_HINTS[robot?.localization]

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>ROBOT STATUS</span>
        <span
          className="val-mono"
          style={{ fontSize: 10, color: live ? 'var(--success, #4ADE80)' : 'var(--text-dim)' }}
          title={live ? 'Receiving /quadruped_main_status' : 'No messages on /quadruped_main_status'}
        >
          {live ? '● LIVE' : '○ NO DATA'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            columnGap: 16,
            rowGap: 8,
          }}
        >
          <Stat label="MAP ON CANVAS" value={mapName} />
          <Stat label="ROBOT'S MAP" value={robot?.currentMap} />
          <Stat
            label="POSITION"
            value={robot?.position
              ? `x ${formatMetres(robot.position.x)}  y ${formatMetres(robot.position.y)} m`
              : ''}
          />
          <Stat label="FACING" value={robot?.yaw != null ? `${degFromYaw(robot.yaw)}°` : ''} />
          <Stat
            label="BATTERY"
            value={robot?.battery != null ? `${robot.battery}%` : ''}
            color={batteryColor(robot?.battery)}
          />
          <Stat label="MODE" value={robot?.mode} />
          <Stat label="LOCALIZATION" value={robot?.localization} />
          <Stat label="NAV STATE" value={robot?.navState} />
        </div>

        {live && hint && (
          <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: TONE_COLOR[hint.tone] }}>
            {hint.text}
          </div>
        )}
        {live && robot?.paused && (
          <div className="flash-warn" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: '#EF4444' }}>
            ⚠ PAUSED — goals will not move the robot. Unpause on the Navigation page.
          </div>
        )}
      </div>
    </div>
  )
}
