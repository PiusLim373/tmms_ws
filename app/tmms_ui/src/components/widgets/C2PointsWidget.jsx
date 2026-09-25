import { useState } from 'react'
import { formatMetres } from '../../lib/c2Coords'
import {
  PIN_TYPES, PIN_META, HEADING_TYPES, defaultName, displayName, effectiveYaw, routeOrder,
} from '../../lib/c2Pins'
import { C2PinGlyph } from '../ui/C2PinGlyph'
import { C2HeadingDial } from '../ui/C2HeadingDial'

const GRAPH_NAME_RE = /^[A-Za-z0-9_]+$/

const inputStyle = {
  width: '100%', padding: '5px 8px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text-h)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
}

const subHeadStyle = {
  fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: 'var(--text-dim)',
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

export function C2PointsWidget({
  pins, selectedId, placingType, editable, mapName,
  canUndo, canRedo, onUndo, onRedo,
  graph, graphs, panelMode, onPanelMode,
  onCreateGraph, onLoadGraph, onToggleEdit, onCloseGraph,
  onArm, onSelect, onRemove, onReorder, onChange, onSetYaw,
}) {
  const [dragId, setDragId] = useState(null)
  const [overIndex, setOverIndex] = useState(null)
  const [draftName, setDraftName] = useState('')

  const ordered = routeOrder(pins)
  const selected = pins.find((p) => p.id === selectedId) ?? null
  const graphOpen = Boolean(graph)
  const disabled = !graphOpen || !editable
  const nameInvalid = draftName.length > 0 && !GRAPH_NAME_RE.test(draftName)

  const mode = panelMode
  const setMode = onPanelMode

  function submitCreate() {
    if (!draftName || nameInvalid) return
    onCreateGraph(draftName)
    setDraftName('')
    setMode(null)
  }

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header">
        <span>MISSION</span>
        <span className="val-mono" style={{ fontSize: 11 }}>{ordered.length}</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={subHeadStyle}>Mission graph</div>

        {graphOpen ? (
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)',
              borderLeft: '3px solid var(--accent-bright)',
              background: 'color-mix(in srgb, var(--accent-bright) 18%, transparent)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-h)', wordBreak: 'break-all' }}>
                {graph.name}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                {pins.length} pin{pins.length === 1 ? '' : 's'} · {editable ? 'editing' : 'view only'}
              </div>
            </div>
            <button
              className="btn-icon"
              style={{ fontSize: 11, padding: '4px 8px', flexShrink: 0 }}
              onClick={onCloseGraph}
              title="Close the graph — the canvas keeps the map, the pins come off it"
            >
              ✕ Close
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            No graph open. Create one to start placing pins.
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '6px 10px', ...(mode === 'create' && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }) }}
            onClick={() => setMode(mode === 'create' ? null : 'create')}
            disabled={!mapName}
            title={mapName ? 'Start an empty graph on this map' : 'Load a map first'}
          >
            ＋ Create graph
          </button>
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '6px 10px', ...(mode === 'load' && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }) }}
            onClick={() => setMode(mode === 'load' ? null : 'load')}
            disabled={!mapName}
            title={mapName ? 'Open a graph made for this map' : 'Load a map first'}
          >
            ⬇ Load graph
          </button>
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '6px 10px', ...(editable && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }) }}
            onClick={onToggleEdit}
            disabled={!graphOpen}
            title={graphOpen
              ? 'Unlock the pins — place, drag, re-order and delete them'
              : 'Open a graph first'}
          >
            {editable ? '✓ Done editing' : '✎ Edit graph'}
          </button>

          {editable && (
            <>
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
            </>
          )}
        </div>

        {mode === 'create' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
              Graph name
            </label>
            <input
              value={draftName}
              autoFocus
              onChange={(e) => setDraftName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate()
                if (e.key === 'Escape') { setMode(null); setDraftName('') }
              }}
              placeholder="name_with_underscores"
              className="val-mono"
              style={{ ...inputStyle, fontSize: 12 }}
            />
            {nameInvalid && (
              <div style={{ fontSize: 11, color: '#EF4444' }}>
                Only letters, numbers, and underscores are allowed.
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '6px 10px' }}
                onClick={submitCreate}
                disabled={!draftName || nameInvalid}
              >
                Create on {mapName}
              </button>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '6px 10px' }}
                onClick={() => { setMode(null); setDraftName('') }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {mode === 'load' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {graphs.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                No graphs for {mapName}.
              </div>
            )}
            {graphs.map((g) => {
              const open = g.id === graph?.id
              return (
                <div
                  key={g.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)',
                    borderLeft: open ? '3px solid var(--accent-bright)' : '3px solid transparent',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-h)', wordBreak: 'break-all' }}>
                      {g.name}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                      {g.pins.length} pin{g.pins.length === 1 ? '' : 's'}
                      {' · '}{new Date(g.updatedAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <button
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }}
                    onClick={() => { onLoadGraph(g.id); setMode(null) }}
                    disabled={open}
                  >
                    {open ? 'Open' : 'Load'}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div
          style={{
            paddingTop: 8, borderTop: '1px solid var(--border)',
            fontSize: 10, opacity: 0.6, lineHeight: 1.7,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>HOW TO OPERATE</div>
          1. Load a map at the top — from the store, or a .png with its .yaml.<br />
          2. Create a graph here to start marking that map up.<br />
          3. With the graph in edit mode, arm a pin type and click the canvas.<br />
          4. Give each action waypoint a facing and what to investigate.<br />
          Ctrl+Z undo · Ctrl+Y redo · Del removes the selected pin.
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} />

        <div style={subHeadStyle}>Mission points</div>

        {!graphOpen && (
          <div style={{ fontSize: 11, color: '#FBBF24', lineHeight: 1.5 }}>
            No graph open — create or load one above before placing pins.
          </div>
        )}
        {graphOpen && !editable && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            View only. Press <span style={{ color: 'var(--text-h)' }}>Edit graph</span> above to
            place, move or delete pins.
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
                title={disabled ? 'Open a graph and turn on Edit graph first' : meta.hint}
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

        {placingType && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>
            Click the map to place a {PIN_META[placingType].label.toLowerCase()} — and keep
            clicking for more.{' '}
            <span className="val-mono" style={{ fontSize: 10 }}>Esc</span>, or the button again,
            to stop.
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)' }} />

        <div style={subHeadStyle}>Route order</div>

        {ordered.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            No pins yet. Arm a type above, then click the map.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {ordered.map((pin, index) => {
              const isSelected = pin.id === selectedId
              const isDropTarget = overIndex === index && dragId && dragId !== pin.id
              return (
                <div
                  key={pin.id}
                  draggable={!disabled}
                  onDragStart={() => setDragId(pin.id)}
                  onDragOver={(e) => { e.preventDefault(); setOverIndex(index) }}
                  onDrop={() => {
                    if (dragId && dragId !== pin.id) onReorder(dragId, index)
                    setDragId(null)
                    setOverIndex(null)
                  }}
                  onDragEnd={() => { setDragId(null); setOverIndex(null) }}
                  onClick={() => onSelect(pin.id)}
                  className="flex items-center gap-2"
                  style={{
                    padding: '5px 6px',
                    cursor: disabled ? 'pointer' : 'grab',
                    borderRadius: 4,
                    borderTop: `2px solid ${isDropTarget ? 'var(--accent-bright)' : 'transparent'}`,
                    background: isSelected
                      ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)'
                      : 'transparent',
                  }}
                >
                  <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', width: 14, flexShrink: 0 }}>
                    {index + 1}
                  </span>
                  <C2PinGlyph type={pin.type} size={14} />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                    <span
                      style={{ fontSize: 12, color: 'var(--text-h)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={displayName(pin, pins)}
                    >
                      {displayName(pin, pins)}
                    </span>
                    <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      {formatMetres(pin.x)}, {formatMetres(pin.y)} m
                      {pin.type === 'action' && pin.action?.dwellSeconds > 0 && ` · ${pin.action.dwellSeconds}s`}
                    </span>
                  </span>
                  <button
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '2px 6px', flexShrink: 0 }}
                    onClick={(e) => { e.stopPropagation(); onRemove(pin.id) }}
                    disabled={disabled}
                    title="Delete this pin (Del)"
                    aria-label={`Delete ${displayName(pin, pins)}`}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {selected && (
          <>
            <div style={{ borderTop: '1px solid var(--border)' }} />
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <C2PinGlyph type={selected.type} size={14} />
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
                  x {formatMetres(selected.x)} m &nbsp; y {formatMetres(selected.y)} m
                </span>
              </Field>
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
                  <Field label="Approach">
                    <div style={{ display: 'flex', borderRadius: 4, border: '1px solid var(--border)', overflow: 'hidden' }}>
                      {[
                        { value: 'go_to', label: 'Go to' },
                        { value: 'go_through', label: 'Go through' },
                      ].map(({ value, label }) => {
                        const active = selected.action.approach === value
                        return (
                          <button
                            key={value}
                            disabled={disabled}
                            onClick={() => onChange(selected.id, {
                              action: { ...selected.action, approach: value },
                            })}
                            style={{
                              flex: 1, padding: '5px 0', border: 'none', fontSize: 11,
                              fontFamily: 'var(--font-mono)',
                              background: active ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
                              color: active ? 'var(--accent-bright)' : 'var(--text)',
                              cursor: disabled ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </Field>
                  <Field label="Dwell (seconds)">
                    <input
                      type="number"
                      min="0"
                      value={selected.action.dwellSeconds}
                      disabled={disabled}
                      onChange={(e) => onChange(selected.id, {
                        action: { ...selected.action, dwellSeconds: Math.max(0, Number(e.target.value) || 0) },
                      })}
                      className="val-mono"
                      style={inputStyle}
                    />
                  </Field>
                </>
              )}

              {HEADING_TYPES.has(selected.type) && (
                <Field label="Facing on arrival">
                  <C2HeadingDial
                    yaw={selected.yaw}
                    isSet={effectiveYaw(selected) != null}
                    disabled={disabled}
                    onChange={(yaw) => onSetYaw(selected.id, yaw)}
                    onClear={() => onSetYaw(selected.id, null)}
                  />
                </Field>
              )}
              {selected.type === 'simple' && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  Route only — the robot passes through without stopping, so there is no facing
                  or dwell to set here.
                </div>
              )}
              {selected.type === 'home' && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  Where the robot returns to when a job ends or is aborted. One per graph —
                  placing another moves this one.
                </div>
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
      </div>
    </div>
  )
}
