import { useState, useEffect, useRef, useCallback } from 'react'
import { publishQuadrupedCmdVel, callService } from '../../services/rosbridge'
import { useTopicActivity } from '../../hooks/useTopicActivity'
import { GearShift } from '../ui/GearShift'
import { SpeedSelector } from '../ui/SpeedSelector'
import { JoystickDisplay, AxisKnob } from '../ui/JoystickDisplay'
import { WarningModal } from '../ui/WarningModal'
import { Toast } from '../ui/Toast'

const SPEED_MAP = { LOW: 0.2, MID: 0.4, HIGH: 0.7 }

const MODE_SERVICE_CMD = { 1: 'stand_down', 2: 'stand_up', 3: 'balance_stand' }

// Real robot_mode string (from quadruped_main_status) -> GearShift's numeric mode id
// "locomotion" is a transitional state seen during *any* mode switch (not just entering
// walk), so it's deliberately not mapped here — see resolvedMode below.
const MODE_FROM_STRING = { damping: 1, lie_down: 1, joint_lock: 2, balance_stand: 3 }

// ROS convention: +x = forward, +y = left
// JoystickDisplay: x prop = forward/back, y prop = left/right
const JOY_HINTS = { up: '↑', down: '↓', left: '←', right: '→' }

export function QuadrupedWidget({ heldKeys }) {
  const [speedLevel, setSpeedLevel] = useState('MID')
  const [modalOpen, setModalOpen]   = useState(false)
  const [pendingMode, setPendingMode] = useState(null)
  const [serviceStatus, setServiceStatus] = useState({ loading: false, lastResult: null })
  const [joyDisplay, setJoyDisplay] = useState({ x: 0, y: 0, yaw: 0 })

  const speed = SPEED_MAP[speedLevel]

  // isMovingRef doubles as edge-detection (read as "was moving" before each update) and as
  // the live state the 4Hz repeat-publish interval below checks.
  const isMovingRef = useRef(false)
  const desiredCmdRef = useRef({ lx: 0, ly: 0, az: 0 })

  const { active: joyActive, lastMsg: joyMsg } = useTopicActivity('/joy', 'sensor_msgs/Joy', 500)
  const joyActiveRef = useRef(joyActive)
  useEffect(() => { joyActiveRef.current = joyActive }, [joyActive])
  const { active: statusActive, lastMsg: statusMsg } = useTopicActivity(
    '/quadruped_main_status', 'tmms_msgs/QuadrupedMainStatus', 1000
  )

  // Ground truth from the robot, not an optimistic local guess.
  // "locomotion" carries no new information (it's transitional across any mode
  // switch), so hold onto the last resolved stage instead of re-mapping it.
  const [resolvedMode, setResolvedMode] = useState(undefined)
  useEffect(() => {
    if (!statusActive) return
    const raw = statusMsg?.robot_mode
    if (raw === 'locomotion') return
    setResolvedMode(MODE_FROM_STRING[raw])
  }, [statusActive, statusMsg])

  const actualMode = statusActive ? resolvedMode : undefined
  const modeFault  = statusActive && actualMode === undefined
  const isWalkMode = actualMode === 3

  const isWalkModeRef = useRef(isWalkMode)
  useEffect(() => { isWalkModeRef.current = isWalkMode }, [isWalkMode])

  // Tracks the last cmd_vel the UI actually published, so we can tell whether a
  // zero needs to be sent when walk mode is lost (backend replays the last value
  // it received indefinitely — it doesn't expire it on its own).
  const lastCmdRef = useRef({ lx: 0, ly: 0, az: 0 })
  const sendCmdVel = useCallback((lx, ly, az) => {
    publishQuadrupedCmdVel(lx, ly, az)
    lastCmdRef.current = { lx, ly, az }
  }, [])

  // Safety net: the instant walk mode is lost (known non-walk mode, or unrecognized/undefined),
  // stop any residual motion instead of leaving the last nonzero command in effect.
  const wasWalkModeRef = useRef(isWalkMode)
  useEffect(() => {
    if (wasWalkModeRef.current && !isWalkMode) {
      const { lx, ly, az } = lastCmdRef.current
      if (lx !== 0 || ly !== 0 || az !== 0) sendCmdVel(0, 0, 0)
    }
    wasWalkModeRef.current = isWalkMode
  }, [isWalkMode, sendCmdVel])

  // Lock speed to HIGH when gamepad takes over
  useEffect(() => {
    if (joyActive) setSpeedLevel('HIGH')
  }, [joyActive])

  // Keyboard → publish quadruped velocity
  useEffect(() => {
    if (joyActive) {
      // Gamepad just took over — don't let a stale held-key command keep being
      // repeated by the interval below while the gamepad has control.
      desiredCmdRef.current = { lx: 0, ly: 0, az: 0 }
      isMovingRef.current = false
      return
    }

    const shift = heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight')

    let lx = 0, ly = 0, az = 0

    if (heldKeys.has('ArrowUp'))   lx += speed
    if (heldKeys.has('ArrowDown')) lx -= speed

    if (!shift) {
      if (heldKeys.has('ArrowLeft'))  ly += speed
      if (heldKeys.has('ArrowRight')) ly -= speed
    } else {
      if (heldKeys.has('ArrowLeft'))  az += speed
      if (heldKeys.has('ArrowRight')) az -= speed
    }

    const isMoving = lx !== 0 || ly !== 0 || az !== 0
    const wasMoving = isMovingRef.current
    desiredCmdRef.current = { lx, ly, az }
    isMovingRef.current = isMoving

    if (isWalkMode) {
      if (isMoving || wasMoving) {
        sendCmdVel(lx, ly, az)
      }
    }

    setJoyDisplay(isWalkMode ? { x: lx, y: ly, yaw: az } : { x: 0, y: 0, yaw: 0 })
  }, [heldKeys, isWalkMode, speedLevel, joyActive, speed, sendCmdVel])

  // Repeat-publish at 4Hz while a key is held or the joystick is pinned at a nonzero
  // deflection — otherwise the backend has no way to tell the UI is still connected
  // between transitions, and its patience timeout would (correctly) stop the robot.
  useEffect(() => {
    const id = setInterval(() => {
      if (joyActiveRef.current || !isWalkModeRef.current || !isMovingRef.current) return
      const { lx, ly, az } = desiredCmdRef.current
      sendCmdVel(lx, ly, az)
    }, 250)
    return () => clearInterval(id)
  }, [sendCmdVel])

  // Reflect /joy msg in display when gamepad is connected
  useEffect(() => {
    if (!joyActive || !joyMsg?.axes) return
    setJoyDisplay({
      x:   joyMsg.axes[1] ?? 0,
      y:   joyMsg.axes[0] ?? 0,
      yaw: -(joyMsg.axes[5] ?? 0),
    })
  }, [joyActive, joyMsg])

  // Drag callbacks — publish directly, independent of keyboard effect
  const handleJoyDrag = useCallback((x, y) => {
    desiredCmdRef.current = { ...desiredCmdRef.current, lx: x, ly: y }
    const { lx, ly, az } = desiredCmdRef.current
    isMovingRef.current = lx !== 0 || ly !== 0 || az !== 0
    if (isWalkModeRef.current) sendCmdVel(lx, ly, az)
    setJoyDisplay(prev => ({ ...prev, x, y }))
  }, [sendCmdVel])

  const handleYawDrag = useCallback((v) => {
    desiredCmdRef.current = { ...desiredCmdRef.current, az: v }
    const { lx, ly, az } = desiredCmdRef.current
    isMovingRef.current = lx !== 0 || ly !== 0 || az !== 0
    if (isWalkModeRef.current) sendCmdVel(lx, ly, az)
    setJoyDisplay(prev => ({ ...prev, yaw: v }))
  }, [sendCmdVel])

  function requestModeChange(newMode) {
    // Skip the adjacency check when the current real mode isn't known —
    // there's nothing safe to validate against, so let the operator try.
    if (actualMode !== undefined && Math.abs(newMode - actualMode) !== 1) return
    setPendingMode(newMode)
    setModalOpen(true)
  }

  function confirmModeChange() {
    const cmd = MODE_SERVICE_CMD[pendingMode]
    setModalOpen(false)
    setServiceStatus({ loading: true, lastResult: null })
    callService(
      '/quadruped_controller/quadruped_cmd',
      cmd,
      (res) => setServiceStatus({ loading: false, lastResult: res.message ?? 'OK' }),
      (err) => setServiceStatus({ loading: false, lastResult: `Error: ${err}` })
    )
    setPendingMode(null)
  }

  const { x: joystickX, y: joystickY, yaw: yawVal } = joyDisplay

  return (
    <>
      <WarningModal
        open={modalOpen}
        fromMode={actualMode}
        toMode={pendingMode}
        onConfirm={confirmModeChange}
        onCancel={() => { setModalOpen(false); setPendingMode(null) }}
      />

      <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
        {/* Title bar */}
        <div className="panel-header">
          <span>QUADRUPED CONTROL</span>
          <div className="flex items-center gap-2" style={{ overflow: 'hidden', minWidth: 0 }}>
            {serviceStatus.loading && (
              <span style={{ color: 'var(--accent-blue)', fontSize: 10, flexShrink: 0 }}>sending…</span>
            )}
            {serviceStatus.lastResult && !serviceStatus.loading && (
              <span style={{ color: 'var(--text-dim)', fontSize: 10, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {serviceStatus.lastResult}
              </span>
            )}
            <span
              style={{
                width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                flexShrink: 0,
                background: joyActive ? 'var(--accent-blue)' : (isWalkMode ? '#22C55E' : 'var(--border)'),
              }}
              title={joyActive ? 'Gamepad active' : (actualMode !== undefined ? `Mode ${actualMode}` : 'Mode unknown')}
            />
          </div>
        </div>

        {(modeFault || !statusActive) && (
          <div
            className="flash-warn"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: '#EF4444',
              padding: '4px 12px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            {modeFault
              ? '⚠ UNKNOWN ROBOT MODE — MOVEMENT DISABLED'
              : '⚠ NO STATUS FEED — MOVEMENT DISABLED'}
          </div>
        )}

        {/* Main content */}
        <div className="flex flex-1 min-h-0 gap-0">
          {/* Left: controls — side-by-side GearShift + SpeedSelector, hints pinned to bottom */}
          <div
            className="flex flex-col gap-3 p-3 flex-shrink-0"
            style={{ minWidth: 300, height: '100%' }}
          >
            <div className="flex gap-2" style={{ flex: 1, minHeight: 0, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <GearShift
                  mode={actualMode}
                  onModeChange={requestModeChange}
                  disabled={serviceStatus.loading || joyActive}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <SpeedSelector speed={speedLevel} onChange={setSpeedLevel} disabled={joyActive} />
              </div>
            </div>

            {/* Key hints — keyboard mode */}
            {!joyActive && (
              <div
                className="flex flex-col gap-0.5"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--text-dim)',
                  marginTop: 'auto',
                }}
              >
                <span>↑↓ Forward/Back  ←→ Strafe</span>
                <span>⇧+←→ Yaw</span>
                <span style={{ color: isWalkMode ? '#22C55E' : '#EF4444', fontSize: 11 }}>
                  {isWalkMode ? '✓ Walk — joystick active' : '✗ Walk mode required'}
                </span>
              </div>
            )}

            {/* Walk mode warning when gamepad active but not in WALK */}
            {joyActive && !isWalkMode && (
              <span
                className="flash-warn"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: '#EF4444',
                  marginTop: 'auto',
                }}
              >
                ✗ Walk mode required
              </span>
            )}

            <Toast visible={joyActive} message="Gamepad active — UI joystick disabled" />
          </div>

          {/* Right: TRANSLATION joystick + ROTATION knob (vertical) */}
          <div
            className="flex flex-1 items-center justify-center gap-4 p-4"
            style={{ borderLeft: '1px solid var(--border)' }}
          >
            <JoystickDisplay
              x={joystickX}
              y={joystickY}
              label="TRANSLATION"
              hints={JOY_HINTS}
              size={200}
              maxValue={speed}
              onChange={!joyActive && isWalkMode ? handleJoyDrag : undefined}
            />

            <AxisKnob
              label="ROTATION"
              value={yawVal}
              orientation="v"
              trackLen={200}
              maxValue={speed}
              onChange={!joyActive && isWalkMode ? handleYawDrag : undefined}
            />
          </div>
        </div>
      </div>
    </>
  )
}
