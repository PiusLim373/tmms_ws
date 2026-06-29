export function Toast({ message, visible }) {
  if (!visible) return null
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded text-xs"
      style={{
        background: 'var(--panel-bg)',
        border: '1px solid var(--accent)',
        color: '#DC2626',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span style={{ color: 'var(--accent-blue)' }}>⚠</span>
      {message}
    </div>
  )
}
