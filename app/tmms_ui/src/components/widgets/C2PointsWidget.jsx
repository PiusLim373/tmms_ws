import { Fragment } from 'react'
import { degFromYaw, formatMetres } from '../../lib/c2Coords'
import {
  PIN_TYPES, PIN_META, defaultName, displayName, routeOrder,
} from '../../lib/c2Pins'
import { C2PinGlyph } from '../ui/C2PinGlyph'

const inputStyle = {
  width: '100%', padding: '5px 8px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text-h)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
}

const subHeadStyle = {
  fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: 'var(--text-dim)',
}

const STORE_STATUS = {
  loading: { text: 'loading…', color: 'var(--text-dim)', title: 'Fetching saved routes' },
  saved: { text: '● saved', color: '#4ADE80', title: 'Every change is saved on the robot' },
  saving: { text: 'saving…', color: '#60A5FA', title: 'Saving your latest change' },
  retrying: { text: '⚠ not saved — retrying', color: '#FBBF24', title: 'The last save failed; retrying every few seconds' },
  offline: { text: '⚠ storage offline', color: '#F87171', title: 'C2 storage is not reachable. Changes are kept in this tab only until it comes back.' },
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
        {label}
      </span>
      {children}
    </label>
  )
}

// The Path Editor's side panel: arm a pin type, link points, the graph's points by map, and
// the selected one's details. `editable` is false in the all-maps grid, where nothing is placed.
export function C2PointsWidget({
  pins, selectedId, placingType, editable, focusMap,
  canUndo, canRedo, onUndo, onRedo,
  onArm, onSelect, onRemove, onChange,
  storeStatus, mapPoints = [], maps = [],
  linkMode = false, linkStartName = null, linkCount = 0, onToggleLinkMode,
  switchPartners = new Map(), selectedExtra = null,
  hiddenCount = 0, onRestoreHidden, selectedPhotos = null,
}) {
  const store = STORE_STATUS[storeStatus]

  const ordered = routeOrder(pins)
  const selectedMapPoint = mapPoints.find((p) => p.id === selectedId) ?? null
  const selected = selectedMapPoint ? null : pins.find((p) => p.id === selectedId) ?? null
  const disabled = !editable
  const shownMaps = focusMap ? [focusMap] : maps

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>POINTS</span>
        <span className="val-mono" style={{ fontSize: 10, display: 'flex', gap: 10 }}>
          {store && <span style={{ color: store.color }} title={store.title}>{store.text}</span>}
          <span style={{ fontSize: 11 }}>{ordered.length + mapPoints.length}</span>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            className="btn-icon"
            style={{ fontSize: 13, padding: '6px 10px' }}
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            ↶
          </button>
          <button
            className="btn-icon"
            style={{ fontSize: 13, padding: '6px 10px' }}
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            ↷
          </button>
        </div>

        <div style={subHeadStyle}>Place</div>
        {!editable && (
          <div style={{ fontSize: 11, color: '#FBBF24', lineHeight: 1.5 }}>
            Expand a map (click it) to place, move and link points on it.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: disabled ? 0.45 : 1 }}>
          {PIN_TYPES.map((type) => {
            const armed = placingType === type
            const meta = PIN_META[type]
            return (
              <button
                key={type}
                disabled={disabled}
                onClick={() => onArm(armed ? null : type)}
                title={disabled ? 'Expand a map first' : meta.hint}
                className="flex items-center gap-2"
                style={{
                  padding: '6px 8px', borderRadius: 4, textAlign: 'left',
                  border: `1px solid ${armed ? 'var(--accent-bright)' : 'var(--border)'}`,
                  background: armed ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
                  color: 'var(--text)', cursor: disabled ? 'not-allowed' : 'pointer',
                  font: 'inherit',
                }}
              >
                <C2PinGlyph type={type} size={16} />
                <span style={{ fontSize: 12, color: 'var(--text-h)' }}>{meta.label}</span>
                {armed && (
                  <span
                    className="val-mono"
                    style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--accent-bright)' }}
                  >
                    ARMED
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <button
          disabled={disabled}
          onClick={onToggleLinkMode}
          title={disabled ? 'Expand a map first' : 'Join two points on this map the robot may travel between'}
          className="flex items-center gap-2"
          style={{
            padding: '6px 8px', borderRadius: 4, textAlign: 'left',
            border: `1px solid ${linkMode ? 'var(--accent-bright)' : 'var(--border)'}`,
            background: linkMode ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
            color: 'var(--text)', cursor: disabled ? 'not-allowed' : 'pointer', font: 'inherit',
            opacity: disabled ? 0.45 : 1,
          }}
        >
          <span style={{ width: 16, textAlign: 'center' }}>🔗</span>
          <span style={{ fontSize: 12, color: 'var(--text-h)' }}>Link points</span>
          <span className="val-mono" style={{ marginLeft: 'auto', fontSize: 10, color: linkMode ? 'var(--accent-bright)' : 'var(--text-dim)' }}>
            {linkMode ? 'ON' : `${linkCount} link${linkCount === 1 ? '' : 's'}`}
          </span>
        </button>

        {linkMode && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            {linkStartName
              ? <>Linking from <b style={{ color: 'var(--text-h)' }}>{linkStartName}</b>. Click the next point to link it — keep clicking to chain.</>
              : 'Click a point to start, then click another to link them.'}
            {' '}Clicking an already-linked pair removes that link. Click a link on the map to remove it.
            {' '}<b style={{ color: '#60A5FA' }}>To join two maps:</b> click a Map Switch, then the Map
            Switch at the same spot on the other map. A dashed blue line joins them.
            {' '}<span className="val-mono" style={{ fontSize: 10 }}>Esc</span> to stop.
          </div>
        )}

        {placingType && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>
            Click {focusMap ?? 'any map'} to place a {PIN_META[placingType].label.toLowerCase()} — and keep
            clicking for more.{' '}
            <span className="val-mono" style={{ fontSize: 10 }}>Esc</span>, or the button again,
            to stop.
          </div>
        )}

        {selectedMapPoint && (
          <>
            <div style={{ borderTop: '1px solid var(--border)' }} />
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <C2PinGlyph type="action" size={14} />
                <span style={{ fontSize: 12, color: 'var(--text-h)' }}>{selectedMapPoint.label}</span>
              </span>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '2px 6px' }}
                onClick={() => onSelect(null)}
                title="Deselect"
              >
                ✕
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              Marked while mapping. Deleting it takes it off this route only; the map keeps it.
            </div>
            <Field label="Position (map frame)">
              <span className="val-mono" style={{ fontSize: 11 }}>
                x {formatMetres(selectedMapPoint.x)} m &nbsp; y {formatMetres(selectedMapPoint.y)} m
                {selectedMapPoint.headingSet && ` · ${degFromYaw(selectedMapPoint.yaw)}°`}
              </span>
            </Field>
            {selectedMapPoint.poi.description && (
              <Field label="Description">
                <span style={{ fontSize: 12, color: 'var(--text)' }}>{selectedMapPoint.poi.description}</span>
              </Field>
            )}
            {selectedMapPoint.poi.timestamp && (
              <Field label="Marked at">
                <span className="val-mono" style={{ fontSize: 11 }}>{selectedMapPoint.poi.timestamp}</span>
              </Field>
            )}
            {selectedMapPoint.poi.snapshots.length > 0 && (
              <Field label="Snapshots">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {selectedMapPoint.poi.snapshots.map((file) => {
                    const src = `/api/maps2d/${encodeURIComponent(selectedMapPoint.map)}/snapshots/${encodeURIComponent(file)}`
                    return (
                      <a key={file} href={src} target="_blank" rel="noreferrer" title={file}>
                        <img
                          src={src}
                          alt={file}
                          style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }}
                        />
                      </a>
                    )
                  })}
                </div>
              </Field>
            )}
            <button
              className="btn-icon"
              style={{ fontSize: 11, padding: '6px 10px', borderColor: '#DC2626', color: '#DC2626', alignSelf: 'flex-start' }}
              onClick={() => onRemove(selectedMapPoint.id)}
              disabled={disabled}
              title="Takes it off this route. Delete or Backspace does the same"
            >
              ✕ Delete from this route (Del)
            </button>
          </>
        )}

        {selected && (
          <>
            <div style={{ borderTop: '1px solid var(--border)' }} />
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <C2PinGlyph
                  type={selected.type}
                  size={14}
                  unpaired={selected.type === 'map_switch' && !switchPartners.get(selected.id)}
                />
                <span style={{ fontSize: 12, color: 'var(--text-h)' }}>{displayName(selected, pins)}</span>
              </span>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '2px 6px' }}
                onClick={() => onSelect(null)}
                title="Deselect"
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Field label={selected.type === 'action' ? 'Name (shown on the map)' : 'Label'}>
                <input
                  value={selected.label}
                  placeholder={defaultName(selected, pins)}
                  disabled={disabled}
                  onChange={(e) => onChange(selected.id, { label: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <Field label="Position (map frame)">
                <span className="val-mono" style={{ fontSize: 11 }}>
                  {selected.map} · x {formatMetres(selected.x)} m &nbsp; y {formatMetres(selected.y)} m
                </span>
              </Field>
              {selectedExtra}
              {selected.type === 'action' && (
                <>
                  <Field label="What to investigate">
                    <textarea
                      rows={3}
                      value={selected.action.description}
                      placeholder="What to investigate here"
                      disabled={disabled}
                      onChange={(e) => onChange(selected.id, {
                        action: { ...selected.action, description: e.target.value },
                      })}
                      style={{ ...inputStyle, resize: 'vertical' }}
                    />
                  </Field>
                  <Field label="Photos">
                    {selectedPhotos?.snapshots?.length ? (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {selectedPhotos.snapshots.map((file) => (
                            <a key={file} href={selectedPhotos.urls[file]} target="_blank" rel="noreferrer" title={file}>
                              <img
                                src={selectedPhotos.urls[file]}
                                alt={file}
                                style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }}
                              />
                            </a>
                          ))}
                        </div>
                        <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                          Taken {new Date(selectedPhotos.timestamp).toLocaleString()} by C2
                        </span>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        None yet. Send the robot here in C2 to take them.
                      </span>
                    )}
                  </Field>
                </>
              )}

              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '6px 10px', borderColor: '#DC2626', color: '#DC2626', alignSelf: 'flex-start' }}
                onClick={() => onRemove(selected.id)}
                disabled={disabled}
                title="Delete or Backspace does the same"
              >
                ✕ Delete pin (Del)
              </button>
            </div>
          </>
        )}

        <div style={{ borderTop: '1px solid var(--border)' }} />

        <div style={subHeadStyle}>{focusMap ? `Points on ${focusMap}` : 'Points, by map'}</div>
        {hiddenCount > 0 && (
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '5px 10px', alignSelf: 'flex-start' }}
            onClick={onRestoreHidden}
            title="Bring back the mapped POIs deleted from this route"
          >
            ↺ Restore {hiddenCount} deleted mapped POI{hiddenCount === 1 ? '' : 's'}
          </button>
        )}

        {mapPoints.length === 0 && ordered.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            No points yet. Expand a map, arm a type above, then click the map.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {shownMaps.map((m) => {
              const here = [...mapPoints, ...ordered].filter((p) => p.map === m)
              return (
                <Fragment key={m}>
                  {!focusMap && (
                    <div
                      className="val-mono"
                      style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6, padding: '2px 4px', borderBottom: '1px solid var(--border)' }}
                    >
                      {m} · {here.length}
                    </div>
                  )}
                  {here.map((pin) => {
                    const fromMap = pin.source === 'mapping'
                    const isSelected = pin.id === selectedId
                    const partner = switchPartners.get(pin.id)
                    return (
                      <div
                        key={pin.id}
                        onClick={() => onSelect(pin)}
                        className="flex items-center gap-2"
                        style={{
                          padding: '5px 6px',
                          cursor: 'pointer',
                          borderRadius: 4,
                          background: isSelected
                            ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)'
                            : 'transparent',
                        }}
                      >
                        <C2PinGlyph type={pin.type} size={14} unpaired={pin.type === 'map_switch' && !partner} />
                        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                          <span
                            style={{ fontSize: 12, color: 'var(--text-h)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={displayName(pin, pins)}
                          >
                            {displayName(pin, pins)}
                          </span>
                          <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                            {formatMetres(pin.x)}, {formatMetres(pin.y)} m
                            {fromMap && ' · from mapping'}
                            {pin.type === 'map_switch' && (partner ? ` · ⇄ ${partner.map}` : ' · unlinked')}
                          </span>
                        </span>
                        <button
                          className="btn-icon"
                          style={{ fontSize: 11, padding: '2px 6px', flexShrink: 0 }}
                          onClick={(e) => { e.stopPropagation(); onRemove(pin.id) }}
                          title="Delete this pin (Del)"
                          aria-label={`Delete ${displayName(pin, pins)}`}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </Fragment>
              )
            })}
          </div>
        )}

      </div>
    </div>
  )
}
