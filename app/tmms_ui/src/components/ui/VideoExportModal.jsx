import { useEffect, useRef, useState } from 'react'

const CAMERA_OPTIONS = [
  { key: 'topdown', label: 'Top Down Camera' },
  { key: 'wrist', label: 'Wrist Camera' },
  { key: 'third_person', label: 'Third Person Camera' },
]

const ESTIMATED_MS_PER_VIDEO = 60_000
// Capped short of 100% -- this is a fake, estimate-based bar (video
// export is a synchronous blocking request with no real progress
// events), so it must never visually claim "done" before the actual
// response arrives.
const PROGRESS_CAP_PCT = 94

export function VideoExportModal({ open, filename, busy, onConfirm, onCancel }) {
  const [selected, setSelected] = useState([])
  const [progressPct, setProgressPct] = useState(0)
  const intervalRef = useRef(null)

  useEffect(() => {
    if (!busy) {
      clearInterval(intervalRef.current)
      setProgressPct(0)
      return
    }
    const estimatedMs = Math.max(selected.length, 1) * ESTIMATED_MS_PER_VIDEO
    const startedAt = Date.now()
    intervalRef.current = setInterval(() => {
      const pct = ((Date.now() - startedAt) / estimatedMs) * 100
      setProgressPct(Math.min(PROGRESS_CAP_PCT, pct))
    }, 250)
    return () => clearInterval(intervalRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  if (!open) return null

  function toggle(key) {
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="rounded-lg p-6 w-80 flex flex-col gap-4"
        style={{
          background: 'var(--panel-bg)',
          border: '1px solid var(--accent)',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 18 }}>🎬</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
            }}
          >
            Download Videos
          </span>
        </div>

        {/* Filename */}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', wordBreak: 'break-all' }}>
          {filename}
        </div>

        {/* Checkboxes */}
        <div className="flex flex-col gap-2">
          {CAMERA_OPTIONS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2" style={{ fontSize: 13, color: 'var(--text-h)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
              <input
                type="checkbox"
                checked={selected.includes(key)}
                onChange={() => toggle(key)}
                disabled={busy}
              />
              {label}
            </label>
          ))}
        </div>

        {/* Progress bar (fake/estimated -- see PROGRESS_CAP_PCT) */}
        {busy && (
          <div className="flex flex-col gap-1.5">
            <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${progressPct}%`,
                  background: 'var(--accent-bright)',
                  transition: 'width 0.25s linear',
                }}
              />
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
              Video processing, processing time varies based on connection strength.
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3 justify-end mt-1">
          <button className="btn-icon px-4 py-1.5 text-xs" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="px-4 py-1.5 rounded text-xs font-medium"
            style={{
              background: 'var(--accent-bright)',
              color: '#fff',
              fontFamily: 'var(--font-mono)',
              border: 'none',
              cursor: selected.length === 0 || busy ? 'not-allowed' : 'pointer',
              opacity: selected.length === 0 || busy ? 0.5 : 1,
            }}
            disabled={selected.length === 0 || busy}
            onClick={() => onConfirm(selected)}
          >
            {busy ? 'Encoding…' : 'Download ▶'}
          </button>
        </div>
      </div>
    </div>
  )
}
