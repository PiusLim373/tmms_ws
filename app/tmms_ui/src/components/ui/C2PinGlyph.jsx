import { PIN_META } from '../../lib/c2Pins'

export function C2PinGlyph({ type, size = 16 }) {
  const color = `var(${PIN_META[type]?.colorVar ?? '--text-dim'})`
  const common = { width: size, height: size, viewBox: '0 0 24 24', style: { flexShrink: 0 } }

  if (type === 'simple') {
    return (
      <svg {...common}>
        <circle
          cx="12" cy="12" r="8"
          fill="none" stroke={color} strokeWidth="3.2" strokeDasharray="4.6 3.2"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="2.8" fill={color} />
      </svg>
    )
  }
  if (type === 'home') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9.5" fill={color} stroke="#fff" strokeWidth="1.6" />
        <text
          x="12" y="12" fill="#fff" fontSize="13" fontWeight="700"
          textAnchor="middle" dominantBaseline="central"
          fontFamily="Inter, system-ui, sans-serif"
        >
          H
        </text>
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9.5" fill={color} stroke="#fff" strokeWidth="1.6" />
    </svg>
  )
}
