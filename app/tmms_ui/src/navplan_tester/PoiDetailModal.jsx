import { useEffect, useRef, useState } from 'react'
import { camOfSnapshot, formatPoiTime, map2dSnapshotUrl, POI_CAMS } from '../lib/poi'
import { POI_COLOR } from './PoiLayer'
import { degFromYaw } from './lib/quat'

// One POI: its snapshots large (click to view at full size), and its heading. Position is
// changed by dragging the marker on the map. Changes last until the map is changed or the
// page is reloaded; the yaml is never written from here.
//
// props: poi, saved (as loaded from the yaml), mapName, inRoute (count),
//        onYaw(rad), onReset(), onAddToRoute(), onClose()
export function PoiDetailModal({ poi, saved, mapName, inRoute, onYaw, onReset, onAddToRoute, onClose }) {
  const [shown, setShown] = useState(null)
  const [fullSize, setFullSize] = useState(false)

  useEffect(() => {
    setShown(poi?.snapshots[0] ?? null)
    setFullSize(false)
    // Only when a different POI is opened, not on every drag of this one.
  }, [poi?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!poi) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [poi, onClose])

  if (!poi) return null

  const moved = saved && (Math.hypot(poi.x - saved.x, poi.y - saved.y) > 1e-6 || Math.abs(poi.yaw - saved.yaw) > 1e-6)
  const camTitle = (f) => POI_CAMS.find((c) => c.key === camOfSnapshot(f))?.title ?? f

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
          <span><span style={{ color: POI_COLOR }}>POI #{poi.id}</span> · {poi.name}</span>
          <span className="val-mono" style={{ fontSize: 10 }}>{formatPoiTime(poi.timestamp)}</span>
        </div>

        <div style={{ display: 'flex', gap: 12, padding: 12, minHeight: 0, flex: 1 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                    src={map2dSnapshotUrl(mapName, shown)}
                    alt={camTitle(shown)}
                    style={fullSize
                      ? { display: 'block', maxWidth: 'none' }
                      : { display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {poi.snapshots.map((f) => (
                    <button
                      key={f}
                      onClick={() => { setShown(f); setFullSize(false) }}
                      style={{
                        padding: 0, border: `2px solid ${f === shown ? POI_COLOR : 'var(--border)'}`,
                        borderRadius: 4, background: '#000', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                      }}
                    >
                      <img src={map2dSnapshotUrl(mapName, f)} alt={camTitle(f)} style={{ height: 64, width: 96, objectFit: 'cover', display: 'block' }} />
                      <span className="val-mono" style={{ fontSize: 9, color: 'var(--text-dim)', padding: '2px 0' }}>{camTitle(f)}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No snapshots were saved with this POI.</div>
            )}
          </div>

          <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
            <div style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {poi.description || <span style={{ color: 'var(--text-dim)' }}>No description.</span>}
            </div>

            <div className="val-mono" style={{ fontSize: 11, color: 'var(--text)' }}>
              <div>x {poi.x.toFixed(3)} m</div>
              <div>y {poi.y.toFixed(3)} m</div>
              {moved && (
                <div style={{ color: '#F59E0B', marginTop: 2 }}>
                  moved · saved {saved.x.toFixed(2)}, {saved.y.toFixed(2)}, {degFromYaw(saved.yaw).toFixed(0)}°
                </div>
              )}
            </div>

            <HeadingDial yaw={poi.yaw} onChange={onYaw} />

            <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4 }}>
              Drag the marker on the map to move it. Changes last until the map is changed or
              the page is reloaded.
            </div>

            <button className="btn-icon" style={{ padding: '6px 10px', borderColor: 'var(--accent-bright)' }} onClick={onAddToRoute}>
              ＋ Add to route{inRoute ? ` (in route ×${inRoute})` : ''}
            </button>
            <button className="btn-icon" style={{ padding: '6px 10px' }} onClick={onReset} disabled={!moved}>
              Reset to saved
            </button>
            <button className="btn-icon" style={{ padding: '6px 10px' }} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Drag the dial or type degrees; Shift snaps to 15°. 0° = map +X, counter-clockwise.
function HeadingDial({ yaw, onChange }) {
  const ref = useRef(null)
  const size = 84
  const c = size / 2
  const r = c - 8

  const angleFrom = (e) => {
    const rect = ref.current.getBoundingClientRect()
    let a = Math.atan2(-(e.clientY - rect.top - c), e.clientX - rect.left - c)
    if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12)
    return a
  }
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    onChange(angleFrom(e))
  }
  const onPointerMove = (e) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) onChange(angleFrom(e))
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg
        ref={ref} width={size} height={size}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        style={{ cursor: 'grab', touchAction: 'none', flexShrink: 0 }}
      >
        <circle cx={c} cy={c} r={r} fill="var(--bg)" stroke="var(--border)" />
        <line
          x1={c} y1={c} x2={c + Math.cos(yaw) * r} y2={c - Math.sin(yaw) * r}
          stroke={POI_COLOR} strokeWidth="2.5" strokeLinecap="round"
        />
        <circle cx={c + Math.cos(yaw) * r} cy={c - Math.sin(yaw) * r} r="4.5" fill={POI_COLOR} />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            value={Math.round(degFromYaw(yaw))}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange(((n % 360) * Math.PI) / 180)
            }}
            className="val-mono"
            style={{
              width: 60, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border)',
              background: 'var(--bg)', color: 'var(--text-h)', fontSize: 11,
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>°</span>
        </div>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.35 }}>
          heading · 0° = map +X,<br />counter-clockwise
        </span>
      </div>
    </div>
  )
}
