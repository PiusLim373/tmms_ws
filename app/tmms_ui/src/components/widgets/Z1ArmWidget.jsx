import { useState, useEffect, useRef, useCallback } from 'react'
import { publishZ1JoyUi, callService } from '../../services/rosbridge'
import { useTopicActivity } from '../../hooks/useTopicActivity'
import { useSpaceMouse } from '../../hooks/useSpaceMouse'
import { SpeedSelector } from '../ui/SpeedSelector'
import { JoystickDisplay, AxisKnob } from '../ui/JoystickDisplay'
import { Toast } from '../ui/Toast'

const SPEED_MAP = { LOW: 0.2, MID: 0.4, HIGH: 0.7 }

const PRESETS = [
  { label: 'home',    display: 'HOME' },
  { label: 'forward', display: 'FWD'  },
  { label: 'down',    display: 'DOWN' },
  { label: 'rotate_ccw', display: 'WRIST ↺ 45°' },
  { label: 'rotate_cw',  display: 'WRIST ↻ 45°' },
]

// ROS convention: +x = forward (W/S), +y = left (A/D)
// JoystickDisplay x prop = forward/back (up/down on screen), y prop = left/right
const TRANS_HINTS = { up: 'W', down: 'S', left: 'A', right: 'D' }
const ROT_HINTS   = { up: '⇧W', down: '⇧S', left: '⇧A', right: '⇧D' }

const GROUP_LABEL_STYLE = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  color: 'var(--text-dim)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
}

