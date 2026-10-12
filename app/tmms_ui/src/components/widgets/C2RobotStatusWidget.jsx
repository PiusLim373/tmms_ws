import { degFromYaw, formatMetres } from '../../lib/c2Coords'
import { effectiveYaw } from '../../lib/c2Pins'

const LOCALIZATION_HINTS = {
  not_started: { tone: 'warn', text: 'Not localized yet — relocalize before sending the robot anywhere.' },
  pending: { tone: 'busy', text: 'Converging… holding the robot still.' },
  failed: { tone: 'bad', text: 'Localization did not converge — relocalize again, closer to the true position.' },
  localization_lost: { tone: 'bad', text: 'Localization lost. Relocalize to recover.' },
}

const TONE_COLOR = {
  ok: '#4ADE80',
  warn: '#FBBF24',
  busy: '#60A5FA',
  bad: '#F87171',
}

const PLAN_TONE = {
  accepted: 'busy', executing: 'busy', completed: 'ok',
  rejected: 'bad', cancelled: 'warn', errored: 'bad',
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

function Spinner() {
  return (
    <span
      className="animate-spin"
      style={{
        display: 'inline-block', width: 10, height: 10, marginRight: 6, verticalAlign: '-1px',
        border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%',
      }}
    />
  )
}

const subHeadStyle = {
  fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: 'var(--text-dim)',
}

const btn = { fontSize: 11, padding: '6px 10px' }
const primaryBtn = { ...btn, borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }

export function C2RobotStatusWidget({
  robot, live, mapName,
  driveBlocker, target, plan, goBlocker, routeNote, busy, result,
  reloc, posePin, onStartReloc, onCancelReloc, onSendReloc,
  toBlocker, routeMode, activePlan, onGoTo, onGoThrough, onCancelRoute, onSendRoute,
  walking, navPathShown, hasHome, onReturnHome, standBlocker,
  onPause, onCancelGoal,
  scanHint, planLog,
}) {
  const hint = LOCALIZATION_HINTS[robot?.localization]
  const navigating = robot?.navState === 'navigating'
  const poseYaw = effectiveYaw(posePin)

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>ROBOT</span>
        <span
          className="val-mono"
          style={{ fontSize: 10, color: live ? 'var(--success, #4ADE80)' : 'var(--text-dim)' }}
          title={live ? 'Receiving /quadruped_main_status' : 'No messages on /quadruped_main_status'}
        >
          {live ? '● LIVE' : '○ NO DATA'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={subHeadStyle}>Control</div>

        {driveBlocker && (
          <div style={{ fontSize: 11, color: '#FBBF24', lineHeight: 1.5 }}>{driveBlocker}</div>
        )}

        {reloc === 'idle' ? (
          <button
            className="btn-icon"
            style={btn}
            disabled={Boolean(driveBlocker) || busy || robot?.localization === 'pending'}
            onClick={onStartReloc}
            title="Tell the robot roughly where it is on this map"
          >
            {robot?.localization === 'pending' ? 'Converging…' : '⌖ Relocalize'}
          </button>
        ) : (
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 4,
              border: '1px solid var(--robot-marker, #22D3EE)',
            }}
          >
            <div className="val-mono" style={{ fontSize: 11, color: 'var(--text-h)' }}>
              {posePin
                ? `x ${formatMetres(posePin.x)}  y ${formatMetres(posePin.y)} m · `
                  + (poseYaw != null ? `${degFromYaw(poseYaw)}°` : 'heading not set (sends 0°)')
                : 'Click the map where the robot is.'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              {posePin
                ? 'Drag the ring to the way the robot faces, then send.'
                : 'Esc to cancel.'}
              {robot?.currentMap && robot.currentMap !== mapName && ` Also loads ${mapName} on the robot.`}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-icon" style={{ ...btn, flex: 1 }} disabled={reloc === 'sending'} onClick={onCancelReloc}>
                Cancel
              </button>
              <button className="btn-icon" style={{ ...primaryBtn, flex: 2 }} disabled={!posePin || busy} onClick={onSendReloc}>
                {reloc === 'sending' ? <><Spinner />Relocalizing…</> : 'Send pose ▶'}
              </button>
            </div>
          </div>
        )}

        {walking && !activePlan && (
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderRadius: 4,
              border: '1px solid var(--accent-bright)',
              background: 'color-mix(in srgb, var(--accent-bright) 10%, transparent)',
            }}
          >
            <div className="val-mono" style={{ fontSize: 11, color: 'var(--text-h)' }}>
              Walking to {walking.name}
            </div>
            <div className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              {walking.mode === 'to'
                ? (walking.reached ? 'Arrived.'
                  : navPathShown ? "The purple line is the robot's own planned path (nav2)."
                    : 'Waiting for the robot to send its planned path…')
                : `${walking.reached} of ${walking.stops.length} stops reached. Walked legs turn grey on the map.`}
              {' '}✕ Cancel route below stops it.
            </div>
          </div>
        )}

        {activePlan ? (
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 4,
              border: '1px solid var(--accent-bright)',
            }}
          >
            <div className="val-mono" style={{ fontSize: 11, color: 'var(--text-h)' }}>
              {routeMode === 'to' ? 'Go to' : 'Go through links to'} {target?.name}
            </div>
            <div className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              {routeMode === 'to'
                ? <>Only {target?.name} is sent. The robot plans its own way there; its real path appears on the map once you press Send.</>
                : <>
                  {activePlan.stops.length === 1
                    ? 'straight there'
                    : `via ${activePlan.stops.slice(0, -1).map((p) => p.name).join(' → ')}`}
                  {' · '}{activePlan.lengthM.toFixed(1)} m (straight-line estimate). Shown in purple on the map.
                </>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-icon" style={{ ...btn, flex: 1 }} onClick={onCancelRoute}>
                Cancel
              </button>
              <button className="btn-icon" style={{ ...primaryBtn, flex: 2 }} disabled={busy || Boolean(standBlocker)} onClick={onSendRoute}>
                Send ▶
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn-icon"
              style={{ ...primaryBtn, flex: 1 }}
              disabled={Boolean(driveBlocker || standBlocker || toBlocker) || busy}
              onClick={onGoTo}
              title={toBlocker ?? 'Send only the destination; the robot plans its own way there'}
            >
              ▶ Go to {target ? target.name : '…'}
            </button>
            <button
              className="btn-icon"
              style={{ ...primaryBtn, flex: 1 }}
              disabled={Boolean(driveBlocker || standBlocker || goBlocker) || !plan || busy}
              onClick={onGoThrough}
              title={goBlocker ?? 'Follow your links, through your waypoints'}
            >
              ▶ Go through links
            </button>
          </div>
        )}
        {hasHome ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn-icon"
              style={{ ...btn, flex: 1 }}
              disabled={Boolean(driveBlocker || standBlocker) || busy}
              onClick={() => onReturnHome('to')}
              title="Send only Home; the robot plans its own way back"
            >
              ⌂ Go to Home
            </button>
            <button
              className="btn-icon"
              style={{ ...btn, flex: 1 }}
              disabled={Boolean(driveBlocker || standBlocker) || busy}
              onClick={() => onReturnHome('through')}
              title="Follow your links back to Home"
            >
              ⌂ Home through links
            </button>
          </div>
        ) : (
          <button className="btn-icon" style={btn} disabled title="Place a Home pin in this graph first">
            ⌂ Return home (no Home pin in this graph)
          </button>
        )}

        {standBlocker && !driveBlocker && (
          <div role="alert" style={{ fontSize: 11, color: '#FBBF24', lineHeight: 1.5, border: '1px solid #FBBF24', borderRadius: 4, padding: '6px 8px' }}>
            {standBlocker}
          </div>
        )}
        {!activePlan && !driveBlocker && (toBlocker || goBlocker) && (
          <div style={{ fontSize: 10, color: (toBlocker ?? goBlocker).startsWith('Select') ? 'var(--text-dim)' : '#FBBF24', lineHeight: 1.5 }}>
            {toBlocker ?? <>Go through links: {goBlocker}</>}
          </div>
        )}
        {routeNote && (
          <div style={{ fontSize: 10, color: '#FBBF24', lineHeight: 1.5 }}>{routeNote}</div>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-icon" style={{ ...btn, flex: 1 }} disabled={!live} onClick={onPause}>
            {robot?.paused ? '▶ Unpause' : '⏸ Pause'}
          </button>
          <button
            className="btn-icon"
            style={{ ...btn, flex: 1, ...(navigating && { borderColor: '#DC2626', color: '#DC2626' }) }}
            onClick={onCancelGoal}
            title="Stop the route that is running"
          >
            ✕ Cancel route
          </button>
        </div>

        {result && (
          <div
            className="val-mono"
            style={{ fontSize: 11, lineHeight: 1.5, color: result.ok ? TONE_COLOR.ok : TONE_COLOR.bad, wordBreak: 'break-word' }}
          >
            {result.ok ? '✓ ' : '✕ '}{result.message}
          </div>
        )}

        <div className="val-mono" style={{ fontSize: 10, color: scanHint ? 'var(--text-dim)' : TONE_COLOR.ok }}>
          lidar on map: {scanHint ?? 'shown in red'}
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} />
        <div style={subHeadStyle}>Route log</div>
        {planLog.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Nothing yet.</div>
        ) : (
          planLog.slice().reverse().map((e, i) => (
            <div key={i} className="val-mono" style={{ fontSize: 10, color: 'var(--text)' }}>
              {e.at} · {e.id} → <span style={{ color: TONE_COLOR[PLAN_TONE[e.status]] }}>{e.status}</span>
            </div>
          ))
        )}

        <div style={{ borderTop: '1px solid var(--border)' }} />
        <div style={subHeadStyle}>Status</div>
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
          <Stat label="ROUTE" value={robot?.navplanId ? String(robot.navplanId) : ''} />
          <Stat
            label="ROUTE STATUS"
            value={robot?.navplanStatus}
            color={TONE_COLOR[PLAN_TONE[robot?.navplanStatus]]}
          />
        </div>

        {live && hint && (
          <div style={{ fontSize: 11, lineHeight: 1.5, color: TONE_COLOR[hint.tone] }}>
            {hint.text}
          </div>
        )}
        {live && robot?.paused && (
          <div className="flash-warn" style={{ fontSize: 11, lineHeight: 1.5, color: '#EF4444' }}>
            ⚠ PAUSED — routes will not move the robot. Press Unpause above.
          </div>
        )}
      </div>
    </div>
  )
}
