
function formatBytes(bytes) {
  if (!bytes) return null
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

export function C2LoadMapWidget({
  maps, loading, selectedName, onSelect, onRequestUpload, onRefresh, error, busy = false,
}) {
  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>LOAD MAP</span>
        <button
          onClick={onRefresh}
          className="btn-icon"
          style={{ padding: '2px 8px', fontSize: 11 }}
          title="Re-read the robot's map store"
        >
          ⟳
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          The .png and its .yaml — both are needed.
        </div>
        <div>
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '6px 10px' }}
            onClick={onRequestUpload}
            disabled={busy}
          >
            ⬆ Upload .png + .yaml
          </button>
        </div>
        {error && (
          <div style={{ fontSize: 11, color: '#EF4444', lineHeight: 1.4 }}>{error}</div>
        )}
        {loading && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Reading the map store…</div>
        )}
        {!loading && maps.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No maps.</div>
        )}
        {maps.map((m) => {
          const active = m.name === selectedName
          return (
            <div
              key={m.name}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '6px 8px', borderRadius: 4,
                border: '1px solid var(--border)',
                borderLeft: active ? '3px solid var(--accent-bright)' : '3px solid transparent',
                background: active ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-h)', wordBreak: 'break-all' }}>
                  {m.name}
                  {active && <span style={{ color: 'var(--text-dim)' }}> · shown</span>}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                  {m.width}×{m.height} px
                  {m.resolution ? ` · ${m.resolution} m/px` : ''}
                  {m.pngBytes ? ` · ${formatBytes(m.pngBytes)}` : ''}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                  {m.source === 'upload' ? 'from this machine' : 'in the map store'}
                </div>
              </div>
              <button
                onClick={() => onSelect(m.name)}
                disabled={busy || active}
                className="btn-icon"
                style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }}
              >
                {active ? 'Shown' : 'Show'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