export function Z1ArmWidget({ heldKeys }) {
  // Browser-native SpaceMouse capture (WebHID) — publishes directly to
  // /spacenav/joy, a drop-in replacement for the native spacenav_node. Runs
  // only while this widget is mounted; see useTopicActivity('/spacenav/joy', ...)
  // below for the resulting display/gating, unchanged from native-driver behavior.
  const spacemouse = useSpaceMouse()

  const [speedLevel, setSpeedLevel] = useState('MID')
  const [sixDof, setSixDof] = useState({ tx:0, ty:0, tz:0, rx:0, ry:0, rz:0 })
  const [gripperState, setGripperState] = useState('idle')
  const [serviceStatus, setServiceStatus] = useState({ loading: false, lastResult: null })

  const speed = SPEED_MAP[speedLevel]

  // isActiveRef doubles as edge-detection (read as "was active" before each update) and as
  // the live state the 4Hz repeat-publish interval below checks.
  const isActiveRef = useRef(false)
  const desiredCmdRef = useRef({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, btn0: 0, btn1: 0 })
  const { lastMsg: spacenavMsg } = useTopicActivity('/spacenav/joy', 'sensor_msgs/Joy', 500)
  const lastNonZeroRef = useRef(0)
  const [spacenavActive, setSpacenavActive] = useState(false)
  const spacenavActiveRef = useRef(spacenavActive)
  useEffect(() => { spacenavActiveRef.current = spacenavActive }, [spacenavActive])

  // Update lastNonZeroRef only when msg has actual movement/button input (not idle zeros)
  useEffect(() => {
    if (!spacenavMsg?.axes) return
    const hasActivity =
      spacenavMsg.axes.some(v => Math.abs(v) > 0.001) ||
      (spacenavMsg.buttons ?? []).some(b => b !== 0)
    if (hasActivity) lastNonZeroRef.current = Date.now()
  }, [spacenavMsg])

  // 200ms poll — 2s grace period mirrors backend logic
  useEffect(() => {
    const interval = setInterval(() => {
      const isActive = lastNonZeroRef.current > 0 &&
                       (Date.now() - lastNonZeroRef.current) < 2000
      setSpacenavActive(prev => prev !== isActive ? isActive : prev)
    }, 200)
    return () => clearInterval(interval)
  }, [])

  // Lock speed to HIGH when SpaceNav takes over
  useEffect(() => {
    if (spacenavActive) setSpeedLevel('HIGH')
  }, [spacenavActive])

  // Keyboard → publish z1 joy
  useEffect(() => {
    if (spacenavActive) {
      // SpaceMouse just took over — don't let a stale held-key command keep being
      // repeated by the interval below while the SpaceMouse has control.
      desiredCmdRef.current = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, btn0: 0, btn1: 0 }
      isActiveRef.current = false
      return
    }
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const shift = heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight')

    let tx=0, ty=0, tz=0, rx=0, ry=0, rz=0

    if (!shift) {
      if (heldKeys.has('KeyW')) tx += speed
      if (heldKeys.has('KeyS')) tx -= speed
      if (heldKeys.has('KeyA')) ty += speed
      if (heldKeys.has('KeyD')) ty -= speed
      if (heldKeys.has('KeyE')) tz += speed
      if (heldKeys.has('KeyQ')) tz -= speed
    } else {
      if (heldKeys.has('KeyW')) ry += speed
      if (heldKeys.has('KeyS')) ry -= speed
      if (heldKeys.has('KeyA')) rx -= speed
      if (heldKeys.has('KeyD')) rx += speed
      if (heldKeys.has('KeyE')) rz += speed
      if (heldKeys.has('KeyQ')) rz -= speed
    }

    let btn0 = 0, btn1 = 0
    if (heldKeys.has('KeyX'))      { btn0 = 0; btn1 = 1 }
    else if (heldKeys.has('KeyZ')) { btn0 = 1; btn1 = 0 }

    const axes    = [tx, ty, tz, rx, ry, rz]
    const buttons = [btn0, btn1]
    const isPublishing = axes.some((v) => v !== 0) || btn0 !== 0 || btn1 !== 0
    const wasPublishing = isActiveRef.current
    desiredCmdRef.current = { tx, ty, tz, rx, ry, rz, btn0, btn1 }
    isActiveRef.current = isPublishing

    if (isPublishing || wasPublishing) {
      publishZ1JoyUi(axes, buttons)
    }

    setSixDof({ tx, ty, tz, rx, ry, rz })
    setGripperState(btn1 === 1 ? 'open' : btn0 === 1 ? 'close' : 'idle')
  }, [heldKeys, speedLevel, spacenavActive, speed])

  // Repeat-publish at 4Hz while a key is held or a drag/gripper button is active —
  // otherwise the backend has no way to tell the UI is still connected between
  // transitions, and its patience timeout would (correctly) stop the arm.
  useEffect(() => {
    const id = setInterval(() => {
      if (spacenavActiveRef.current || !isActiveRef.current) return
      const c = desiredCmdRef.current
      publishZ1JoyUi([c.tx, c.ty, c.tz, c.rx, c.ry, c.rz], [c.btn0, c.btn1])
    }, 250)
    return () => clearInterval(id)
  }, [])

  // Reflect spacenav msg in display
  useEffect(() => {
    if (!spacenavActive || !spacenavMsg?.axes) return
    const a = spacenavMsg.axes
    setSixDof({
      tx: a[0] ?? 0, ty: a[1] ?? 0, tz: a[2] ?? 0,
      rx: a[3] ?? 0, ry: a[4] ?? 0, rz: a[5] ?? 0,
    })
    const b = spacenavMsg.buttons ?? []
    const b0 = b[0] ?? 0, b1 = b[1] ?? 0
    setGripperState(b1 === 1 ? 'open' : b0 === 1 ? 'close' : 'idle')
  }, [spacenavActive, spacenavMsg])

  function callPreset(label) {
    setServiceStatus({ loading: true, lastResult: null })
    callService(
      '/z1_robot_controller/arm_preset',
      label,
      (res) => setServiceStatus({ loading: false, lastResult: res.message ?? 'OK' }),
      (err) => setServiceStatus({ loading: false, lastResult: `Error: ${err}` })
    )
  }

  // Drag callbacks — publish directly. Each sends a full, exclusive 8-value snapshot
  // (everything it doesn't own zeroed out), so desiredCmdRef is just assigned wholesale.
  const handleTransDrag = useCallback((x, y) => {
    const cmd = { tx: x, ty: y, tz: 0, rx: 0, ry: 0, rz: 0, btn0: 0, btn1: 0 }
    desiredCmdRef.current = cmd
    isActiveRef.current = x !== 0 || y !== 0
    publishZ1JoyUi([cmd.tx, cmd.ty, cmd.tz, cmd.rx, cmd.ry, cmd.rz], [cmd.btn0, cmd.btn1])
    setSixDof(prev => ({ ...prev, tx: x, ty: y }))
  }, [])

  const handleRotDrag = useCallback((x, y) => {
    // drag right (y-) → +rx, drag up (x+) → +ry
    const cmd = { tx: 0, ty: 0, tz: 0, rx: -y, ry: x, rz: 0, btn0: 0, btn1: 0 }
    desiredCmdRef.current = cmd
    isActiveRef.current = x !== 0 || y !== 0
    publishZ1JoyUi([cmd.tx, cmd.ty, cmd.tz, cmd.rx, cmd.ry, cmd.rz], [cmd.btn0, cmd.btn1])
    setSixDof(prev => ({ ...prev, rx: -y, ry: x }))
  }, [])

  const handleTzDrag = useCallback((v) => {
    const cmd = { tx: 0, ty: 0, tz: v, rx: 0, ry: 0, rz: 0, btn0: 0, btn1: 0 }
    desiredCmdRef.current = cmd
    isActiveRef.current = v !== 0
    publishZ1JoyUi([cmd.tx, cmd.ty, cmd.tz, cmd.rx, cmd.ry, cmd.rz], [cmd.btn0, cmd.btn1])
    setSixDof(prev => ({ ...prev, tz: v }))
  }, [])

  const handleRzDrag = useCallback((v) => {
    const cmd = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: v, btn0: 0, btn1: 0 }
    desiredCmdRef.current = cmd
    isActiveRef.current = v !== 0
    publishZ1JoyUi([cmd.tx, cmd.ty, cmd.tz, cmd.rx, cmd.ry, cmd.rz], [cmd.btn0, cmd.btn1])
    setSixDof(prev => ({ ...prev, rz: v }))
  }, [])

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      {/* Title bar */}
      <div className="panel-header">
        <span>Z1 ARM CONTROL</span>
        <div className="flex items-center gap-2" style={{ overflow: 'hidden', minWidth: 0 }}>
          {serviceStatus.loading && (
            <span style={{ color: 'var(--accent-blue)', fontSize: 10, flexShrink: 0 }}>sending…</span>
          )}
          {serviceStatus.lastResult && !serviceStatus.loading && (
            <span style={{ color: 'var(--text-dim)', fontSize: 10, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {serviceStatus.lastResult}
            </span>
          )}

          {spacemouse.connected ? (
            <div className="flex items-center gap-1.5" title={spacemouse.deviceName} style={{ flexShrink: 0 }}>
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                  background: '#22C55E',
                }}
              />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {spacemouse.deviceName}
              </span>
            </div>
          ) : (
            <button
              onClick={spacemouse.connect}
              title={spacemouse.error || 'Connect a SpaceMouse via WebHID'}
              style={{
                flexShrink: 0,
                padding: '2px 8px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.04em',
                borderRadius: 4,
                border: `1px solid ${spacemouse.error ? '#EF4444' : 'var(--border)'}`,
                background: 'transparent',
                color: spacemouse.error ? '#EF4444' : 'var(--text-dim)',
                cursor: 'pointer',
              }}
            >
              Connect SpaceMouse
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0 gap-0">
        {/* Left: arm presets + speed side-by-side, hints pinned to bottom */}
        <div
          className="flex flex-col gap-3 p-3 flex-shrink-0"
          style={{ minWidth: 300, height: '100%' }}
        >
          <div className="flex gap-2" style={{ flex: 1, minHeight: 0, alignItems: 'flex-start' }}>
            {/* ARM PRESET column */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--text-dim)',
                  letterSpacing: '0.06em',
                  marginBottom: 8,
                }}
              >
                ARM PRESET
              </div>
              <div className="flex flex-col gap-1">
                {PRESETS.map(({ label, display }) => (
                  <button
                    key={label}
                    disabled={serviceStatus.loading}
                    onClick={(e) => { e.currentTarget.blur(); callPreset(label) }}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      letterSpacing: '0.08em',
                      textAlign: 'center',
                      borderRadius: 4,
                      border: '1px solid var(--border)',
                      background: 'transparent',
                      color: serviceStatus.loading ? 'var(--border)' : 'var(--text)',
                      cursor: serviceStatus.loading ? 'not-allowed' : 'pointer',
                      opacity: serviceStatus.loading ? 0.5 : 1,
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      if (!serviceStatus.loading) {
                        e.currentTarget.style.borderColor = 'var(--accent-bright)'
                        e.currentTarget.style.color = 'var(--text-h)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!serviceStatus.loading) {
                        e.currentTarget.style.borderColor = 'var(--border)'
                        e.currentTarget.style.color = 'var(--text)'
                      }
                    }}
                  >
                    {display}
                  </button>
                ))}
              </div>
            </div>

            {/* SPEED column */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <SpeedSelector speed={speedLevel} onChange={setSpeedLevel} disabled={spacenavActive} />
            </div>
          </div>

          {/* Key hints pinned to bottom */}
          {!spacenavActive && (
            <div
              className="flex flex-col gap-0.5"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-dim)',
                marginTop: 'auto',
              }}
            >
              <span>WASD → TX/TY  QE → TZ</span>
              <span>⇧+WASDQE → RPY</span>
              <span>X = open  Z = close</span>
            </div>
          )}

          <Toast visible={spacenavActive} message="SpaceMouse active — UI joystick disabled" />
        </div>

        {/* Right: two labeled groups [joystick + Z-knob] + gripper buttons */}
        <div
          className="flex flex-1 flex-col min-h-0"
          style={{ borderLeft: '1px solid var(--border)' }}
        >
          {/* Joystick pairs */}
          <div className="flex flex-1 items-center justify-center gap-6 p-3 flex-wrap">

            {/* TRANSLATION group: XY joystick + TZ knob */}
            <div className="flex flex-col items-center gap-1">
              <span style={GROUP_LABEL_STYLE}>TRANSLATION</span>
              <div className="flex items-end gap-2">
                <JoystickDisplay
                  x={sixDof.tx}
                  y={sixDof.ty}
                  hints={TRANS_HINTS}
                  size={200}
                  xLabel="tx"
                  yLabel="ty"
                  maxValue={speed}
                  onChange={spacenavActive ? undefined : handleTransDrag}
                />
                <AxisKnob
                  label="TZ"
                  value={sixDof.tz}
                  trackLen={200}
                  maxValue={speed}
                  hints={{ up: 'E', down: 'Q' }}
                  onChange={spacenavActive ? undefined : handleTzDrag}
                />
              </div>
            </div>

            {/* ROTATION group: RPY joystick + RZ knob */}
            <div className="flex flex-col items-center gap-1">
              <span style={GROUP_LABEL_STYLE}>ROTATION</span>
              <div className="flex items-end gap-2">
                <JoystickDisplay
                  x={sixDof.ry}
                  y={-sixDof.rx}
                  hints={ROT_HINTS}
                  size={200}
                  xLabel="ry"
                  yLabel="rx"
                  maxValue={speed}
                  onChange={spacenavActive ? undefined : handleRotDrag}
                />
                <AxisKnob
                  label="RZ"
                  value={sixDof.rz}
                  trackLen={200}
                  maxValue={speed}
                  hints={{ up: '⇧E', down: '⇧Q' }}
                  onChange={spacenavActive ? undefined : handleRzDrag}
                />
              </div>
            </div>
          </div>

          {/* Gripper buttons — flush with knob area, no divider */}
          <div
            className="flex items-center justify-center gap-4 flex-shrink-0"
            style={{ padding: '8px 16px 12px' }}
          >
            <button
              disabled={spacenavActive}
              onPointerDown={() => {
                desiredCmdRef.current = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, btn0:1, btn1:0 }
                isActiveRef.current = true
                publishZ1JoyUi([0,0,0,0,0,0], [1,0]); setGripperState('close')
              }}
              onPointerUp={() => {
                desiredCmdRef.current = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, btn0:0, btn1:0 }
                isActiveRef.current = false
                publishZ1JoyUi([0,0,0,0,0,0], [0,0]); setGripperState('idle')
              }}
              onPointerLeave={() => {
                desiredCmdRef.current = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, btn0:0, btn1:0 }
                isActiveRef.current = false
                publishZ1JoyUi([0,0,0,0,0,0], [0,0]); setGripperState('idle')
              }}
              style={{
                flex: 1,
                maxWidth: 160,
                padding: '10px 0',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                letterSpacing: '0.08em',
                borderRadius: 4,
                border: gripperState === 'close'
                  ? '1px solid var(--accent-bright)'
                  : '1px solid var(--border)',
                background: gripperState === 'close' ? 'var(--accent)' : 'transparent',
                color: gripperState === 'close' ? 'var(--text-h)' : 'var(--text-dim)',
                cursor: spacenavActive ? 'not-allowed' : 'pointer',
                opacity: spacenavActive ? 0.35 : 1,
                pointerEvents: spacenavActive ? 'none' : 'auto',
                transition: 'all 0.1s',
              }}
              onMouseEnter={spacenavActive ? undefined : (e) => {
                if (gripperState !== 'close') {
                  e.currentTarget.style.borderColor = 'var(--accent-bright)'
                  e.currentTarget.style.color = 'var(--text-h)'
                }
              }}
              onMouseLeave={spacenavActive ? undefined : (e) => {
                if (gripperState !== 'close') {
                  e.currentTarget.style.borderColor = 'var(--border)'
                  e.currentTarget.style.color = 'var(--text-dim)'
                }
              }}
            >
              CLOSE
              <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 6 }}>Z</span>
            </button>

            <button
              disabled={spacenavActive}
              onPointerDown={() => {
                desiredCmdRef.current = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, btn0:0, btn1:1 }
                isActiveRef.current = true
                publishZ1JoyUi([0,0,0,0,0,0], [0,1]); setGripperState('open')
              }}
              onPointerUp={() => {
                desiredCmdRef.current = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, btn0:0, btn1:0 }
                isActiveRef.current = false
                publishZ1JoyUi([0,0,0,0,0,0], [0,0]); setGripperState('idle')
              }}
              onPointerLeave={() => {
                desiredCmdRef.current = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, btn0:0, btn1:0 }
                isActiveRef.current = false
                publishZ1JoyUi([0,0,0,0,0,0], [0,0]); setGripperState('idle')
              }}
              style={{
                flex: 1,
                maxWidth: 160,
                padding: '10px 0',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                letterSpacing: '0.08em',
                borderRadius: 4,
                border: gripperState === 'open'
                  ? '1px solid var(--accent-bright)'
                  : '1px solid var(--border)',
                background: gripperState === 'open' ? 'var(--accent)' : 'transparent',
                color: gripperState === 'open' ? 'var(--text-h)' : 'var(--text-dim)',
                cursor: spacenavActive ? 'not-allowed' : 'pointer',
                opacity: spacenavActive ? 0.35 : 1,
                pointerEvents: spacenavActive ? 'none' : 'auto',
                transition: 'all 0.1s',
              }}
              onMouseEnter={spacenavActive ? undefined : (e) => {
                if (gripperState !== 'open') {
                  e.currentTarget.style.borderColor = 'var(--accent-bright)'
                  e.currentTarget.style.color = 'var(--text-h)'
                }
              }}
              onMouseLeave={spacenavActive ? undefined : (e) => {
                if (gripperState !== 'open') {
                  e.currentTarget.style.borderColor = 'var(--border)'
                  e.currentTarget.style.color = 'var(--text-dim)'
                }
              }}
            >
              OPEN
              <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 6 }}>X</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
