
export function ZoomControls({ onZoomIn, onZoomOut, onFit, zoom }) {
  return (
    <div className="flex flex-col items-end gap-1" style={{ pointerEvents: 'auto' }}>
      <div className="panel flex flex-col" style={{ borderRadius: 4, overflow: 'hidden' }}>
        <button className="btn-icon" style={SQUARE} onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">
          <Plus />
        </button>
        <div style={{ height: 1, background: 'var(--border)' }} />
        <button className="btn-icon" style={SQUARE} onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">
          <Minus />
        </button>
      </div>
      <button
        className="btn-icon panel"
        style={SQUARE}
        onClick={onFit}
        title="Fit the whole map in the view"
        aria-label="Fit map to view"
      >
        <Fit />
      </button>
      {zoom != null && (
        <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {zoom >= 1 ? `${zoom.toFixed(1)}×` : `${zoom.toFixed(2)}×`}
        </span>
      )}
    </div>
  )
}

const SQUARE = { width: 28, height: 28, borderRadius: 0, border: 'none', padding: 0 }

export function ViewToggle({ mode, onChange, threeDisabled = true }) {
  return (
    <div className="panel flex" style={{ borderRadius: 4, overflow: 'hidden', pointerEvents: 'auto' }}>
      {['2D', '3D'].map((m) => {
        const active = m === mode
        const disabled = m === '3D' && threeDisabled
        return (
          <button
            key={m}
            disabled={disabled}
            onClick={() => onChange(m)}
            title={disabled ? '3D point-cloud view — not built yet' : `${m} view`}
            style={{
              padding: '5px 12px',
              border: 'none',
              background: active ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
              color: active ? 'var(--accent-bright)' : 'var(--text-dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.06em',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.4 : 1,
            }}
          >
            {m}
          </button>
        )
      })}
    </div>
  )
}

export function ScaleBar({ scale, resolution }) {
  if (!scale || !resolution) return null
  const pxPerMetre = scale / resolution
  const rawMetres = 80 / pxPerMetre
  const pow = Math.pow(10, Math.floor(Math.log10(rawMetres)))
  const metres = [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= rawMetres) ?? 10 * pow
  const widthPx = metres * pxPerMetre

  return (
    <div className="flex items-end gap-2" style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'relative', width: widthPx, height: 9 }}>
        <div style={{ position: 'absolute', inset: 'auto 0 0 0', height: 2, background: 'var(--text)' }} />
        <div style={{ position: 'absolute', left: 0, bottom: 0, width: 2, height: 7, background: 'var(--text)' }} />
        <div style={{ position: 'absolute', right: 0, bottom: 0, width: 2, height: 7, background: 'var(--text)' }} />
      </div>
      <span className="val-mono" style={{ fontSize: 10, lineHeight: '9px' }}>
        {metres >= 1 ? metres : metres.toFixed(1)} m
      </span>
    </div>
  )
}

export function CoordReadout({ world }) {
  return (
    <span
      className="val-mono"
      style={{ fontSize: 10, color: world ? 'var(--text)' : 'var(--text-dim)', pointerEvents: 'none' }}
    >
      {world ? `x ${world.x.toFixed(2)}  y ${world.y.toFixed(2)} m` : 'x —  y — m'}
    </span>
  )
}

const Plus = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
const Minus = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
const Fit = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    />
  </svg>
)
