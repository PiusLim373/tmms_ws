import { C2PinGlyph } from '../components/ui/C2PinGlyph'
import { CANVAS_TYPE, SWITCH_FILL } from './lib/routeStyle'

// C2's glyph for the types it knows; for a map switch, the solid blue disc C2MapCanvas draws,
// marked ⇄, and a dashed outline while it waits for its pair.
export function TypeGlyph({ type, size = 14, unlinked = false }) {
  if (type !== 'map_switch') return <C2PinGlyph type={CANVAS_TYPE[type]} size={size} />
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <circle
        cx="12" cy="12" r="9.5"
        fill={unlinked ? 'none' : SWITCH_FILL}
        stroke={unlinked ? SWITCH_FILL : '#fff'}
        strokeWidth={unlinked ? 2.4 : 1.6}
        strokeDasharray={unlinked ? '4 3' : undefined}
      />
      {!unlinked && (
        <text
          x="12" y="12.5" fill="#fff" fontSize="12" fontWeight="700"
          textAnchor="middle" dominantBaseline="central"
          fontFamily="Inter, system-ui, sans-serif"
        >
          ⇄
        </text>
      )}
    </svg>
  )
}
