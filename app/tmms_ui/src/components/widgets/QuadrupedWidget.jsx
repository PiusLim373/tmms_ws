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

// ROS convention: +x = forward, +y = left
// JoystickDisplay: x prop = forward/back, y prop = left/right
const JOY_HINTS = { up: '↑', down: '↓', left: '←', right: '→' }

export function QuadrupedWidget({ heldKeys }) {
  const [gearMode, setGearMode]     = useState(1)
  const [speedLevel, setSpeedLevel] = useState('MID')
  const [modalOpen, setModalOpen]   = useState(false)
  const [pendingMode, setPendingMode] = useState(null)
  const [serviceStatus, setServiceStatus] = useState({ loading: false, lastResult: null })
  const [joyDisplay, setJoyDisplay] = useState({ x: 0, y: 0, yaw: 0 })

  const speed = SPEED_MAP[speedLevel]

  const wasMovingRef  = useRef(false)
  const gearModeRef   = useRef(gearMode)
  useEffect(() => { gearModeRef.current = gearMode }, [gearMode])

  const { active: joyActive, lastMsg: joyMsg } = useTopicActivity('/joy', 'sensor_msgs/Joy', 500)

  // Lock speed to HIGH when gamepad takes over
  useEffect(() => {
    if (joyActive) setSpeedLevel('HIGH')
  }, [joyActive])

  // Keyboard → publish quadruped velocity
  useEffect(() => {
    if (joyActive) return

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

    if (gearMode === 3) {
      if (isMoving || wasMovingRef.current) {
        publishQuadrupedCmdVel(lx, ly, az)
      }
    }
    wasMovingRef.current = isMoving

    setJoyDisplay({ x: lx, y: ly, yaw: az })
  }, [heldKeys, gearMode, speedLevel, joyActive, speed])

  // Reflect /joy msg in display when gamepad is connected
  useEffect(() => {
    if (!joyActive || !joyMsg?.axes) return
    setJoyDisplay({
      x:   joyMsg.axes[0] ?? 0,
      y:   joyMsg.axes[1] ?? 0,
      yaw: -(joyMsg.axes[5] ?? 0),
    })
  }, [joyActive, joyMsg])

  // Drag callbacks — publish directly, independent of keyboard effect
  const handleJoyDrag = useCallback((x, y) => {
    if (gearModeRef.current === 3) publishQuadrupedCmdVel(x, y, 0)
    setJoyDisplay(prev => ({ ...prev, x, y }))
  }, [])

  const handleYawDrag = useCallback((v) => {
    if (gearModeRef.current === 3) publishQuadrupedCmdVel(0, 0, v)
    setJoyDisplay(prev => ({ ...prev, yaw: v }))
  }, [])

  function requestModeChange(newMode) {
    if (Math.abs(newMode - gearMode) !== 1) return
    setPendingMode(newMode)
    setModalOpen(true)
  }

  function confirmModeChange() {
    const cmd = MODE_SERVICE_CMD[pendingMode]
    setGearMode(pendingMode)
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
        fromMode={gearMode}
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
                background: joyActive ? 'var(--accent-blue)' : (gearMode === 3 ? '#22C55E' : 'var(--border)'),
              }}
              title={joyActive ? 'Gamepad active' : `Mode ${gearMode}`}
            />
          </div>
        </div>

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
                  mode={gearMode}
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
                <span style={{ color: gearMode === 3 ? '#22C55E' : '#EF4444', fontSize: 11 }}>
                  {gearMode === 3 ? '✓ Walk — joystick active' : '✗ Walk mode required'}
                </span>
              </div>
            )}

            {/* Walk mode warning when gamepad active but not in WALK */}
            {joyActive && gearMode !== 3 && (
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
              onChange={!joyActive && gearMode === 3 ? handleJoyDrag : undefined}
            />

            <AxisKnob
              label="ROTATION"
              value={yawVal}
              orientation="v"
              trackLen={200}
              maxValue={speed}
              onChange={!joyActive && gearMode === 3 ? handleYawDrag : undefined}
            />
          </div>
        </div>
      </div>
    </>
  )
}
