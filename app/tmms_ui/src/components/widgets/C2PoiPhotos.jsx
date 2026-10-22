import { useEffect, useState } from 'react'
import { camOfSnapshot, formatPoiTime, map2dSnapshotUrl, POI_CAMS } from '../../lib/poi'

const camTitle = (f) => POI_CAMS.find((c) => c.key === camOfSnapshot(f) || f.includes(`_${c.key}.`))?.title ?? f
// Mapping snapshots live with the 2D map; photos C2 took of a route's own POI carry their
// own URLs (point.poi.urls).
const photoUrl = (point, mapName, f) => point.poi.urls?.[f] ?? map2dSnapshotUrl(mapName, f)

// Without onOpen the card is a view-only preview: it cannot be clicked or focused, and the
// pointer passes through it to the map, so it goes when the pointer leaves the point.
export function C2PoiHoverCard({ point, at, mapName, bounds, onOpen, onPointerEnter, onPointerLeave }) {
  const clickable = Boolean(onOpen)
  const width = 300
  const left = at.x + 18 + width > bounds.width ? at.x - 18 - width : at.x + 18
  const top = Math.max(8, Math.min(at.y - 20, bounds.height - 230))
  const { description, snapshots } = point.poi
  return (
    <div
      className="panel"
      {...(clickable && {
        role: 'button',
        tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } },
        onPointerEnter,
        onPointerLeave,
        title: 'Open the photos',
      })}
      style={{
        position: 'absolute', left, top, width, padding: 8, zIndex: 7,
        cursor: clickable ? 'pointer' : 'default', pointerEvents: clickable ? 'auto' : 'none',
        display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
      }}
    >
      <div className="val-mono" style={{ fontSize: 12, color: 'var(--text-h)' }}>{point.label}</div>
      {description && (
        <div style={{
          fontSize: 11, color: 'var(--text)', display: '-webkit-box', WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap',
        }}
        >
          {description}
        </div>
      )}
      {snapshots.length > 0 ? (
        <div style={{ display: 'flex', gap: 4 }}>
          {snapshots.map((f) => (
            <img
              key={f}
              src={photoUrl(point, mapName, f)}
              alt={camTitle(f)}
              style={{ flex: 1, minWidth: 0, height: 120, objectFit: 'cover', borderRadius: 3, background: '#000' }}
            />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>No photos.</div>
      )}
      {clickable && <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Click this card to open the photos</div>}
    </div>
  )
}

export function C2PoiViewer({ point, mapName, onClose }) {
  const [shown, setShown] = useState(null)
  const [fullSize, setFullSize] = useState(false)

  useEffect(() => {
    setShown(point?.poi.snapshots[0] ?? null)
    setFullSize(false)
  }, [point?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!point) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [point, onClose])

  if (!point) return null
  const { description, snapshots, timestamp } = point.poi

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'rgba(0,0,0,0.6)',
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ width: 'min(1100px, 95vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <span>{point.label}</span>
          <span className="val-mono" style={{ fontSize: 10 }}>{formatPoiTime(timestamp)}</span>
        </div>

        <div style={{ display: 'flex', gap: 12, padding: 12, minHeight: 0, flex: 1, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown ? (
              <>
                <div
                  style={{
                    height: '62vh', background: '#000', borderRadius: 4,
                    overflow: fullSize ? 'auto' : 'hidden',
                    cursor: fullSize ? 'zoom-out' : 'zoom-in',
                  }}
                  onClick={() => setFullSize((f) => !f)}
                  title={fullSize ? 'Click to fit' : 'Click for full size'}
                >
                  <img
                    src={photoUrl(point, mapName, shown)}
                    alt={camTitle(shown)}
                    style={fullSize
                      ? { display: 'block', maxWidth: 'none' }
                      : { display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {snapshots.map((f) => (
                    <button
                      key={f}
                      onClick={() => { setShown(f); setFullSize(false) }}
                      style={{
                        padding: 0, border: `2px solid ${f === shown ? 'var(--pin-poi)' : 'var(--border)'}`,
                        borderRadius: 4, background: '#000', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                      }}
                    >
                      <img src={photoUrl(point, mapName, f)} alt={camTitle(f)} style={{ height: 64, width: 96, objectFit: 'cover', display: 'block' }} />
                      <span className="val-mono" style={{ fontSize: 9, color: 'var(--text-dim)', padding: '2px 0' }}>{camTitle(f)}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No photos were saved with this point.</div>
            )}
          </div>

          <div style={{ flex: '0 1 240px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
            <div style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {description || <span style={{ color: 'var(--text-dim)' }}>No description.</span>}
            </div>
            <div className="val-mono" style={{ fontSize: 11, color: 'var(--text)' }}>
              <div>x {point.x.toFixed(3)} m</div>
              <div>y {point.y.toFixed(3)} m</div>
            </div>
            <button className="btn-icon" style={{ padding: '6px 10px' }} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
