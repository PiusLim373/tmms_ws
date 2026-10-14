import { useState } from 'react'
import { degFromYaw } from './lib/quat'
import { TONE } from './lib/tone'

const NAV_STATE_TONE = {
  idle: 'neutral', navigating: 'ok', map_switching: 'busy', paused: 'warn', canceled: 'warn',
  error: 'bad', unlocalized: 'bad', navigation_failed: 'bad',
}
const LOC_TONE = {
  not_started: 'warn', pending: 'busy', localized: 'ok', failed: 'bad', localization_lost: 'bad',
}
// Mirrors NavigationPlan.msg's status enum.
const PLAN_TONE = {
  created: 'neutral', accepted: 'busy', executing: 'busy',
  completed: 'ok', rejected: 'bad', cancelled: 'warn', errored: 'bad',
}

const BUTTON = {
  flex: 1, minWidth: 0, height: 36, borderRadius: 4, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
}
// Longhand border, so npt-danger-flash can take over the colour when it is left unset.
const RELOC_BUTTON = {
  ...BUTTON, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)',
  background: 'transparent', color: 'var(--text-h)',
}
const RELOC_ACTIVE = {
  borderColor: 'var(--robot-marker)', color: 'var(--robot-marker)',
  background: 'color-mix(in srgb, var(--robot-marker) 18%, transparent)',
}
const RELOC_FLASH = { borderColor: undefined, background: undefined, color: undefined }
// Footer's ESTOP red for Cancel, warning amber for Pause.
const PAUSE_BUTTON = {
  ...BUTTON, border: `1px solid ${TONE.warn}`, color: TONE.warn,
  background: 'color-mix(in srgb, #FBBF24 14%, transparent)',
}
const STOP_BUTTON = { ...BUTTON, border: 'none', background: '#DC2626', color: '#FFFFFF' }
const dimmed = (style, disabled) => (disabled ? { ...style, opacity: 0.4, cursor: 'not-allowed' } : style)

const LABEL = { fontSize: 10, letterSpacing: '0.08em', color: 'var(--text-dim)', whiteSpace: 'nowrap' }

function Row({ label, value, tone }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '2px 0' }}>
      <span style={LABEL}>{label}</span>
      <span
        className="val-mono"
        style={{
          fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: value && tone ? TONE[tone] : 'var(--text-h)',
        }}
      >
        {value || '—'}
      </span>
    </div>
  )
}

function Reading({ label, value, unit }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={LABEL}>{label}</span>
      <span className="val-mono" style={{ fontSize: 15, whiteSpace: 'nowrap' }}>
        {value ?? '—'}
        {value != null && unit && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 3 }}>{unit}</span>
        )}
      </span>
    </div>
  )
}

function NavBadge({ live, navState }) {
  const tone = live ? TONE[NAV_STATE_TONE[navState] ?? 'neutral'] : 'var(--text-dim)'
  const label = live ? (navState || 'unknown').replace(/_/g, ' ').toUpperCase() : 'NO DATA'
  const dot = { width: 6, height: 6, borderRadius: '50%', background: tone, flexShrink: 0 }
  return (
    <span
      className="val-mono"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px 3px 7px',
        borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', whiteSpace: 'nowrap',
        color: tone,
        background: live ? `color-mix(in srgb, ${tone} 16%, transparent)` : 'transparent',
        border: `1px solid color-mix(in srgb, ${tone} ${live ? 45 : 60}%, transparent)`,
      }}
    >
      {live && navState === 'map_switching' ? (
        <span
          className="animate-spin"
          style={{
            width: 8, height: 8, boxSizing: 'border-box', borderRadius: '50%', flexShrink: 0,
            border: `1.5px solid ${tone}`, borderTopColor: 'transparent',
          }}
        />
      ) : (
        <span className={live && navState === 'navigating' ? 'animate-pulse' : undefined} style={dot} />
      )}
      {label}
    </span>
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

function TargetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      <path d="M12 1v4M12 19v4M1 12h4M19 12h4" strokeLinecap="round" />
    </svg>
  )
}

function CrosshairIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="6" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  )
}

