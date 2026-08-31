import { useState, useEffect } from 'react'

// Keys to prevent default browser scroll/navigation behavior
const PREVENT_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
])

// This hook is not a general keyboard reader — QuadrupedWidget turns its output straight into
// /quadruped_cmd_vel_ui, so anything that reaches heldKeys DRIVES THE ROBOT. Two guards keep
// that from firing when the operator is talking to the UI rather than the robot.

// 1. Typing. Without this, naming a map "warehouse" walks the robot: W, A and S are all
//    teleop keys, and the listener is on window with no idea a text field has focus.
function isTypingTarget(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

// 2. Full-screen tools that need the keyboard for themselves — the map editor uses space to
//    pan and B/E/L/R/C to pick tools, all of which are teleop keys. Module-level rather than
//    context/prop, because the suspending component is nowhere near the consuming one in the
//    tree and this needs to be reachable from an effect on mount.
let suspended = false
const listeners = new Set()

export function suspendKeyboard(value) {
  if (suspended === value) return
  suspended = value
  listeners.forEach((fn) => fn(value))
}

export function useKeyboard() {
  const [heldKeys, setHeldKeys] = useState(new Set())

  useEffect(() => {
    const onKeyDown = (e) => {
      if (suspended || isTypingTarget(e.target)) return
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault()
      setHeldKeys((prev) => {
        if (prev.has(e.code)) return prev  // no re-render on key repeat
        const next = new Set(prev)
        next.add(e.code)
        return next
      })
    }
    // Deliberately NOT gated on `suspended`: a key pressed before the editor opened is still
    // physically down, and dropping its keyup would latch it held forever.
    const onKeyUp = (e) => {
      setHeldKeys((prev) => {
        if (!prev.has(e.code)) return prev
        const next = new Set(prev)
        next.delete(e.code)
        return next
      })
    }

    // Clear on suspend for the same reason, from the other direction: a key held at the moment
    // the editor opens gets no keyup here, so release it now rather than leaving the robot
    // driving against a key nobody is pressing any more.
    const onSuspendChange = (value) => {
      if (value) setHeldKeys((prev) => (prev.size === 0 ? prev : new Set()))
    }
    listeners.add(onSuspendChange)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup',   onKeyUp)
    return () => {
      listeners.delete(onSuspendChange)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup',   onKeyUp)
    }
  }, [])

  return { heldKeys }
}
