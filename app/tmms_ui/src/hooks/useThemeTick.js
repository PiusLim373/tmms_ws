import { useEffect, useState } from 'react'

export function useThemeTick() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const target = document.documentElement
    const mo = new MutationObserver(() => setTick((t) => t + 1))
    mo.observe(target, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  return tick
}
