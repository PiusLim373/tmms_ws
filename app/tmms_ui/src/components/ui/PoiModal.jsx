import { useEffect, useMemo, useRef, useState } from 'react'
import { CameraWidget } from '../widgets/CameraWidget'
import { CamControls } from '../widgets/ThirdPersonWidget'
import { suspendKeyboard } from '../../hooks/useKeyboard'
import {
  camOfSnapshot, frameToBlob, isDuplicateName, POI_CAMS, poiSnapshotUrl,
} from '../../lib/poi'

const DESCRIPTION_HINT = 'e.g. Unknown liquid spotted underneath structure'
const ENTER_HINT = 'Enter saves · Shift/Ctrl/Alt+Enter: new line'
// The camera row takes the height the form and buttons leave free.
const CAM_HEIGHT = 'clamp(340px, calc(94vh - 360px), 720px)'

// Create: live feeds, each saved as the frame on screen when Save is pressed.
// Edit: the saved snapshots, which can only be removed -- a retake would no longer match the
// pose. The pose is read-only in both.
//
// props:
//   mode          'create' | 'edit'
//   mapName       the 3D map being mapped
//   id            the id this POI will get (create) or has (edit)
//   pose          { x, y, yaw } -- m, m, deg
//   poi           the saved POI (edit only)
//   otherNames    names of the other POIs, for the duplicate warning
//   onSaved(poi)  onCancel()
export function PoiModal({ open, mode, mapName, id, pose, poi, otherNames, onSaved, onCancel }) {
  const isCreate = mode === 'create'
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [checked, setChecked] = useState({})
  const [live, setLive] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const frameRefs = useRef(Object.fromEntries(POI_CAMS.map(({ key }) => [key, { current: null }]))).current
  const saveRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setName(isCreate ? `POI_${id}` : poi.name)
    setDescription(isCreate ? '' : poi.description)
    setChecked(isCreate
      ? Object.fromEntries(POI_CAMS.map(({ key }) => [key, true]))
      : Object.fromEntries(poi.snapshots.map((f) => [f, true])))
    setLive({})
    setSaving(false)
    setError(null)
    for (const ref of Object.values(frameRefs)) ref.current = null
  }, [open, isCreate, id, poi, frameRefs])

  // Stable per camera: CameraWidget re-runs its effect whenever this callback changes.
  const onActive = useMemo(() => Object.fromEntries(POI_CAMS.map(({ key }) => [
    key, (active) => setLive((prev) => (prev[key] === active ? prev : { ...prev, [key]: active })),
  ])), [])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) { onCancel(); return }
      // Plain Enter saves. A focused button keeps its own Enter, and modified Enter is the
      // description's new line.
      if (e.key !== 'Enter' || e.isComposing || saving) return
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      if (e.target?.tagName === 'BUTTON') return
      e.preventDefault()
      saveRef.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, saving, onCancel])

  // Teleop keys would otherwise drive the robot from behind the modal, as for the map editor.
  useEffect(() => {
    if (!open) return undefined
    suspendKeyboard(true)
    return () => suspendKeyboard(false)
  }, [open])

  if (!open) return null

  const duplicate = isDuplicateName(name, otherNames)
  // A camera with no signal has nothing to save, whatever its box says.
  const willSave = isCreate
    ? POI_CAMS.filter(({ key }) => checked[key] && live[key]).map(({ key }) => key)
    : poi.snapshots.filter((f) => checked[f])

  // Shift+Enter is the browser's own new line. Ctrl/Alt+Enter insert none, so do it here; plain
  // Enter inserts nothing and is left to the window handler, which saves.
  function onDescriptionKey(e) {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return
    e.preventDefault()
    if (!e.ctrlKey && !e.altKey) return
    const el = e.currentTarget
    const at = el.selectionStart
    const next = `${description.slice(0, at)}\n${description.slice(el.selectionEnd)}`
    if (next.length > 2000) return
    setDescription(next)
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = at + 1 })
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      let res
      if (isCreate) {
        const form = new FormData()
        form.append('meta', JSON.stringify({
          name, description, x: pose.x, y: pose.y, yaw: pose.yaw, timestamp: pose.timestamp,
        }))
        for (const key of willSave) {
          const blob = frameToBlob(frameRefs[key].current)
          if (blob) form.append(key, blob, `${key}.${blob.type === 'image/png' ? 'png' : 'jpg'}`)
        }
        res = await fetch(`/api/poi/${encodeURIComponent(mapName)}`, { method: 'POST', body: form })
      } else {
        res = await fetch(`/api/poi/${encodeURIComponent(mapName)}/${poi.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, snapshots: willSave }),
        })
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `save failed (${res.status})`)
      onSaved(body)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }
  // The Enter handler is bound once per open; this keeps it saving the current fields.
  saveRef.current = handleSave

  const label = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.06em' }
  const field = {
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
    padding: '6px 8px', fontSize: 12, color: 'var(--text-h)', width: '100%',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="rounded-lg flex flex-col"
        style={{
          width: 'min(2200px, 96vw)', maxHeight: '94vh', overflow: 'hidden',
          background: 'var(--panel-bg)', border: '1px solid var(--accent)',
        }}
      >
        <div className="panel-header">
          <span>{isCreate ? 'SAVE POINT OF INTEREST' : 'EDIT POINT OF INTEREST'} · {mapName}</span>
          <span className="val-mono" style={{ fontSize: 11 }}>ID {id}</span>
        </div>

        <div style={{ overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text)' }}>
            {isCreate
              ? 'These images will be captured and saved together with the POI when you press Save. '
                + 'Untick any you do not want; use CAM CTRL to aim the third-person camera first.'
              : 'Untick a snapshot to delete it from this POI. Snapshots cannot be retaken, so '
                + 'they always show what was there when the pose was saved.'}
          </div>

          {isCreate ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, height: CAM_HEIGHT }}>
              {POI_CAMS.map(({ key, title, topic }) => (
                <div key={key} style={{ minWidth: 0, opacity: checked[key] && live[key] ? 1 : 0.55 }}>
                  <CameraWidget
                    topicName={topic}
                    title={title}
                    frameRef={frameRefs[key]}
                    onActiveChange={onActive[key]}
                    footer={key === 'thirdperson' ? <CamControls /> : null}
                    headerExtra={(
                      <SaveBox
                        checked={Boolean(checked[key] && live[key])}
                        disabled={!live[key] || saving}
                        title={live[key] ? 'Save this camera with the POI' : 'No signal — nothing to save'}
                        onChange={(v) => setChecked((c) => ({ ...c, [key]: v }))}
                      />
                    )}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              {poi.snapshots.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No snapshots were saved with this POI.</div>
              )}
              {poi.snapshots.map((f) => (
                <div key={f} className="panel flex flex-col" style={{ overflow: 'hidden', opacity: checked[f] ? 1 : 0.45 }}>
                  <div className="panel-header">
                    <span>{POI_CAMS.find((c) => c.key === camOfSnapshot(f))?.title ?? f}</span>
                    <SaveBox
                      checked={Boolean(checked[f])}
                      disabled={saving}
                      title="Keep this snapshot"
                      onChange={(v) => setChecked((c) => ({ ...c, [f]: v }))}
                    />
                  </div>
                  <img
                    src={poiSnapshotUrl(mapName, f)}
                    alt={f}
                    style={{ width: '100%', height: CAM_HEIGHT, objectFit: 'contain', background: '#000', display: 'block' }}
                  />
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: 14 }}>
            <div className="val-mono" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <div style={label}>POSE (MAP FRAME)</div>
              <div>x&nbsp;&nbsp;&nbsp;{pose.x.toFixed(3)} m</div>
              <div>y&nbsp;&nbsp;&nbsp;{pose.y.toFixed(3)} m</div>
              <div>yaw&nbsp;{pose.yaw.toFixed(1)}°</div>
              <div style={{ ...label, marginTop: 4 }}>ID {id}</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={label} htmlFor="poi-name">NAME</label>
                <input
                  id="poi-name"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  disabled={saving}
                  className="val-mono"
                  style={field}
                />
                {duplicate && (
                  <div style={{ fontSize: 11, color: '#F59E0B' }}>
                    ⚠ Another POI is already named “{name.trim()}”. Names may repeat, but each
                    POI is identified by its ID.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="flex items-center justify-between">
                  <label style={label} htmlFor="poi-description">DESCRIPTION</label>
                  <span style={{ ...label, letterSpacing: 0 }}>{ENTER_HINT}</span>
                </div>
                <textarea
                  id="poi-description"
                  value={description}
                  maxLength={2000}
                  rows={3}
                  placeholder={DESCRIPTION_HINT}
                  title={ENTER_HINT}
                  onKeyDown={onDescriptionKey}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={saving}
                  style={{ ...field, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>
            </div>
          </div>

          {error && <div style={{ fontSize: 12, color: '#EF4444' }}>{error}</div>}
        </div>

        <div className="flex gap-3 justify-end items-center" style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', marginRight: 'auto' }}>
            {willSave.length} snapshot{willSave.length === 1 ? '' : 's'} will be {isCreate ? 'saved' : 'kept'}
          </span>
          <button className="btn-icon px-4 py-1.5 text-xs" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn-icon px-4 py-1.5 text-xs"
            style={{ borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : isCreate ? 'Save POI' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SaveBox({ checked, disabled, title, onChange }) {
  return (
    <label
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'var(--font-mono)', fontSize: 10, color: checked ? 'var(--text-h)' : 'var(--text-dim)',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      SAVE
    </label>
  )
}
