// 'warn' is the default because this started as an error-only pill and every existing caller
// relies on that look.
const TONES = {
  warn: { color: '#DC2626', glyph: '⚠' },
  info: { color: 'var(--accent-blue)', glyph: '⟳' },
  ok: { color: '#4ADE80', glyph: '✓' },
}

export function Toast({ message, visible, tone = 'warn' }) {
  if (!visible) return null
  const { color, glyph } = TONES[tone] ?? TONES.warn
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded text-xs"
      style={{
        background: 'var(--panel-bg)',
        border: '1px solid var(--accent)',
        color,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {/* The glyph keeps the accent colour on 'warn' so the original red-text-blue-icon
          look is unchanged; the other tones read better with the glyph matching the text. */}
      <span style={{ color: tone === 'warn' ? 'var(--accent-blue)' : color }}>{glyph}</span>
      {message}
    </div>
  )
}