// The robot's status, pinned to the bottom-left of the map. Compact by default; hover (or the
// chevron) opens the details above it, so the buttons never move under the cursor.
export function RobotCard({
  live, status, robot, segmentText, isPaused, busy, cancelOff, result,
  onRobotMap, robotMapKnown, onLocate,
  reloc, posePin, mapName, mapMismatch, locFault, relocBlocked,
  onRelocStart, onRelocCancel, onRelocSend, onPause, onCancel,
}) {
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hover || pinned

  const navState = status?.navigation_state ?? ''
  const locStatus = status?.localization_status ?? ''
  const robotMap = status?.current_map ?? ''
  const planStatus = status?.current_navplan_status ?? ''
  const pose = live && robot?.position ? robot : null

  const relocActive = reloc !== 'idle'
  const sending = reloc === 'sending'
  const relocOff = relocActive ? sending : relocBlocked
  // Flashes while the robot has no fix and the button can do something about it.
  const relocFlash = !relocActive && locFault && !relocBlocked
  const relocTitle = relocActive ? 'Discard the pose'
    : !mapName ? 'Select a map first'
      : locStatus === 'pending' ? 'Localization is converging'
        : 'Place the robot on this map and set its heading'
  const locateHighlight = robotMapKnown && !onRobotMap
  const detailsLabel = open ? 'Hide details' : 'Show details'

  return (
    <div
      className="npt-card"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{ width: 340, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {/* The card is anchored at its bottom, so growing this row slides the details up. */}
      <div className="npt-reveal" aria-hidden={!open} style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div
            className="npt-reveal-body"
            style={{
              padding: '8px 12px', borderBottom: '1px solid var(--border)',
              opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(8px)',
            }}
          >
            <Row label="MAP" value={live ? robotMap : ''} />
            <Row label="LOCALIZATION" value={live ? locStatus : ''} tone={LOC_TONE[locStatus]} />
            <Row
              label="NAVPLAN"
              value={live && status?.current_navplan_id ? String(status.current_navplan_id) : ''}
            />
            <Row label="PLAN STATUS" value={live ? planStatus : ''} tone={PLAN_TONE[planStatus]} />
            <Row label="SEGMENT" value={live ? segmentText : ''} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 2px 12px' }}>
        <span
          title={live ? 'Live' : 'No /quadruped_main_status'}
          style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: live ? TONE.ok : 'var(--border)',
          }}
        />
        <span className="val-mono" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--text-dim)' }}>
          ROBOT
        </span>
        <NavBadge live={live} navState={navState} />
        <span style={{ flex: 1 }} />
        <button
          className="btn-icon"
          title={detailsLabel}
          aria-label={detailsLabel}
          aria-expanded={open}
          onClick={() => setPinned((p) => !p)}
          style={{ width: 28, height: 28, padding: 0 }}
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
            className="npt-turn"
            style={{ transform: open ? 'rotate(180deg)' : 'none' }}
          >
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
        <button
          className="btn-icon"
          title={robotMapKnown ? `Show the robot on ${robotMap}` : 'The robot has no map loaded'}
          aria-label="Show the robot"
          disabled={!robotMapKnown}
          onClick={onLocate}
          style={{
            width: 28, height: 28, padding: 0,
            ...(locateHighlight && {
              borderColor: 'var(--accent-bright)', color: 'var(--text-h)',
              background: 'color-mix(in srgb, var(--accent-bright) 24%, transparent)',
            }),
          }}
        >
          <TargetIcon />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, padding: '6px 12px 10px' }}>
        <Reading label="X" value={pose?.position.x.toFixed(2)} unit="m" />
        <Reading label="Y" value={pose?.position.y.toFixed(2)} unit="m" />
        <Reading label="YAW" value={pose ? `${degFromYaw(pose.yaw).toFixed(0)}°` : null} />
      </div>

      {relocActive && (
        <div
          style={{
            margin: '0 10px 8px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
            borderRadius: 4, border: '1px solid color-mix(in srgb, var(--robot-marker) 45%, transparent)',
            background: 'color-mix(in srgb, var(--robot-marker) 8%, transparent)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            <span className="val-mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--robot-marker)' }}>
              RELOCALIZE
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              on “{mapName}”{mapMismatch ? ', loads it on the robot' : ''}
            </span>
          </div>
          <div className="val-mono" style={{ fontSize: 12, color: posePin ? 'var(--text-h)' : 'var(--text-dim)' }}>
            {posePin
              ? `${posePin.x.toFixed(2)}, ${posePin.y.toFixed(2)}`
                + `${posePin.headingSet ? ` · ${degFromYaw(posePin.yaw).toFixed(0)}°` : ' · heading not set'}`
              : 'Click the map to place the robot'}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-icon" style={{ flex: 1, height: 28 }} disabled={sending} onClick={onRelocCancel}>
              Discard
            </button>
            <button
              // After a failed attempt the pose stays for a retry, and this is the button to press.
              className={locFault && posePin && !busy ? 'btn-icon npt-danger-flash' : 'btn-icon'}
              style={{ flex: 2, height: 28, borderColor: 'var(--accent-bright)' }}
              disabled={!posePin || busy}
              onClick={onRelocSend}
            >
              {sending ? <><Spinner />Relocalizing…</> : 'Send pose ▸'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, padding: '0 10px 10px' }}>
        <button
          className={relocFlash ? 'npt-danger-flash' : undefined}
          title={relocTitle}
          aria-pressed={relocActive}
          disabled={relocOff}
          onClick={relocActive ? onRelocCancel : onRelocStart}
          style={dimmed({
            ...RELOC_BUTTON,
            ...(relocActive && RELOC_ACTIVE),
            ...(relocFlash && RELOC_FLASH),
          }, relocOff)}
        >
          <CrosshairIcon />
          RELOCALIZE
        </button>
        <button style={dimmed(PAUSE_BUTTON, busy)} disabled={busy} onClick={onPause}>
          {isPaused ? '▶ UNPAUSE' : '⏸ PAUSE'}
        </button>
        <button style={dimmed(STOP_BUTTON, cancelOff)} disabled={cancelOff} onClick={onCancel}>
          ✕ CANCEL
        </button>
      </div>

      {result && (
        <div style={{ padding: '0 12px 9px', fontSize: 11, color: result.ok ? TONE.ok : TONE.bad }}>
          {result.message}
        </div>
      )}
    </div>
  )
}
