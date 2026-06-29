import { useState, useEffect } from 'react'

// Keys to prevent default browser scroll/navigation behavior
const PREVENT_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
])

export function useKeyboard() {
  const [heldKeys, setHeldKeys] = useState(new Set())

  useEffect(() => {
    const onKeyDown = (e) => {
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault()
      setHeldKeys((prev) => {
        if (prev.has(e.code)) return prev  // no re-render on key repeat
        const next = new Set(prev)
        next.add(e.code)
        return next
      })
    }
    const onKeyUp = (e) => {
      setHeldKeys((prev) => {
        if (!prev.has(e.code)) return prev
        const next = new Set(prev)
        next.delete(e.code)
        return next
      })
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup',   onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup',   onKeyUp)
    }
  }, [])

  return { heldKeys }
}
