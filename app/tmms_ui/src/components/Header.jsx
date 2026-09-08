import { useState, useEffect, useRef, useCallback } from 'react'
import { useTopicActivity } from '../hooks/useTopicActivity'
import { SettingsMenu } from './ui/SettingsMenu'
import { WarningModal } from './ui/WarningModal'
import { Toast } from './ui/Toast'

function batteryColor(pct) {
  if (pct > 50) return '#22C55E'
  if (pct > 20) return '#F59E0B'
  return '#EF4444'
}

const REBOOT_CONFIRM = {
  rosbridge: {
    title: 'Restart rosbridge',
    body: 'Live data stops for a few seconds and reconnects on its own. Navigation, '
      + 'localization and the loaded map are not affected.',
  },
  tmms_ws: {
    title: 'Restart the ROS stack',
    body: 'Every node stops and relaunches — this drops localization, any active nav goal '
      + 'and the loaded map. Takes about a minute. Only do this with the robot stationary.',
  },
}

// The reboot manager polls the restarted service itself before reporting done, so this only
// has to outlast its own budget (120s container + 30s rosbridge) plus a little slack.
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 180000

export function Header({ connected, theme, onThemeToggle }) {
  const [time, setTime] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // One object rather than four useStates, matching how MappingToolWidget drives this modal.
  const [confirm, setConfirm] = useState({ open: false, target: null })
  const [busyTarget, setBusyTarget] = useState(null)
  const [toast, setToast] = useState(null)     // { message, tone }
  const toastTimerRef = useRef(null)

  useEffect(() => () => clearTimeout(toastTimerRef.current), [])

  const showToast = useCallback((message, tone, sticky = false) => {
    setToast({ message, tone })
    clearTimeout(toastTimerRef.current)
    // The in-progress toast has to stay up for the whole restart, so only terminal
    // messages get the auto-dismiss timer.
    if (!sticky) toastTimerRef.current = setTimeout(() => setToast(null), 5000)
  }, [])

  const runReboot = useCallback(async (target) => {
    setBusyTarget(target)
    showToast(`Restarting ${target}…`, 'info', true)

    try {
      const res = await fetch(`/api/system/reboot/${target}`, { method: 'POST' })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}))
        throw new Error(error || `reboot request failed (${res.status})`)
      }

      const deadline = Date.now() + POLL_TIMEOUT_MS
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

        // Tolerate a failed poll instead of aborting. Neither target restarts the reboot
        // manager or this backend, so polls should keep answering, but a single dropped
        // request must not be reported as a failed reboot when the restart is fine. The
        // deadline below is what ends a genuinely stuck one.
        const job = await fetch('/api/system/status')
          .then((r) => (r.ok ? r.json() : null))
          .then((s) => s?.job)
          .catch(() => null)

        if (job && job.target === target && job.state !== 'running') {
          showToast(job.message, job.state === 'done' ? 'ok' : 'warn')
          return
        }
        if (Date.now() > deadline) {
          showToast(`${target} restart timed out — check the robot.`, 'warn')
          return
        }
      }
    } catch (err) {
      console.error(`[Header] ${target} reboot failed:`, err)
      showToast(err.message, 'warn')
    } finally {
      setBusyTarget(null)
    }
  }, [showToast])

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

        {/* Settings: theme + system reboots */}
        <SettingsMenu
          theme={theme}
          onThemeToggle={onThemeToggle}
          busyTarget={busyTarget}
          onReboot={(target) => setConfirm({ open: true, target })}
        />
      </div>

      <WarningModal
        open={confirm.open}
        heading="SYSTEM REBOOT"
        title={REBOOT_CONFIRM[confirm.target]?.title}
        body={REBOOT_CONFIRM[confirm.target]?.body}
        onCancel={() => setConfirm({ open: false, target: null })}
        onConfirm={() => {
          const { target } = confirm
          setConfirm({ open: false, target: null })
          runReboot(target)
        }}
      />

      {/* Toast is an unpositioned pill meant to sit inside a panel header, so it needs a
          fixed wrapper to work as a page-level notification from up here. */}
      <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 60 }}>
        <Toast visible={toast != null} message={toast?.message ?? ''} tone={toast?.tone} />
      </div>
    </header>
  )
}
