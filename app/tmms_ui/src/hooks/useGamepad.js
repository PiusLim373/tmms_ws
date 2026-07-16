import { useEffect, useState } from 'react'
import { publishJoy } from '../services/rosbridge'

// Confirmed by comparing this specific flight controller's raw Gamepad API
// axes against a live `ros2 topic echo /joy`: axes 0, 1, and 5 are inverted
// relative to what joy_node publishes for the same physical stick position;
// every other axis and every button index already lines up 1:1.
function toJoy(axes, buttons) {
  return {
    axes: axes.map((v, i) => (i === 0 || i === 1 || i === 5 ? -v : v)),
    buttons: buttons.map((b) => (b.pressed ? 1 : 0)),
  }
}

// On Windows, 3Dconnexion devices are also exposed as a legacy
// joystick-compatible HID interface, so the SpaceMouse shows up in
// navigator.getGamepads() too (in addition to WebHID) — 256f is
// 3Dconnexion's USB vendor ID (covers every SpaceMouse model, not just
// this specific one), present in the gamepad id string on every
// browser/OS combination that surfaces it this way. Without this filter
// the flight controller's axis transform gets applied to SpaceMouse
// movements and published to /joy, making the quadruped react to
// arm-control input.
const SPACEMOUSE_ID_PATTERN = /256f|spacemouse/i

// Polls the Gamepad API and publishes a /joy-compatible sensor_msgs/Joy on
// every tick a controller is connected — a drop-in browser replacement for
// joy_node. Self-contained: stops polling/publishing on unmount, so
// navigating away from the widget that calls this stops driving the robot.
export function useGamepad() {
  const [gamepad, setGamepad] = useState(null)

  useEffect(() => {
    let rafId
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const pad = Array.from(pads).find((p) => p && p.connected && !SPACEMOUSE_ID_PATTERN.test(p.id))
      if (pad) {
        const axes = Array.from(pad.axes)
        const buttons = pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value }))
        setGamepad({ id: pad.id, axes, buttons })
        const msg = toJoy(axes, buttons)
        publishJoy(msg.axes, msg.buttons)
      } else {
        setGamepad(null)
      }
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return gamepad
}
