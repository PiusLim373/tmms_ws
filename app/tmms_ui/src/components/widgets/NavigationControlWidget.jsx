import { useState } from 'react'
import { setQuadrupedPaused, cancelNavGoal } from '../../services/rosbridge'

// localization_status -> what the operator should do about it. The manager only ever
// publishes these five, and every one of them needs a different next action.
const LOCALIZATION_HINTS = {
  not_started: { tone: 'warn', text: 'Set an initial pose in Lichtblick to localize.' },
  pending: { tone: 'busy', text: 'Converging… holding the robot still.' },
  localized: { tone: 'ok', text: 'Robot is localized.' },
  failed: { tone: 'bad', text: 'Localization did not converge — set the initial pose again, closer to the true position.' },
  localization_lost: { tone: 'bad', text: 'Localization lost. Set the initial pose again to recover.' },
}

const TONE_COLOR = {
  ok: 'var(--ok, #4ADE80)',
  warn: '#FBBF24',
  busy: '#60A5FA',
  bad: '#F87171',
  neutral: 'var(--text-dim)',
}

// Every navigation_state QuadrupedMainStatus.msg declares. The controller overwrites the
// FSM's value with `paused` whenever the robot is paused, so that one is a real state here.
const NAV_STATE_TONE = {
  idle: 'neutral',
  navigating: 'busy',
  paused: 'warn',
  canceled: 'warn',
  error: 'bad',
  unlocalized: 'bad',
  navigation_failed: 'bad',
}

// Shown under the rows for the states an operator has to act on. `paused` is deliberately
// absent — it already has its own banner below.
const NAV_STATE_BANNER = {
  error: 'Navigation error — check the robot before sending another goal.',
  navigation_failed: 'Navigation failed — the robot did not reach the goal.',
  unlocalized: 'Robot is not localized — set an initial pose before navigating.',
}

// `tone` turns the value into a coloured pill. Without it the row renders as plain text,
// which is what MAP and LOCALIZATION want.
function Row({ label, value, placeholder, tone }) {
  const empty = !value
  return (
    <div className="flex items-center justify-between" style={{ padding: '3px 0' }}>
      <span style={{ fontSize: 11, opacity: 0.6, letterSpacing: '0.05em' }}>{label}</span>
      {tone && !empty ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: TONE_COLOR[tone],
            border: `1px solid ${TONE_COLOR[tone]}`,
            background: 'color-mix(in srgb, currentColor 14%, transparent)',
            borderRadius: 4,
            padding: '2px 8px',
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
        </span>
      ) : (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            opacity: empty ? 0.5 : 1,
            fontStyle: empty ? 'italic' : 'normal',
            textAlign: 'right',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {empty ? placeholder : value}
        </span>
      )}
    </div>
  )
}

export function NavigationControlWidget({
  currentMap,
  localizationStatus,
  navigationState,
  isPaused,
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const hint = LOCALIZATION_HINTS[localizationStatus]
  const navigating = navigationState === 'navigating'

  function handlePauseToggle() {
    const next = !isPaused
    setBusy(true)
    setResult(null)
    setQuadrupedPaused(
      next,
      (res) => {
        setBusy(false)
        setResult({ ok: res.success, message: res.message })
      },
      (err) => {
        setBusy(false)
        setResult({ ok: false, message: String(err) })
      }
    )
  }

  function handleCancel() {
    setBusy(true)
    setResult(null)
    // std_srvs/Empty carries no response fields, so simply arriving here is the success.
    cancelNavGoal(
      () => {
        setBusy(false)
        setResult({ ok: true, message: 'Goal cancelled.' })
      },
      (err) => {
        setBusy(false)
        setResult({ ok: false, message: String(err) })
      }
    )
  }

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">NAVIGATION CONTROL</div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
        <Row label="MAP" value={currentMap} placeholder="none — load one above" />
        <Row label="LOCALIZATION" value={localizationStatus} placeholder="unknown" />
        <Row
          label="NAV STATE"
          value={navigationState}
          placeholder="unknown"
          tone={NAV_STATE_TONE[navigationState] ?? 'neutral'}
        />

        {NAV_STATE_BANNER[navigationState] && (
          <div
            className="flash-warn"
            style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: TONE_COLOR.bad }}
          >
            ⚠ {NAV_STATE_BANNER[navigationState]}
          </div>
        )}

        {hint && (
          <div
            style={{
              marginTop: 6,
              fontSize: 11,
              lineHeight: 1.5,
              color: TONE_COLOR[hint.tone],
            }}
          >
            {hint.text}
          </div>
        )}

        {/* The one thing an operator will otherwise waste minutes on: sending goals to a
            paused robot and watching nothing happen. quadruped_controller drops nav2's
            cmd_vel entirely while paused, so the goal is accepted and simply never moves it. */}
        {isPaused && (
          <div
            className="flash-warn"
            style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: '#EF4444' }}
          >
            ⚠ PAUSED — navigation goals will not move the robot. Unpause for autonomous
            navigation.
          </div>
        )}

        <div className="flex gap-2" style={{ marginTop: 10 }}>
          <button
            onClick={handlePauseToggle}
            disabled={busy}
            className="btn-icon"
            style={{ flex: 1, padding: '8px 10px', fontSize: 11 }}
            title={isPaused
              ? 'Hand the robot to nav2 (also runs balance_stand)'
              : 'Take the robot back for teleop'}
          >
            {isPaused ? '▶ Unpause (autonomy)' : '⏸ Pause (teleop)'}
          </button>
          <button
            onClick={handleCancel}
            disabled={busy || !navigating}
            className="btn-icon"
            style={{ flex: 1, padding: '8px 10px', fontSize: 11 }}
            title={navigating ? 'Preempt the active goal' : 'No goal is active'}
          >
            ✕ Cancel Goal
          </button>
        </div>

        {result && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              lineHeight: 1.5,
              color: result.ok ? 'var(--ok, #4ADE80)' : '#F87171',
            }}
          >
            {result.message}
          </div>
        )}

        <div
          style={{
            marginTop: 12,
            paddingTop: 8,
            borderTop: '1px solid var(--border)',
            fontSize: 10,
            opacity: 0.6,
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>HOW TO OPERATE</div>
          1. Load a map above.<br />
          2. Drop an initial pose in Lichtblick to localize.<br />
          3. Send a nav goal in Lichtblick.<br />
          4. Pause to teleop, unpause for autonomous navigation.
        </div>
      </div>
    </div>
  )
}
