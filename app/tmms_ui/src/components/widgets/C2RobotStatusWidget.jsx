import { Fragment } from 'react'
import { C2PinGlyph } from '../ui/C2PinGlyph'

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

// What used to be the ROBOT panel, minus everything the robot card on the map now shows
// (relocalize, pause, cancel, status). Starting a route, and following it, live here.
export function C2RobotStatusWidget({
  robot, live, robotMap,
  driveBlocker, target, plan, goBlocker, routeNote, busy,
  toBlocker, routeMode, activePlan, onGoTo, onGoThrough, onCancelRoute, onSendRoute,
  walking, navPathShown, hasHome, onReturnHome, standBlocker,
  planLog, segmentText, onSelectStop,
}) {
  const hint = LOCALIZATION_HINTS[robot?.localization]
  const stops = activePlan?.stops ?? walking?.stops ?? []

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>ROUTE</span>
        <span
          className="val-mono"
          style={{ fontSize: 10, color: live ? 'var(--success, #4ADE80)' : 'var(--text-dim)' }}
          title={live ? 'Receiving /quadruped_main_status' : 'No messages on /quadruped_main_status'}
        >
          {live ? '● LIVE' : '○ NO DATA'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>

        {live && hint && (
          <div style={{ fontSize: 11, lineHeight: 1.5, color: TONE_COLOR[hint.tone] }}>
            {hint.text}
          </div>
        )}
        {live && robot?.paused && (
          <div className="flash-warn" style={{ fontSize: 11, lineHeight: 1.5, color: '#EF4444' }}>
            ⚠ PAUSED — routes will not move the robot. Press Unpause on the robot card.
          </div>
        )}
        {driveBlocker && (
          <div style={{ fontSize: 11, color: '#FBBF24', lineHeight: 1.5 }}>{driveBlocker}</div>
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
            {robot?.navState === 'map_switching' && (
              <div className="val-mono" style={{ fontSize: 10, color: TONE_COLOR.busy, lineHeight: 1.5 }}>
                <Spinner />Switching map: loading the next map and relocalizing. Cancel waits until this ends.
              </div>
            )}
            {segmentText && (
              <div className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                segment {segmentText}
              </div>
            )}
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
                Review &amp; send ▶
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

        {stops.length > 0 && (
          <>
            <div style={{ borderTop: '1px solid var(--border)' }} />
            <div style={subHeadStyle}>{walking && !activePlan ? 'Running' : 'Preview'} · {stops.length} stops</div>
            <div>
              {stops.map((p, i) => {
                const newMap = i === 0 || stops[i - 1].map !== p.map
                const done = walking && !activePlan && i < walking.reached
                return (
                  <Fragment key={`${p.map}:${p.id}:${i}`}>
                    {newMap && (
                      <div
                        className="val-mono"
                        style={{
                          fontSize: 10, color: 'var(--text-dim)', marginTop: i ? 6 : 0, padding: '2px 4px',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        {p.map}{p.map === robotMap ? ' · robot here' : ''}
                      </div>
                    )}
                    <div
                      onClick={() => onSelectStop?.(p)}
                      className="val-mono"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 4px',
                        cursor: 'pointer', color: 'var(--text)', opacity: done ? 0.45 : 1,
                        overflow: 'hidden', whiteSpace: 'nowrap',
                      }}
                    >
                      <span style={{ width: 18, textAlign: 'right' }}>{i + 1}.</span>
                      <C2PinGlyph type={p.type} size={12} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                      <span style={{ color: 'var(--text-dim)' }}>{p.x.toFixed(1)}, {p.y.toFixed(1)}</span>
                    </div>
                  </Fragment>
                )
              })}
            </div>
          </>
        )}

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

      </div>
    </div>
  )
}
