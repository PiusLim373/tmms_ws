import { useCallback, useEffect, useState } from 'react'
import { getPoiPose } from '../../services/rosbridge'
import { PoiModal } from '../ui/PoiModal'
import { WarningModal } from '../ui/WarningModal'
import { camOfSnapshot, formatPoiTime, isoLocal, poiSnapshotUrl } from '../../lib/poi'

// The "Points of Interest" tab of Manage 3D Maps. Only mounted during a mapping session:
// a POI is a pose in that session's camera_init, which no later session shares.
//
// props:
//   mapName    the map being built
//   showToast  (message) => void
export function PoiPanel({ mapName, showToast }) {
  const [list, setList] = useState({ nextId: 1, pois: [] })
  const [capturing, setCapturing] = useState(false)
  const [modal, setModal] = useState(null)        // { mode, id, pose, poi? }
  const [toDelete, setToDelete] = useState(null)  // poi

  const fetchList = useCallback(() => {
    fetch(`/api/poi/${encodeURIComponent(mapName)}`)
      .then((r) => r.json())
      .then((data) => setList({ nextId: data.nextId ?? 1, pois: data.pois ?? [] }))
      .catch((err) => console.error('[PoiPanel] fetch POIs failed:', err))
  }, [mapName])

  useEffect(() => { fetchList() }, [fetchList])

  // The pose is read here, when the button is pressed, and shown read-only in the modal.
  // The snapshots are taken later, on Save, so the operator can aim the cameras first.
  function handleCapture() {
    setCapturing(true)
    getPoiPose(
      (res) => {
        setCapturing(false)
        if (!res.success) { showToast(`Could not read the robot pose: ${res.message}`); return }
        if (res.map_name !== mapName) {
          showToast(`The robot is mapping “${res.map_name}”, not “${mapName}”.`)
          return
        }
        setModal({
          mode: 'create',
          id: list.nextId,
          pose: { x: res.x, y: res.y, yaw: res.yaw, timestamp: isoLocal() },
        })
      },
      (err) => { setCapturing(false); showToast(`/poi_pose failed: ${err}`) },
    )
  }

  function handleSaved(poi) {
    const isCreate = modal?.mode === 'create'
    setModal(null)
    fetchList()
    // The backend assigns the id; it only differs from the one shown if another tab saved first.
    showToast(isCreate ? `Saved ${poi.name} (ID ${poi.id})` : `Updated ${poi.name}`)
  }

  function handleDelete() {
    const poi = toDelete
    setToDelete(null)
    fetch(`/api/poi/${encodeURIComponent(mapName)}/${poi.id}`, { method: 'DELETE' })
      .then((r) => (r.ok ? r.json() : r.json().then((b) => { throw new Error(b.error || `delete failed (${r.status})`) })))
      .then(() => { showToast(`Deleted ${poi.name}`); fetchList() })
      .catch((err) => showToast(`Delete failed: ${err.message}`))
  }

  const otherNames = list.pois.filter((p) => p.id !== modal?.poi?.id).map((p) => p.name)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        className="btn-icon"
        style={{ padding: '8px 12px', fontSize: 12, borderColor: 'var(--accent-bright)' }}
        onClick={handleCapture}
        disabled={capturing || modal != null}
      >
        {capturing ? '⏳ Reading pose…' : '📍 Save Point of Interest'}
      </button>
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        Saves where the robot is standing and which way it faces, with snapshots from its
        cameras. Navigation can bring it back to the same spot later.
      </div>

      {list.pois.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
          No points of interest in {mapName} yet.
        </div>
      )}

      {list.pois.map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px',
            border: '1px solid var(--border)', borderRadius: 4,
          }}
        >
          <div className="flex items-center justify-between" style={{ gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-h)', wordBreak: 'break-all' }}>
                <span style={{ color: 'var(--text-dim)' }}>#{p.id}</span> {p.name}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                {p.x.toFixed(2)}, {p.y.toFixed(2)} · {p.yaw.toFixed(0)}° · {formatPoiTime(p.timestamp)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                className="btn-icon" style={{ fontSize: 11, padding: '4px 8px' }}
                onClick={() => setModal({ mode: 'edit', id: p.id, pose: p, poi: p })}
              >
                ✎ Edit
              </button>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '4px 8px', borderColor: '#DC2626', color: '#DC2626' }}
                onClick={() => setToDelete(p)}
              >
                ✕
              </button>
            </div>
          </div>
          {p.description && (
            <div style={{ fontSize: 11, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {p.description}
            </div>
          )}
          {p.snapshots.length > 0 && (
            <div style={{ display: 'flex', gap: 4 }}>
              {p.snapshots.map((f) => (
                <img
                  key={f}
                  src={poiSnapshotUrl(mapName, f)}
                  alt={camOfSnapshot(f)}
                  title={camOfSnapshot(f)}
                  style={{ height: 44, maxWidth: 80, objectFit: 'cover', borderRadius: 3, background: '#000' }}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      <PoiModal
        open={modal != null}
        mode={modal?.mode}
        mapName={mapName}
        id={modal?.id}
        pose={modal?.pose}
        poi={modal?.poi}
        otherNames={otherNames}
        onSaved={handleSaved}
        onCancel={() => setModal(null)}
      />

      <WarningModal
        open={toDelete != null}
        heading="DELETE POINT OF INTEREST"
        title={`Delete ${toDelete?.name ?? ''} (ID ${toDelete?.id ?? ''})?`}
        body="Its snapshots are deleted too. Its ID is not reused. This cannot be undone."
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  )
}
