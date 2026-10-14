import { useLayoutEffect, useRef, useState } from 'react'
import './tester.css'

// One line that slides back and forth when it does not fit, so a long name stays readable.
// Short text, and reduced motion, get a plain line with an ellipsis instead.
export function MarqueeText({ text, style }) {
  const boxRef = useRef(null)
  const textRef = useRef(null)
  const [shift, setShift] = useState(0)

  useLayoutEffect(() => {
    const box = boxRef.current
    const span = textRef.current
    if (!box || !span) return undefined
    // clientWidth includes the padding the text cannot use.
    const measure = () => {
      const cs = getComputedStyle(box)
      const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      setShift(Math.max(0, Math.ceil(span.scrollWidth - room)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [text])

  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const scroll = shift > 0 && !reduce

  return (
    <div ref={boxRef} title={text} style={{ overflow: 'hidden', whiteSpace: 'nowrap', ...style }}>
      <span
        ref={textRef}
        className={scroll ? 'npt-marquee' : undefined}
        style={scroll
          ? { '--npt-shift': `-${shift}px`, '--npt-duration': `${Math.max(3, shift / 25)}s` }
          : {
            display: 'inline-block', maxWidth: '100%', overflow: 'hidden',
            textOverflow: 'ellipsis', verticalAlign: 'top',
          }}
      >
        {text}
      </span>
    </div>
  )
}
