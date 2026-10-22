import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ResizeHandle } from './ui/ResizeHandle'
import { ZoomControls, ScaleBar, CoordReadout } from './ui/C2MapControls'
import { C2MapCanvas } from './widgets/C2MapCanvas'
import { C2PointsWidget } from './widgets/C2PointsWidget'
import { C2PinPopover } from './widgets/C2PinPopover'
import { C2PoiHoverCard, C2PoiViewer } from './widgets/C2PoiPhotos'
import { WarningModal } from './ui/WarningModal'
import { degToRad, fitView, screenToWorld, worldToScreen } from '../lib/c2Coords'
import {
  defaultName, displayName, displayNumber, makePin, pairedYaw, reindexOrder, routeOrder, withMapPoints,
} from '../lib/c2Pins'
import {
  applyFrame, composeFrames, framesOnto, invertFrame, linkKey, linksFromKeys, mapToMap, mapTurner, partnerOf, pinTurn,
  savedFrame, switchPair,
} from '../lib/c2Graph'
import { MAX_STITCH_PIXELS, matchMaps, scoreFrame, stitchMaps, stitchSize } from '../lib/c2Align'
import { combinedColor, distToSegment, drawGraphLayer, drawMapsOnto } from '../lib/c2GraphDraw'
import { useC2GraphStore, useRoutePhotos } from '../hooks/useC2GraphStore'
import { withRoutePhotos } from '../lib/c2Store'
import { useC2Maps, useMapViews } from '../hooks/useC2Maps'
import '../navplan_tester/tester.css'

// Where graphs are made. A graph spans any number of the robot's maps: they show side by side,
// a click expands one to edit it, and Map Switch pairs join them. C2 only runs saved graphs.
// Every change is saved as it happens (useC2GraphStore).

const NONE = []
const NO_ROTATIONS = {}
const NO_ALIGNMENTS = {}
const GRAPH_NAME_RE = /^[A-Za-z0-9_]+$/
const HISTORY_LIMIT = 200
const COALESCE_MS = 700
const LINK_HIT_PX = 7
const POI_HOVER_PX = 16
const HOVER_CARD_LINGER_MS = 250
const ZOOM_STEP = 1.4
const RAIL_W = 34
// Matches the transitions in tester.css.
const SLIDE_MS = 220
const LAST_EDITED_KEY = 'tmms.pathEditor.lastGraph'
// The graph open in this browser tab, and which map was expanded: kept for the session, so
// switching to C2 and back (or reloading) comes back to it; a new tab starts on the graph list.
const SESSION_KEY = 'tmms.pathEditor.open'

function sessionOpen() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') } catch { return null }
}
const SWITCH_LINE = '#60A5FA'
const BLANK_VIEW = { scale: 1, x: 0, y: 0 }

const STORE_STATUS = {
  loading: { text: 'loading…', color: 'var(--text-dim)' },
  saved: { text: '● saved', color: '#4ADE80' },
  saving: { text: 'saving…', color: '#60A5FA' },
  retrying: { text: '⚠ not saved — retrying', color: '#FBBF24' },
  offline: { text: '⚠ storage offline', color: '#F87171' },
}

const isTyping = (t) => Boolean(t) && (t.isContentEditable
  || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')

// The navplan tester's sidebar toggle: the whole strip is the button.
function Rail({ open, onToggle }) {
  const label = open ? 'Hide the points panel' : 'Show the points panel'
  return (
    <button
      className="panel npt-rail"
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls="path-editor-sidebar"
      onClick={onToggle}
      style={{
        width: RAIL_W, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '8px 0', cursor: 'pointer',
      }}
    >
      <span className="npt-rail-chevron">
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          className="npt-turn"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </span>
    </button>
  )
}

// Turns one map on screen, like rotating a photo. Display only: saved with the graph so C2
// shows the map the same way, never sent to the robot.
function RotateControl({ deg, onChange }) {
  const [open, setOpen] = useState(false)
  const set = (d) => onChange(Math.round((((d + 180) % 360) + 360) % 360 - 180))
  const stop = (e) => e.stopPropagation()
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onClick={stop} onPointerDown={stop}>
      <button
        className="btn-icon val-mono"
        style={{ fontSize: 10, padding: '1px 7px', ...(open && { borderColor: 'var(--accent-bright)' }) }}
        onClick={() => setOpen((o) => !o)}
        title="Turn this map on screen"
      >
        ↻ {deg}°
      </button>
      {open && (
        <div
          className="panel"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 30, width: 260, padding: 10,
            display: 'flex', flexDirection: 'column', gap: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
            textTransform: 'none', letterSpacing: 0,
          }}
        >
          <input type="range" min={-180} max={180} step={1} value={deg} onChange={(e) => set(Number(e.target.value))} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn-icon" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => set(deg - 90)}>⟲ 90°</button>
            <button className="btn-icon" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => set(deg - 1)}>−1°</button>
            <span className="val-mono" style={{ fontSize: 12, color: 'var(--text-h)', minWidth: 40, textAlign: 'center' }}>{deg}°</span>
            <button className="btn-icon" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => set(deg + 1)}>+1°</button>
            <button className="btn-icon" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => set(deg + 90)}>⟳ 90°</button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-icon" style={{ flex: 1, fontSize: 11, padding: '4px 8px' }} onClick={() => set(0)}>Reset</button>
            <button className="btn-icon" style={{ flex: 1, fontSize: 11, padding: '4px 8px' }} onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </span>
  )
}

function MapChecklist({ maps, chosen, onToggle, exclude = NONE }) {
  const shown = (maps ?? []).filter((m) => !exclude.includes(m.name))
  if (maps === null) return <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Reading the map store…</div>
  if (shown.length === 0) return <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No more maps on the robot.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {shown.map((m) => {
        const on = chosen.includes(m.name)
        return (
          <label
            key={m.name}
            className="flex items-center gap-2"
            style={{
              padding: '6px 8px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${on ? 'var(--accent-bright)' : 'var(--border)'}`,
              background: on ? 'color-mix(in srgb, var(--accent-bright) 14%, transparent)' : 'transparent',
            }}
          >
            <input type="checkbox" checked={on} onChange={() => onToggle(m.name)} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span className="val-mono" style={{ fontSize: 12, color: 'var(--text-h)', wordBreak: 'break-all' }}>{m.name}</span>
              <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {m.width}×{m.height} px · {(m.pois ?? []).length} mapped POI
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

function StartScreen({ graphs, maps, storeStatus, lastId, onCreate, onOpen }) {
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState([])
  const nameTaken = graphs.some((g) => g.name === name)
  const ready = name && GRAPH_NAME_RE.test(name) && !nameTaken && chosen.length > 0
  const sorted = graphs.slice().sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  const card = { flex: 1, minWidth: 320, maxWidth: 560, display: 'flex', flexDirection: 'column', overflow: 'hidden' }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div className="panel" style={card}>
        <div className="panel-header"><span>① NEW ROUTE</span></div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Name the route and pick the maps it covers. Pick several to join them with Map
            Switches. You can add more maps later.
          </div>
          <input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready) onCreate(name, chosen) }}
            placeholder="route_name_with_underscores"
            className="val-mono"
            style={{
              width: '100%', padding: '7px 9px', borderRadius: 4, border: '1px solid var(--border)',
              background: 'var(--bg)', color: 'var(--text-h)', fontSize: 13, outline: 'none',
            }}
          />
          {nameTaken && <div style={{ fontSize: 11, color: '#F87171' }}>A route with that name already exists.</div>}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
            MAPS · {chosen.length} picked
          </div>
          <MapChecklist
            maps={maps}
            chosen={chosen}
            onToggle={(n) => setChosen((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n]))}
          />
          <button
            className="btn-icon"
            style={{ fontSize: 12, padding: '8px 12px', borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }}
            disabled={!ready}
            onClick={() => onCreate(name, chosen)}
            title={!name ? 'Name the route first' : !chosen.length ? 'Pick at least one map' : undefined}
          >
            Create {name || 'route'}{chosen.length ? ` on ${chosen.length} map${chosen.length > 1 ? 's' : ''}` : ''} ▶
          </button>
        </div>
      </div>

      <div className="panel" style={card}>
        <div className="panel-header">
          <span>② CONTINUE EDITING</span>
          {STORE_STATUS[storeStatus] && (
            <span className="val-mono" style={{ fontSize: 10, color: STORE_STATUS[storeStatus].color }}>
              {STORE_STATUS[storeStatus].text}
            </span>
          )}
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sorted.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {storeStatus === 'loading' ? 'Loading saved routes…' : 'No routes yet. Make one on the left.'}
            </div>
          )}
          {sorted.map((g) => {
            const own = g.pins.filter((p) => p.source !== 'mapping').length
            return (
              <div
                key={g.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  padding: '8px 10px', borderRadius: 4, border: '1px solid var(--border)',
                  borderLeft: g.id === lastId ? '3px solid var(--accent-bright)' : '3px solid transparent',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="val-mono" style={{ fontSize: 13, color: 'var(--text-h)', wordBreak: 'break-all' }}>
                    {g.name}{g.id === lastId && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}> · last edited</span>}
                  </div>
                  <div className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                    {g.maps.length} map{g.maps.length === 1 ? '' : 's'}: {g.maps.join(', ') || '—'}
                  </div>
                  <div className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    {own} point{own === 1 ? '' : 's'} · {(g.links ?? []).length} links
                    {g.updatedAt && ` · ${new Date(g.updatedAt).toLocaleString()}`}
                  </div>
                </div>
                <button
                  className="btn-icon"
                  style={{ fontSize: 11, padding: '6px 12px', flexShrink: 0 }}
                  onClick={() => onOpen(g.id)}
                >
                  ✎ Edit
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function PathEditorPage() {
  const { graphs, updateGraphs, status: storeStatus } = useC2GraphStore()
  const [openId, setOpenId] = useState(() => sessionOpen()?.id ?? null)
  const entry = openId ? graphs.find((g) => g.id === openId) ?? null : null
  const graphMaps = entry?.maps ?? NONE
  const { maps, byName, images, error: mapError, refresh, gridFor } = useC2Maps(graphMaps)

  const [lastId, setLastId] = useState(() => {
    try { return localStorage.getItem(LAST_EDITED_KEY) } catch { return null }
  })

  const pins = entry?.pins ?? NONE
  const links = entry?.links ?? NONE
  const rotations = entry?.rotations ?? NO_ROTATIONS
  // How maps sit on each other, found by matching walls in the combined view (c2Align).
  const alignments = entry?.alignments ?? NO_ALIGNMENTS
  const [focusMap, setFocusMap] = useState(() => sessionOpen()?.focusMap ?? null)
  const [selectedId, setSelectedId] = useState(null)
  const [placingType, setPlacingType] = useState(null)
  const [linkMode, setLinkMode] = useState(false)
  const [linkStart, setLinkStart] = useState(null)
  const [selectedLink, setSelectedLink] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [hover, setHover] = useState(null)
  const [showNames, setShowNames] = useState(true)
  const [addingMaps, setAddingMaps] = useState(null)
  const editable = Boolean(entry)

  // -- graph edits ---------------------------------------------------------
  const editGraph = useCallback((fn) => {
    updateGraphs((prev) => prev.map((g) => (g.id === openId
      ? { ...g, ...fn(g), updatedAt: new Date().toISOString() }
      : g)))
  }, [openId, updateGraphs])

  const pinsRef = useRef(pins)
  useEffect(() => { pinsRef.current = pins }, [pins])
  const historyRef = useRef({ past: [], future: [], key: null, at: 0 })
  const [history, setHistory] = useState({ past: 0, future: 0 })

  const resetHistory = useCallback((next) => {
    historyRef.current = { past: [], future: [], key: null, at: 0 }
    setHistory({ past: 0, future: 0 })
    pinsRef.current = next
  }, [])

  const writePins = useCallback((next) => {
    pinsRef.current = next
    editGraph(() => ({ pins: next }))
  }, [editGraph])

  const mutate = useCallback((key, updater) => {
    const prev = pinsRef.current
    const next = updater(prev)
    if (next === prev) return
    const h = historyRef.current
    const now = performance.now()
    if (!(key !== null && h.key === key && now - h.at < COALESCE_MS)) {
      h.past.push(prev)
      if (h.past.length > HISTORY_LIMIT) h.past.shift()
      h.future = []
      setHistory({ past: h.past.length, future: 0 })
    }
    h.key = key
    h.at = now
    writePins(next)
  }, [writePins])

  const stepHistory = useCallback((from, to) => {
    const h = historyRef.current
    if (h[from].length === 0) return
    h[to].push(pinsRef.current)
    const restored = h[from].pop()
    h.key = null
    setHistory({ past: h.past.length, future: h.future.length })
    if (!restored.some((p) => p.id === selectedId)) setSelectedId(null)
    writePins(restored)
  }, [writePins, selectedId])
  const undo = useCallback(() => stepHistory('past', 'future'), [stepHistory])
  const redo = useCallback(() => stepHistory('future', 'past'), [stepHistory])

  const setLinks = useCallback((fn) => editGraph((g) => ({ links: fn(g.links ?? []) })), [editGraph])

  const clearTools = useCallback(() => {
    setSelectedId(null)
    setPlacingType(null)
    setLinkMode(false)
    setLinkStart(null)
    setSelectedLink(null)
    setRenaming(null)
  }, [])

  const openGraph = useCallback((id) => {
    const g = graphs.find((x) => x.id === id)
    if (!g) return
    setOpenId(id)
    resetHistory(g.pins)
    clearTools()
    setFocusMap(g.maps.length === 1 ? g.maps[0] : null)
    setLastId(id)
    try { localStorage.setItem(LAST_EDITED_KEY, id) } catch {}
  }, [graphs, resetHistory, clearTools])

  const createGraph = useCallback((name, mapNames) => {
    const g = {
      id: `g_${Date.now().toString(36)}`,
      name,
      maps: mapNames,
      pins: [],
      links: [],
      updatedAt: new Date().toISOString(),
    }
    updateGraphs((prev) => [...prev, g])
    setOpenId(g.id)
    resetHistory([])
    clearTools()
    setFocusMap(mapNames.length === 1 ? mapNames[0] : null)
    setLastId(g.id)
    try { localStorage.setItem(LAST_EDITED_KEY, g.id) } catch {}
  }, [updateGraphs, resetHistory, clearTools])

  useEffect(() => {
    try {
      if (openId) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: openId, focusMap }))
      else sessionStorage.removeItem(SESSION_KEY)
    } catch {}
  }, [openId, focusMap])

  // A graph reopened from the session arrives once the store has loaded: start its undo
  // history from what it holds then, as opening it by hand does. A graph that has gone
  // (deleted elsewhere) drops back to the list.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !openId || storeStatus === 'loading') return
    restored.current = true
    const g = graphs.find((x) => x.id === openId)
    if (g) resetHistory(g.pins)
    else { setOpenId(null); setFocusMap(null) }
  }, [openId, graphs, storeStatus, resetHistory])

  const closeGraph = useCallback(() => {
    setOpenId(null)
    setFocusMap(null)
    resetHistory([])
    clearTools()
    setAddingMaps(null)
  }, [resetHistory, clearTools])

  // Mapping points of every map in the graph, added once they are known. Not an undoable step:
  // history is patched so an undo cannot take them away again.
  // Mapping POIs deleted from this route are left out (the map files keep them).
  const mapsKey = graphMaps.join('|')
  const hidden = entry?.hiddenPois ?? NONE
  const hiddenKey = hidden.join('|')
  useEffect(() => {
    if (!entry || !maps) return
    const entries = graphMaps.map((n) => byName.get(n)).filter(Boolean)
    const next = withMapPoints(pinsRef.current, entries, hidden)
    if (next === pinsRef.current) return
    const h = historyRef.current
    h.past = h.past.map((p) => withMapPoints(p, entries, hidden))
    h.future = h.future.map((p) => withMapPoints(p, entries, hidden))
    writePins(next)
  }, [entry?.id, mapsKey, maps, byName, hiddenKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // An undo can bring a deleted mapping POI back into the pins: then it is no longer deleted.
  useEffect(() => {
    if (!entry || !hidden.some((id) => pins.some((p) => p.id === id))) return
    editGraph((g) => ({ hiddenPois: (g.hiddenPois ?? []).filter((id) => !g.pins.some((p) => p.id === id)) }))
  }, [entry, hidden, pins, editGraph])

  const restoreMapPois = useCallback(() => editGraph(() => ({ hiddenPois: [] })), [editGraph])

  const addMaps = useCallback((names) => {
    if (!names.length) return
    editGraph((g) => ({ maps: [...g.maps, ...names.filter((n) => !g.maps.includes(n))] }))
    setAddingMaps(null)
    setFocusMap(null)
  }, [editGraph])

  // Asks first, in the dashboard's own warning dialog: it cannot be undone.
  const [askRemove, setAskRemove] = useState(null)
  const requestRemoveMap = useCallback((name) => {
    const count = pinsRef.current.filter((p) => p.map === name && p.source !== 'mapping').length
    setAskRemove({ name, count })
  }, [])

  const removeMap = useCallback((name) => {
    setAskRemove(null)
    const gone = new Set(pinsRef.current.filter((p) => p.map === name).map((p) => p.id))
    const kept = pinsRef.current.filter((p) => !gone.has(p.id))
      .map((p) => (p.pair && gone.has(p.pair) ? { ...p, pair: null } : p))
    resetHistory(kept)
    editGraph((g) => ({
      maps: g.maps.filter((m) => m !== name),
      pins: kept,
      links: (g.links ?? []).filter((k) => !k.split('|').some((id) => gone.has(id))),
    }))
    clearTools()
    setFocusMap((f) => (f === name ? null : f))
  }, [editGraph, resetHistory, clearTools])

  // -- pins ----------------------------------------------------------------
  const addPin = useCallback((map, type, world) => {
    let placedId = null
    mutate(null, (prev) => {
      if (type === 'home') {
        // One Home per graph: placing another moves it, to whichever map is open.
        const existing = prev.find((p) => p.type === 'home')
        if (existing) {
          placedId = existing.id
          return prev.map((p) => (p.id === existing.id ? { ...p, x: world.x, y: world.y, map } : p))
        }
      }
      const pin = { ...makePin(type, world, prev), map }
      placedId = pin.id
      return [...prev, pin]
    })
    if (placedId) setSelectedId(placedId)
    if (type === 'home') setPlacingType(null)
  }, [mutate])

  const movePin = useCallback((id, world) => {
    mutate(`move:${id}`, (prev) => prev.map((p) => (p.id === id ? { ...p, x: world.x, y: world.y } : p)))
  }, [mutate])

  const updatePin = useCallback((id, patch) => {
    mutate(`edit:${id}:${Object.keys(patch).join(',')}`, (prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }, [mutate])

  // A linked switch's partner turns with it: one heading for the pair (see pairedYaw).
  const setYaw = useCallback((id, yaw) => {
    mutate(`yaw:${id}`, (prev) => {
      const pin = prev.find((p) => p.id === id)
      const other = partnerOf(prev, pin)
      return prev.map((p) => {
        if (p.id === id) return { ...p, yaw: yaw ?? 0, headingSet: yaw != null, headingDefault: false }
        if (other && p.id === other.id && yaw != null) {
          return { ...p, yaw: pairedYaw(yaw, pin.map, p.map, mapTurner(prev, rotations, alignments)), headingSet: true, headingDefault: false }
        }
        return p
      })
    })
  }, [mutate, rotations, alignments])

  // Same rules as the navplan tester's setType: a switch always has a heading, and leaving
  // the switch type drops its link.
  const setPinType = useCallback((id, type) => {
    mutate(null, (prev) => prev.map((p) => {
      if (p.id !== id || p.type === type || p.source === 'mapping') return p
      const next = { ...p, type }
      if (type === 'action' && !next.action) next.action = { description: '' }
      if (type === 'map_switch') {
        next.pair = null
        if (!next.headingSet) Object.assign(next, { yaw: 0, headingSet: true, headingDefault: true })
      } else {
        delete next.pair
      }
      return next
    }))
  }, [mutate])

  const removePin = useCallback((id) => {
    mutate(null, (prev) => (prev.some((p) => p.id === id) ? reindexOrder(prev.filter((p) => p.id !== id)) : prev))
    // A mapping POI would come straight back from the map files: remember it is deleted here.
    if (id.startsWith('poi_')) {
      editGraph((g) => ({ hiddenPois: [...new Set([...(g.hiddenPois ?? []), id])] }))
    }
    setSelectedId((cur) => (cur === id ? null : cur))
    setRenaming((cur) => (cur?.id === id ? null : cur))
  }, [mutate, editGraph])

  // Both switches name each other, in one undoable step. As the tester does, a heading turned
  // on one side is the best guess for the other while that one is still the default.
  const pairSwitch = useCallback((id, otherId) => {
    mutate(null, (prev) => {
      const a = prev.find((p) => p.id === id)
      const b = prev.find((p) => p.id === otherId)
      if (!a || !b) return prev
      // One heading for the pair: the first switch's, unless only the second was turned.
      const chosen = (p) => p.headingSet && !p.headingDefault
      const [lead, follow] = !chosen(a) && chosen(b) ? [b, a] : [a, b]
      // Each switch has one partner: whatever either was linked to before is let go.
      const linked = prev.map((p) => {
        if (p.id === id) return { ...p, pair: otherId }
        if (p.id === otherId) return { ...p, pair: id }
        if (p.pair === id || p.pair === otherId) return { ...p, pair: null }
        return p
      })
      // A second pair between the same two maps can change how they are turned (pinTurn), so
      // every pair between them follows its side on the lead's map again, not just this one.
      const turnOf = mapTurner(linked, rotations, alignments)
      return linked.map((p) => {
        const o = p.map === follow.map ? partnerOf(linked, p) : null
        if (!o || o.map !== lead.map) return p
        return { ...p, yaw: pairedYaw(o.yaw ?? 0, o.map, p.map, turnOf), headingSet: true, headingDefault: false }
      })
    })
  }, [mutate, rotations, alignments])

  const unpairSwitch = useCallback((id) => {
    mutate(null, (prev) => {
      const other = partnerOf(prev, prev.find((p) => p.id === id))
      return prev.map((p) => (p.id === id || p.id === other?.id ? { ...p, pair: null } : p))
    })
  }, [mutate])

  const beginRename = useCallback((id) => {
    const pin = pinsRef.current.find((p) => p.id === id)
    if (!pin || pin.source === 'mapping') return
    setPlacingType(null)
    setSelectedId(id)
    setRenaming({ id, draft: pin.label })
  }, [])

  const commitRename = useCallback(() => {
    setRenaming((cur) => {
      if (cur) updatePin(cur.id, { label: cur.draft.trim() })
      return null
    })
  }, [updatePin])

  // -- derived -------------------------------------------------------------
  const ownPins = useMemo(() => pins.filter((p) => p.source !== 'mapping'), [pins])
  const mapPoints = useMemo(() => pins.filter((p) => p.source === 'mapping'), [pins])
  // Names and numbers count over the whole graph, every map, so each map shows the same ones.
  // Photos C2 took of this route's own POIs ride along as `poi`, as mapping POIs carry theirs.
  const { photos } = useRoutePhotos(entry?.id ?? null)
  const named = useMemo(() => withRoutePhotos(
    pins.map((p) => ({ ...p, name: displayName(p, pins), number: displayNumber(p, pins) })),
    photos, entry?.id,
  ), [pins, photos, entry?.id])
  const withPhotos = useMemo(() => named.filter((p) => p.poi), [named])

  const partners = useMemo(() => {
    const out = new Map()
    for (const p of pins) {
      const o = partnerOf(pins, p)
      if (o) out.set(p.id, { id: o.id, map: o.map, name: displayName(o, pins) })
    }
    return out
  }, [pins])

  const linksByMap = useMemo(() => {
    const out = new Map()
    for (const m of graphMaps) {
      const g = gridFor(m)
      out.set(m, linksFromKeys(named.filter((p) => p.map === m), links, g?.grid ?? null, g?.info ?? byName.get(m)))
    }
    return out
  }, [graphMaps, named, links, gridFor, byName])

  const selected = selectedId ? pins.find((p) => p.id === selectedId) ?? null : null
  const candidates = useMemo(() => (selected?.type === 'map_switch' && !partners.has(selected.id)
    ? named.filter((p) => p.type === 'map_switch' && p.map !== selected.map && !partners.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, map: p.map, x: p.x, y: p.y }))
    : NONE), [selected, partners, named])

  // -- views, one per map --------------------------------------------------
  // Turning a map turns its linked switches' headings with it, so each still points the same
  // way on screen as its partner on the other map.
  const setRotation = useCallback((m, deg) => {
    const next = { ...rotations, [m]: deg }
    const prev = pinsRef.current
    const turned = prev.map((p) => {
      const o = p.map === m ? partnerOf(prev, p) : null
      return o ? { ...p, yaw: pairedYaw(o.yaw ?? 0, o.map, m, mapTurner(prev, next, alignments)), headingSet: true, headingDefault: false } : p
    })
    pinsRef.current = turned
    editGraph(() => ({ rotations: next, pins: turned }))
  }, [rotations, alignments, editGraph])
  // Combined view: every map joined by two or more switch pairs, laid onto one base map. View
  // only; nothing about the route, the maps or the robot changes.
  const [combinedOn, setCombinedOn] = useState(null)
  const combinedBase = combinedOn && graphMaps.includes(combinedOn) ? combinedOn : null
  const shownMaps = useMemo(() => (combinedBase ? [combinedBase] : focusMap ? [focusMap] : graphMaps),
    [combinedBase, focusMap, graphMaps])
  const rotOf = useCallback((m) => degToRad(rotations[m]), [rotations])
  // Fitted once, then kept where the user left it (useMapViews).
  const { views, sizes, viewSetter, sizeSetter } = useMapViews(entry?.id ?? null, shownMaps, byName, images, rotOf)

  const toScreenOn = useCallback((m, p) => worldToScreen(p.x, p.y, byName.get(m), views[m] ?? BLANK_VIEW), [byName, views])

  const expand = useCallback((m) => {
    setCombinedOn(null)
    setFocusMap(m)
    setPlacingType(null)
    setLinkMode(false)
    setLinkStart(null)
    setSelectedLink(null)
  }, [])

  // -- sidebar (the tester's) ----------------------------------------------
  const pageRef = useRef(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarW, setSidebarW] = useState(380)
  // -- selection and linking -----------------------------------------------
  const selectPoint = useCallback((id) => {
    // A clicked pin's details are in the side panel, so make sure it is showing.
    if (id && !linkMode) setSidebarOpen(true)
    setSelectedLink(null)
    if (!linkMode) { setSelectedId(id); return }
    if (!id) { setLinkStart(null); return }
    const start = linkStart ? pinsRef.current.find((p) => p.id === linkStart) : null
    const to = pinsRef.current.find((p) => p.id === id)
    // Links stay on one map. Across maps, two Map Switches clicked in a row become a pair
    // (or stop being one); any other click on another map starts a new chain there.
    if (start && to && start.map !== to.map && start.type === 'map_switch' && to.type === 'map_switch') {
      if (partnerOf(pinsRef.current, start)?.id === to.id) unpairSwitch(start.id)
      else pairSwitch(start.id, to.id)
      setLinkStart(id)
      setSelectedId(id)
      return
    }
    if (!start || linkStart === id || start.map !== to?.map) { setLinkStart(id); setSelectedId(id); return }
    const key = linkKey(linkStart, id)
    setLinks((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    setLinkStart(id)
    setSelectedId(id)
  }, [linkMode, linkStart, setLinks, pairSwitch, unpairSwitch])

  const handleEmptyClick = useCallback((m, pt) => {
    if (linkMode) { setLinkStart(null); return true }
    const byId = new Map(named.map((p) => [p.id, p]))
    let best = null
    let bestD = LINK_HIT_PX
    for (const l of linksByMap.get(m) ?? NONE) {
      const a = byId.get(l.a)
      const b = byId.get(l.b)
      if (!a || !b) continue
      const d = distToSegment(pt, toScreenOn(m, a), toScreenOn(m, b))
      if (d < bestD) { best = l; bestD = d }
    }
    if (!best) { setSelectedLink(null); return false }
    setSelectedLink(best.key)
    setSelectedId(null)
    return true
  }, [linkMode, named, linksByMap, toScreenOn])

  const selectFromList = useCallback((pin) => {
    if (!pin) { setSelectedId(null); return }
    if (focusMap && pin.map !== focusMap) expand(pin.map)
    setSelectedId(pin.id)
  }, [focusMap, expand])

  // -- keyboard ------------------------------------------------------------
  useEffect(() => {
    if (!entry) return undefined
    const onKey = (e) => {
      if (isTyping(e.target)) return
      if (e.key === 'Escape') { clearTools(); return }
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
      else if (mod && key === 'z') { e.preventDefault(); undo() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && editable && selected) {
        e.preventDefault()
        removePin(selected.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entry, clearTools, undo, redo, removePin, editable, selected])

  // -- POI photos (expanded map) -------------------------------------------
  const [viewerId, setViewerId] = useState(null)
  const hoveredMapPoint = useMemo(() => {
    if (!hover || viewerId || !byName.get(hover.map)) return null
    const h = toScreenOn(hover.map, hover)
    return withPhotos.find((p) => p.map === hover.map
      && Math.hypot(toScreenOn(hover.map, p).x - h.x, toScreenOn(hover.map, p).y - h.y) <= POI_HOVER_PX) ?? null
  }, [hover, viewerId, withPhotos, toScreenOn, byName])
  const [cardId, setCardId] = useState(null)
  const onCardRef = useRef(false)
  useEffect(() => {
    if (hoveredMapPoint) { setCardId(hoveredMapPoint.id); return undefined }
    if (viewerId) { setCardId(null); return undefined }
    const t = setTimeout(() => { if (!onCardRef.current) setCardId(null) }, HOVER_CARD_LINGER_MS)
    return () => clearTimeout(t)
  }, [hoveredMapPoint, viewerId])
  const cardPoint = withPhotos.find((p) => p.id === cardId) ?? null
  const viewerPoint = withPhotos.find((p) => p.id === viewerId) ?? null

  // -- switch pairs drawn across the grid ----------------------------------
  const gridRef = useRef(null)
  const bodyRefs = useRef(new Map())
  const [bodyRects, setBodyRects] = useState({})
  useLayoutEffect(() => {
    const host = gridRef.current
    if (!host) return
    const base = host.getBoundingClientRect()
    const next = {}
    for (const m of shownMaps) {
      const el = bodyRefs.current.get(m)
      if (!el) continue
      const r = el.getBoundingClientRect()
      next[m] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
    }
    setBodyRects((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }, [shownMaps, sizes])

  const pairLines = useMemo(() => {
    if (focusMap || combinedBase) return NONE
    const out = []
    for (const p of pins) {
      const o = partners.get(p.id)
      if (!o || p.id > o.id) continue
      const other = pins.find((q) => q.id === o.id)
      const ra = bodyRects[p.map]
      const rb = bodyRects[other.map]
      if (!ra || !rb || !byName.get(p.map) || !byName.get(other.map)) continue
      const a = toScreenOn(p.map, p)
      const b = toScreenOn(other.map, other)
      out.push({ key: p.id, x1: ra.x + a.x, y1: ra.y + a.y, x2: rb.x + b.x, y2: rb.y + b.y })
    }
    return out
  }, [focusMap, combinedBase, pins, partners, bodyRects, byName, toScreenOn])

  // -- combined view -------------------------------------------------------
  const baseFrames = useMemo(() => (combinedBase ? framesOnto(pins, combinedBase, graphMaps, alignments) : null),
    [combinedBase, pins, graphMaps, alignments])

  // Placing a map by hand: `rel` is the draft of where it sits on the map it is joined to
  // (map -> parent). While it is open it stands in for the saved one.
  const [adjust, setAdjust] = useState(null)
  useEffect(() => { setAdjust(null) }, [combinedBase, entry?.id])
  const frames = useMemo(() => {
    if (!baseFrames || !adjust) return baseFrames
    const temp = { ...alignments }
    delete temp[`${adjust.parent}|${adjust.map}`]
    temp[`${adjust.map}|${adjust.parent}`] = adjust.rel
    return framesOnto(pins, combinedBase, graphMaps, temp)
  }, [baseFrames, adjust, alignments, pins, combinedBase, graphMaps])

  // A move T (in base-map coordinates) applied to a map joined to `parent`, on top of `fromRel`.
  const movedRelOn = useCallback((parent, T, fromRel) => {
    const P = baseFrames.get(parent)
    return composeFrames(invertFrame(P), composeFrames(T, composeFrames(P, fromRel)))
  }, [baseFrames])
  const movedRel = useCallback((T, fromRel) => movedRelOn(adjust.parent, T, fromRel), [movedRelOn, adjust])

  // Sliders: turn, and left-right / down-up as seen on screen, all measured from `base` (where
  // the map was when the sliders were last at zero). Dragging, matching or Reset re-zero them.
  const SLIDERS_ZERO = { turnDeg: 0, right: 0, up: 0 }
  const withSliders = (a, patch) => {
    const n = { ...a, ...patch, score: null, matched: false }
    const shift = {
      turn: 0,
      tx: n.rightDir.x * n.right + n.upDir.x * n.up,
      ty: n.rightDir.y * n.right + n.upDir.y * n.up,
    }
    n.rel = movedRelOn(n.parent, composeFrames(shift, turnAbout(n.turnDeg, n.pivot)), n.base)
    return n
  }
  const startAdjust = useCallback((m) => {
    const parent = baseFrames?.get(m)?.parent
    const f = parent && mapToMap(pinsRef.current, m, parent, alignments)
    if (!f) return
    const info = byName.get(combinedBase)
    const view = views[combinedBase] ?? BLANK_VIEW
    const at = (x, y) => screenToWorld(x, y, info, view)
    const o = at(0, 0)
    const unit = (p, sign) => {
      const d = { x: (p.x - o.x) * sign, y: (p.y - o.y) * sign }
      const len = Math.hypot(d.x, d.y) || 1
      return { x: d.x / len, y: d.y / len }
    }
    const rel = { turn: f.turn, tx: f.tx, ty: f.ty }
    setAdjust({
      map: m, parent, rel, base: rel, start: rel, ...SLIDERS_ZERO, score: null, matched: false,
      pivot: viewCentre(), rightDir: unit(at(1, 0), 1), upDir: unit(at(0, 1), -1),
    })
  }, [baseFrames, alignments, byName, combinedBase, views]) // eslint-disable-line react-hooks/exhaustive-deps
  const turnAbout = (deg, pivot) => {
    const a = degToRad(deg)
    const c = Math.cos(a)
    const s = Math.sin(a)
    return { turn: a, tx: pivot.x - (c * pivot.x - s * pivot.y), ty: pivot.y - (s * pivot.x + c * pivot.y) }
  }
  const viewCentre = () => {
    const size = sizes[combinedBase] ?? { width: 0, height: 0 }
    return screenToWorld(size.width / 2, size.height / 2, byName.get(combinedBase), views[combinedBase] ?? BLANK_VIEW)
  }

  const adjustDrag = useRef(null)
  const adjustHandlers = adjust && combinedBase ? {
    onPointerDown: (e) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      const r = e.currentTarget.getBoundingClientRect()
      const pt = { x: e.clientX - r.left, y: e.clientY - r.top }
      const info = byName.get(combinedBase)
      const view = views[combinedBase] ?? BLANK_VIEW
      adjustDrag.current = { startRel: adjust.rel, start: screenToWorld(pt.x, pt.y, info, view), sx: pt.x, pivot: viewCentre(), info, view }
    },
    onPointerMove: (e) => {
      const d = adjustDrag.current
      if (!d) return
      const r = e.currentTarget.getBoundingClientRect()
      const pt = { x: e.clientX - r.left, y: e.clientY - r.top }
      // Shift+drag turns (0.2° per pixel sideways); a plain drag moves.
      const T = e.shiftKey
        ? turnAbout((pt.x - d.sx) * 0.2, d.pivot)
        : (() => { const w = screenToWorld(pt.x, pt.y, d.info, d.view); return { turn: 0, tx: w.x - d.start.x, ty: w.y - d.start.y } })()
      setAdjust((a) => { if (!a) return a; const rel = movedRel(T, d.startRel); return { ...a, rel, base: rel, ...SLIDERS_ZERO, score: null, matched: false } })
    },
    onPointerUp: (e) => {
      adjustDrag.current = null
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    },
    onWheel: (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const factor = Math.exp(-e.deltaY * 0.0015)
      viewSetter(combinedBase)((v) => {
        const next = Math.min(40, Math.max(0.05, v.scale * factor))
        return { ...v, scale: next, x: mx - (mx - v.x) * (next / v.scale), y: my - (my - v.y) * (next / v.scale) }
      })
    },
  } : null

  const adjustImgs = adjust && {
    to: { img: images.get(adjust.parent), info: byName.get(adjust.parent) },
    from: { img: images.get(adjust.map), info: byName.get(adjust.map) },
  }
  const matchFromHere = () => {
    const pair = switchPair(pinsRef.current, adjust.map, adjust.parent)
    if (!pair || !adjustImgs.to.img || !adjustImgs.from.img) return
    const r = matchMaps(adjustImgs.to, adjustImgs.from, pair.a, pair.b, adjust.rel, 8)
    if (r) {
      const rel = { turn: r.turn, tx: r.tx, ty: r.ty }
      setAdjust((a) => a && { ...a, rel, base: rel, ...SLIDERS_ZERO, score: r.score, matched: true })
    }
    else setAdjust((a) => a && { ...a, score: 0, matched: false })
  }
  // -- save as one map --------------------------------------------------------
  // The lined-up maps stitched into one and saved to the robot's map store, like the map
  // editor saves a map. Mapping POIs come along, carried onto the base map's coordinates;
  // only the base map's keep their photos (the store copies photos from one map only).
  const [stitch, setStitch] = useState(null)
  const openStitch = () => {
    const base = byName.get(combinedBase)
    setStitch({ name: `${entry.name}_stitched`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120), res: base?.resolution ?? 0.05, phase: 'edit', message: '' })
  }
  const stitchPreview = stitch && frames ? stitchSize(frames, byName, stitch.res) : null
  const stitchTaken = stitch ? (maps ?? []).some((m) => m.name === stitch.name) : false
  const saveStitch = async () => {
    if (!frames || !stitch?.name) return
    setStitch((st) => ({ ...st, phase: 'saving', message: 'Stitching…' }))
    try {
      const out = await stitchMaps(frames, images, byName, stitch.res)
      const baseIds = new Set()
      const pois = []
      let nextId = 1
      for (const p of pins) {
        if (p.source !== 'mapping' || !frames.has(p.map)) continue
        const id = Number(p.id.match(/^poi_(\d+)@/)?.[1])
        if (p.map === combinedBase && Number.isInteger(id)) { baseIds.add(id); nextId = Math.max(nextId, id + 1) }
      }
      for (const p of pins) {
        if (p.source !== 'mapping' || !frames.has(p.map)) continue
        const own = Number(p.id.match(/^poi_(\d+)@/)?.[1])
        const onBase = p.map === combinedBase && baseIds.has(own)
        const w = applyFrame(frames.get(p.map), p)
        pois.push({
          id: onBase ? own : nextId++,
          name: p.label,
          x: w.x,
          y: w.y,
          yaw: (((p.yaw ?? 0) + frames.get(p.map).turn) * 180) / Math.PI,
          timestamp: p.poi?.timestamp ?? '',
          snapshots: onBase ? p.poi?.snapshots ?? [] : [],
          description: p.poi?.description ?? '',
        })
      }
      const form = new FormData()
      form.append('png', out.blob, `${stitch.name}.png`)
      form.append('meta', JSON.stringify({ resolution: out.resolution, origin: out.origin, pois, sourceName: combinedBase }))
      const res = await fetch(`/api/maps2d/${encodeURIComponent(stitch.name)}`, { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `save failed (${res.status})`)
      refresh()
      setStitch((st) => ({
        ...st, phase: 'done',
        message: `${body.overwritten ? 'Replaced' : 'Saved'} ${stitch.name}: ${out.width}×${out.height} px, about ${Math.round(out.width * out.resolution)} × ${Math.round(out.height * out.resolution)} m. It is in the map list now.`,
      }))
    } catch (err) {
      setStitch((st) => ({ ...st, phase: 'edit', message: `Not saved: ${err.message}` }))
    }
  }

  const saveAdjust = () => {
    const sc = adjustImgs.to.img && adjustImgs.from.img ? scoreFrame(adjustImgs.to, adjustImgs.from, adjust.rel) : null
    const next = { ...alignments }
    delete next[`${adjust.parent}|${adjust.map}`]
    next[`${adjust.map}|${adjust.parent}`] = { ...adjust.rel, score: sc ?? 0, hand: !adjust.matched }
    editGraph(() => ({ alignments: next }))
    setAdjust(null)
  }

  // Lines every joined map up on the map it is joined to, by matching walls about their
  // switch pair, and saves the result with the route. A weak match is not saved.
  const [aligning, setAligning] = useState(null)
  const lineUpByWalls = useCallback(() => {
    if (!frames) return
    const jobs = [...frames].filter(([m, f]) => m !== combinedBase && f.parent)
    if (!jobs.length) return
    setAligning({ running: true, results: {} })
    // Lets "Matching walls…" paint before the search holds the page for a moment.
    setTimeout(() => {
      const next = { ...alignments }
      const results = {}
      for (const [m, f] of jobs) {
        const to = f.parent
        const pair = switchPair(pinsRef.current, m, to)
        if (!pair || !images.get(m) || !images.get(to)) { results[m] = { error: 'not ready (map still loading?)' }; continue }
        const byPins = mapToMap(pinsRef.current, m, to, {})
        const r = matchMaps(
          { img: images.get(to), info: byName.get(to) }, { img: images.get(m), info: byName.get(m) },
          pair.a, pair.b, byPins?.source === 'pins' ? byPins : null,
        )
        if (!r) { results[m] = { error: 'too little shared area with walls to match' }; continue }
        results[m] = { score: r.score }
        if (r.score < 0.25) { results[m].weak = true; continue }
        delete next[`${to}|${m}`]
        next[`${m}|${to}`] = { turn: r.turn, tx: r.tx, ty: r.ty, score: r.score }
      }
      editGraph(() => ({ alignments: next }))
      setAligning({ running: false, results })
    }, 50)
  }, [frames, combinedBase, alignments, images, byName, editGraph])

  // Matched once by itself the first time the combined view opens on maps not yet matched.
  const autoMatched = useRef(new Set())
  useEffect(() => {
    if (!frames || aligning?.running || adjust) return
    const pending = [...frames].filter(([m, f]) => m !== combinedBase && f.source !== 'walls')
    if (!pending.length || pending.some(([m, f]) => !images.get(m) || !images.get(f.parent))) return
    const key = `${entry?.id}|${combinedBase}|${pending.map(([m]) => m).join(',')}`
    if (autoMatched.current.has(key)) return
    autoMatched.current.add(key)
    lineUpByWalls()
  }, [frames, combinedBase, images, aligning, adjust, entry?.id, lineUpByWalls])
  const combinedPins = useMemo(() => {
    if (!frames) return NONE
    const out = []
    for (const [m, f] of frames) {
      for (const p of named) {
        if (p.map !== m) continue
        out.push({
          ...p,
          ...applyFrame(f, p),
          yaw: (p.yaw ?? 0) + f.turn,
          ...(p.type === 'map_switch' && !partners.has(p.id) && { unpaired: true }),
        })
      }
    }
    return out
  }, [frames, named, partners])
  const combinedLinks = useMemo(() => (frames ? linksFromKeys(combinedPins, links, null, null) : NONE),
    [frames, combinedPins, links])
  const notJoined = frames ? graphMaps.filter((m) => !frames.has(m)) : NONE
  const combinedMismatch = frames ? Math.max(0, ...[...frames.values()].map((f) => f.mismatchM)) : 0
  const colorOf = (m) => combinedColor(graphMaps, m)

  const drawCombined = (ctx, toScreen) => {
    drawMapsOnto(ctx, toScreen, frames, combinedBase, images, byName, colorOf)
    drawGraphLayer(ctx, toScreen, { points: combinedPins, links: combinedLinks, selectedKey: null, pending: null, plan: null, accent })
  }

  const [sliding, setSliding] = useState(false)
  const slideTimer = useRef(null)
  useEffect(() => () => clearTimeout(slideTimer.current), [])
  const toggleSidebar = useCallback(() => {
    clearTimeout(slideTimer.current)
    setSliding(true)
    setSidebarOpen((o) => !o)
    slideTimer.current = setTimeout(() => setSliding(false), SLIDE_MS + 50)
  }, [])
  const resizeSidebar = useCallback((pct) => {
    const width = pageRef.current?.getBoundingClientRect().width
    if (width) setSidebarW(Math.round(width * (1 - pct)) - RAIL_W)
  }, [])

  // -- render --------------------------------------------------------------
  if (!entry && openId && storeStatus === 'loading') {
    return (
      <div className="panel flex flex-col" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="panel-header"><span>PATH EDITOR</span></div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
          Opening the route…
        </div>
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="panel flex flex-col" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div className="panel-header"><span>PATH EDITOR</span></div>
        <StartScreen
          graphs={graphs}
          maps={maps}
          storeStatus={storeStatus}
          lastId={lastId}
          onCreate={createGraph}
          onOpen={openGraph}
        />
      </div>
    )
  }

  const store = STORE_STATUS[storeStatus]
  const cols = Math.ceil(Math.sqrt(shownMaps.length || 1))
  const rows = Math.ceil((shownMaps.length || 1) / cols)
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-bright').trim() || '#7C3AED'
  const popPin = selected && selected.source !== 'mapping' && !linkMode ? selected : null
  const renamingPin = renaming ? pins.find((p) => p.id === renaming.id) : null

  // How the selected switch's two maps are turned, for its card: from the pins when two linked
  // pairs allow it, else from the ↻ angles.
  const toDeg = (r) => Math.round(((((r * 180) / Math.PI) + 540) % 360) - 180)
  const turnInfoFor = (pin) => {
    const o = partners.get(pin.id)
    if (!o) return null
    const walls = savedFrame(alignments, pin.map, o.map)
    const score = alignments[`${pin.map}|${o.map}`]?.score ?? alignments[`${o.map}|${pin.map}`]?.score
    if (walls) {
      return { from: pin.map, to: o.map, fromWalls: true, score, fromPins: true, pairs: 1,
        turnDeg: toDeg(walls.turn), mismatchM: 0,
        linedUp: Math.abs(toDeg(walls.turn - mapTurner([], rotations)(pin.map, o.map))) <= 1 }
    }
    const t = pinTurn(pins, pin.map, o.map)
    return {
      from: pin.map,
      to: o.map,
      fromPins: Boolean(t),
      pairs: t?.pairs ?? 1,
      turnDeg: toDeg(t ? t.turn : mapTurner(pins, rotations, alignments)(pin.map, o.map)),
      mismatchM: t?.mismatchM ?? 0,
      // Already lined up when the ↻ angles agree with the pins to within a degree.
      linedUp: t ? Math.abs(toDeg(t.turn - mapTurner([], rotations)(pin.map, o.map))) <= 1 : true,
    }
  }
  // Turns map `to` so it looks the same way round as map `from`, by the turn from the pins.
  const lineUpWith = (info) => {
    setRotation(info.to, Math.round(((((rotations[info.from] ?? 0) + info.turnDeg) + 540) % 360) - 180))
  }

  // Cards and labels belong to one map, so each tile draws its own over its canvas.
  const tileOverlays = (m) => {
    const bounds = sizes[m] ?? { width: 0, height: 0 }
    const link = selectedLink ? (linksByMap.get(m) ?? NONE).find((x) => x.key === selectedLink) : null
    const la = link && named.find((p) => p.id === link.a)
    const lb = link && named.find((p) => p.id === link.b)
    return (
      <>
        {cardPoint?.map === m && (
          <C2PoiHoverCard
            point={cardPoint}
            at={toScreenOn(m, cardPoint)}
            mapName={m}
            bounds={bounds}
          />
        )}

        {la && lb && (() => {
          const sa = toScreenOn(m, la)
          const sb = toScreenOn(m, lb)
          return (
            <div
              className="val-mono"
              style={{
                position: 'absolute', left: (sa.x + sb.x) / 2, top: (sa.y + sb.y) / 2 - 14,
                transform: 'translate(-50%, -100%)', zIndex: 5, display: 'flex', alignItems: 'center',
                gap: 8, padding: '4px 8px', borderRadius: 4, fontSize: 11, whiteSpace: 'nowrap',
                border: '1px solid var(--accent-bright)', background: 'var(--panel-bg)', color: 'var(--text-h)',
              }}
            >
              <span>
                {la.name} ↔ {lb.name} · {link.len.toFixed(1)} m
                {link.crossesWall && <span style={{ color: '#D97706' }}> · crosses a wall</span>}
              </span>
              <button
                className="btn-icon"
                style={{ fontSize: 11, padding: '2px 8px', borderColor: '#DC2626', color: '#DC2626' }}
                onClick={() => { setLinks((prev) => prev.filter((k) => k !== link.key)); setSelectedLink(null) }}
              >
                ✕ Remove link
              </button>
            </div>
          )
        })()}

        {renamingPin?.map === m && (() => {
          const at = toScreenOn(m, renamingPin)
          return (
            <input
              autoFocus
              value={renaming.draft}
              placeholder={defaultName(renamingPin, pins)}
              onChange={(e) => setRenaming((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
              }}
              className="val-mono"
              style={{
                position: 'absolute', left: at.x, top: at.y - 22, transform: 'translate(-50%, -100%)',
                width: 150, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--accent-bright)',
                background: 'var(--panel-bg)', color: 'var(--text-h)', fontSize: 12, textAlign: 'center',
                outline: 'none', zIndex: 7,
              }}
            />
          )
        })()}
      </>
    )
  }

  return (
    <div ref={pageRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
      <C2PoiViewer point={viewerPoint} mapName={viewerPoint?.map} onClose={() => setViewerId(null)} />
      <WarningModal
        open={Boolean(askRemove)}
        heading="REMOVE MAP"
        title={askRemove ? `Remove ${askRemove.name} from ${entry.name}` : ''}
        body={askRemove ? `Its ${askRemove.count} point${askRemove.count === 1 ? '' : 's'} and their links go too. This cannot be undone.` : ''}
        onConfirm={() => removeMap(askRemove.name)}
        onCancel={() => setAskRemove(null)}
      />

      <div className="panel flex flex-col" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <div className="panel-header" style={{ gap: 10 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button
              className="btn-icon"
              style={{ fontSize: 11, padding: '2px 10px', textTransform: 'none', letterSpacing: 0 }}
              onClick={closeGraph}
              title="Back to the route list (New route / Continue editing). Everything is already saved."
            >
              ⌂ All routes
            </button>
            <span>PATH EDITOR</span>
            <span className="val-mono" style={{ color: 'var(--text-h)', fontSize: 12 }}>{entry.name}</span>
            {store && <span className="val-mono" style={{ fontSize: 10, color: store.color }}>{store.text}</span>}
          </span>
        </div>

        {/* Map bar: every map of the graph, the grid, and adding maps. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', position: 'relative' }}>
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '4px 10px', ...(!focusMap && !combinedBase && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }) }}
            onClick={() => { setCombinedOn(null); setFocusMap(null); clearTools() }}
            disabled={graphMaps.length < 2}
            title="Show every map of the route side by side"
          >
            ▦ All maps ({graphMaps.length})
          </button>
          {graphMaps.map((m) => {
            const n = ownPins.filter((p) => p.map === m).length
            return (
              <span key={m} style={{ display: 'inline-flex' }}>
                <button
                  className="btn-icon val-mono"
                  style={{
                    fontSize: 11, padding: '4px 8px', borderTopRightRadius: 0, borderBottomRightRadius: 0,
                    ...(focusMap === m && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)', background: 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' }),
                  }}
                  onClick={() => expand(m)}
                  title={`Expand ${m}`}
                >
                  {m} · {n}
                </button>
                <button
                  className="btn-icon"
                  style={{ fontSize: 11, padding: '4px 6px', borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 'none' }}
                  onClick={() => requestRemoveMap(m)}
                  title={`Remove ${m} from this route`}
                  aria-label={`Remove ${m}`}
                >
                  ✕
                </button>
              </span>
            )
          })}
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '4px 10px', ...(addingMaps && { borderColor: 'var(--accent-bright)' }) }}
            onClick={() => setAddingMaps((a) => (a ? null : []))}
          >
            ＋ Add map
          </button>
          {graphMaps.length > 1 && (
            <button
              className="btn-icon"
              style={{ fontSize: 11, padding: '4px 10px', ...(combinedBase && { borderColor: 'var(--accent-bright)', color: 'var(--text-h)', background: 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' }) }}
              onClick={() => { clearTools(); setCombinedOn(combinedBase ? null : (focusMap ?? graphMaps[0])) }}
              title="Lay the maps on top of each other, joined by their Map Switch pairs, to check they line up"
            >
              ⧉ Combined
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            className="btn-icon"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={() => setShowNames((v) => !v)}
            aria-pressed={!showNames}
          >
            {showNames ? '◉ Hide names' : '○ Show names'}
          </button>

          {addingMaps && (
            <div
              className="panel"
              style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 8, zIndex: 20, width: 360, maxHeight: 420,
                display: 'flex', flexDirection: 'column', boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
              }}
            >
              <div className="panel-header">
                <span>ADD MAPS TO {entry.name}</span>
                <button className="btn-icon" style={{ fontSize: 11, padding: '0 8px' }} onClick={refresh} title="Re-read the robot's map store">⟳</button>
              </div>
              <div style={{ padding: 10, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <MapChecklist
                  maps={maps}
                  chosen={addingMaps}
                  exclude={graphMaps}
                  onToggle={(n) => setAddingMaps((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n]))}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-icon" style={{ flex: 1, fontSize: 11, padding: '6px 10px' }} onClick={() => setAddingMaps(null)}>Cancel</button>
                  <button
                    className="btn-icon"
                    style={{ flex: 2, fontSize: 11, padding: '6px 10px', borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }}
                    disabled={!addingMaps.length}
                    onClick={() => addMaps(addingMaps)}
                  >
                    Add {addingMaps.length || ''} map{addingMaps.length === 1 ? '' : 's'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {mapError && <div style={{ padding: '4px 10px', fontSize: 11, color: '#F87171' }}>{mapError}</div>}

        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          {graphMaps.length === 0 ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
              This route has no maps. Press ＋ Add map above.
            </div>
          ) : (
            <div
              ref={gridRef}
              style={{
                position: 'absolute', inset: 0, display: 'grid', gap: 6, padding: focusMap || combinedBase ? 0 : 6,
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
              }}
            >
              {shownMaps.map((m) => {
                const info = byName.get(m)
                const mapPins = named.filter((p) => p.map === m)
                  .map((p) => (p.type === 'map_switch' && !partners.has(p.id) ? { ...p, unpaired: true } : p))
                const mapLinks = linksByMap.get(m) ?? NONE
                const from = linkMode && linkStart ? named.find((p) => p.id === linkStart && p.map === m) : null
                const drawUnder = (ctx, toScreen) => drawGraphLayer(ctx, toScreen, {
                  points: mapPins,
                  links: mapLinks,
                  selectedKey: selectedLink,
                  pending: from && hover?.map === m ? { from, to: hover } : null,
                  plan: null,
                  accent,
                })
                return (
                  <div
                    key={m}
                    className={focusMap || combinedBase ? undefined : 'panel'}
                    style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}
                  >
                    {!focusMap && !combinedBase && (
                      <div
                        className="panel-header"
                        onClick={() => expand(m)}
                        style={{ cursor: 'pointer' }}
                        title={`Expand ${m} to edit it`}
                      >
                        <span className="val-mono" style={{ textTransform: 'none' }}>{m}</span>
                        <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <RotateControl deg={rotations[m] ?? 0} onChange={(d) => setRotation(m, d)} />
                          {ownPins.filter((p) => p.map === m).length} pts · ⤢ expand
                        </span>
                      </div>
                    )}
                    <div
                      ref={(el) => { if (el) bodyRefs.current.set(m, el); else bodyRefs.current.delete(m) }}
                      style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
                    >
                      {info ? (
                        <C2MapCanvas
                          info={info}
                          image={images.get(m) ?? null}
                          pins={combinedBase ? combinedPins : mapPins}
                          selectedId={selectedId}
                          placingType={editable && !combinedBase ? placingType : null}
                          editable={editable && !combinedBase}
                          view={views[m] ?? BLANK_VIEW}
                          robot={null}
                          onViewChange={viewSetter(m)}
                          onPlace={(type, world) => addPin(m, type, world)}
                          onSelect={combinedBase ? setSelectedId : selectPoint}
                          onMovePin={movePin}
                          onSetYaw={setYaw}
                          onRename={editable ? beginRename : undefined}
                          onHover={(w) => setHover(w ? { ...w, map: m } : null)}
                          onSizeChange={sizeSetter(m)}
                          drawUnder={combinedBase ? drawCombined : drawUnder}
                          onEmptyClick={(pt) => handleEmptyClick(m, pt)}
                          showNames={showNames}
                        />
                      ) : (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center', padding: 16 }}>
                          {maps === null ? 'Reading the map store…' : `${m} is not in the robot's map store.`}
                        </div>
                      )}
                      {info && !combinedBase && tileOverlays(m)}
                      {info && !images.get(m) && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12, pointerEvents: 'none' }}>
                          Loading {m}…
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {pairLines.length > 0 && (
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 3 }}>
              {pairLines.map((l) => (
                <g key={l.key}>
                  <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={SWITCH_LINE} strokeWidth="2" strokeDasharray="6 5" opacity="0.85" />
                  <circle cx={l.x1} cy={l.y1} r="4" fill={SWITCH_LINE} />
                  <circle cx={l.x2} cy={l.y2} r="4" fill={SWITCH_LINE} />
                </g>
              ))}
            </svg>
          )}

          {adjustHandlers && (
            <div
              {...adjustHandlers}
              style={{ position: 'absolute', inset: 0, zIndex: 3, cursor: 'move', touchAction: 'none' }}
              title="Drag to move · Shift+drag to turn · wheel to zoom"
            />
          )}
          {combinedBase && byName.get(combinedBase) && (
            <>
              <div
                className="panel"
                style={{
                  position: 'absolute', top: 10, left: 10, zIndex: 6, padding: '8px 10px', maxWidth: 'min(420px, calc(100% - 20px))',
                  display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="val-mono" style={{ color: 'var(--text-h)' }}>⧉ REFERENCE</span>
                  <select
                    value={combinedBase}
                    onChange={(e) => setCombinedOn(e.target.value)}
                    className="val-mono"
                    style={{ fontSize: 11, background: 'var(--bg)', color: 'var(--text-h)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 4px', minWidth: 0 }}
                  >
                    {graphMaps.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <RotateControl deg={rotations[combinedBase] ?? 0} onChange={(d) => setRotation(combinedBase, d)} />
                </div>
                <div className="val-mono" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {graphMaps.filter((m) => frames?.has(m)).map((m) => (
                    <span key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, wordBreak: 'break-all' }}>
                      <span style={{ width: 14, height: 3, flexShrink: 0, background: m === combinedBase ? 'var(--text-h)' : colorOf(m) }} />
                      <span style={{ minWidth: 0 }}>
                        {m}{m === combinedBase ? ' (base, black walls)' : ''}
                        {m !== combinedBase && (() => {
                          const src = frames.get(m)?.source
                          const res = aligning?.results?.[m]
                          if (aligning?.running) return <span style={{ color: '#60A5FA' }}> · matching walls…</span>
                          if (res?.error) return <span style={{ color: '#FBBF24' }}> · couldn't match: {res.error}</span>
                          if (res?.weak) return <span style={{ color: '#FBBF24' }}> · weak match ({Math.round(res.score * 100)}%), not used</span>
                          if (adjust?.map === m) return <span style={{ color: '#60A5FA' }}> · placing by hand</span>
                          if (src === 'walls') {
                            const saved = alignments[`${m}|${frames.get(m).parent}`] ?? alignments[`${frames.get(m).parent}|${m}`]
                            const pct = saved?.score != null ? ` ${Math.round(saved.score * 100)}%` : ''
                            return saved?.hand
                              ? <span style={{ color: '#4ADE80' }}> · ✋ placed by hand{pct}</span>
                              : <span style={{ color: '#4ADE80' }}> · ✓ walls matched{pct}</span>
                          }
                          return <span style={{ color: 'var(--text-dim)' }}> · rough, from the switch pins</span>
                        })()}
                      </span>
                      {m !== combinedBase && !adjust && !aligning?.running && (
                        <button
                          className="btn-icon"
                          style={{ fontSize: 10, padding: '1px 8px', marginLeft: 'auto', flexShrink: 0 }}
                          onClick={() => startAdjust(m)}
                          title="Move and turn this map by hand until the walls sit on top of each other"
                        >
                          ✋ Adjust
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                <span style={{ color: 'var(--text-dim)', lineHeight: 1.4 }}>
                  C2 lines the maps up by matching their walls. Walls should sit on top of each other.
                </span>

                {adjust && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 4, border: '1px solid #60A5FA' }}>
                    <span style={{ color: 'var(--text-h)', lineHeight: 1.4 }}>
                      ✋ Placing <b>{adjust.map}</b>: use the sliders, or drag the map (Shift+drag turns it).
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ display: 'grid', gridTemplateColumns: '78px 1fr 52px', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--text-dim)' }}>Turn</span>
                        <input
                          type="range" min={-20} max={20} step={0.1} value={adjust.turnDeg}
                          onChange={(e) => { const v = Number(e.target.value); setAdjust((a) => a && withSliders(a, { turnDeg: v })) }}
                        />
                        <span className="val-mono" style={{ textAlign: 'right', color: 'var(--text-h)' }}>{(adjust.turnDeg > 0 ? '+' : '') + adjust.turnDeg.toFixed(1)}°</span>
                      </label>
                      <label style={{ display: 'grid', gridTemplateColumns: '78px 1fr 52px', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--text-dim)' }}>Left ↔ Right</span>
                        <input
                          type="range" min={-3} max={3} step={0.01} value={adjust.right}
                          onChange={(e) => { const v = Number(e.target.value); setAdjust((a) => a && withSliders(a, { right: v })) }}
                        />
                        <span className="val-mono" style={{ textAlign: 'right', color: 'var(--text-h)' }}>{(adjust.right > 0 ? '+' : '') + adjust.right.toFixed(2)} m</span>
                      </label>
                      <label style={{ display: 'grid', gridTemplateColumns: '78px 1fr 52px', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--text-dim)' }}>Down ↕ Up</span>
                        <input
                          type="range" min={-3} max={3} step={0.01} value={adjust.up}
                          onChange={(e) => { const v = Number(e.target.value); setAdjust((a) => a && withSliders(a, { up: v })) }}
                        />
                        <span className="val-mono" style={{ textAlign: 'right', color: 'var(--text-h)' }}>{(adjust.up > 0 ? '+' : '') + adjust.up.toFixed(2)} m</span>
                      </label>
                    </div>
                    <button
                      className="btn-icon"
                      style={{ fontSize: 11, padding: '2px 8px', alignSelf: 'flex-start' }}
                      onClick={() => setAdjust((a) => a && { ...a, rel: a.start, base: a.start, ...SLIDERS_ZERO, score: null, matched: false })}
                      title="Back to where it was when you pressed Adjust"
                    >
                      ↺ Reset
                    </button>
                    {adjust.score != null && (
                      <span style={{ color: adjust.score >= 0.25 ? '#4ADE80' : '#FBBF24' }}>
                        {adjust.score > 0 ? `Walls matching: ${Math.round(adjust.score * 100)}%` : "Couldn't match from here."}
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn-icon" style={{ fontSize: 11, padding: '4px 10px' }} onClick={matchFromHere} title="Let C2 fine-tune from where you have put it">
                        ⟳ Match walls from here
                      </button>
                      <button className="btn-icon" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setAdjust(null)}>Cancel</button>
                      <button className="btn-icon" style={{ fontSize: 11, padding: '4px 10px', borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }} onClick={saveAdjust}>
                        Save
                      </button>
                    </div>
                  </div>
                )}
                {frames && frames.size > 1 && !adjust && !stitch && (
                  <button
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '4px 10px', alignSelf: 'flex-start' }}
                    disabled={aligning?.running}
                    onClick={openStitch}
                    title="Stitch the lined-up maps into one map and save it to the robot's map store"
                  >
                    💾 Save as one map
                  </button>
                )}
                {stitch && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 4, border: '1px solid var(--accent-bright)' }}>
                    <span style={{ color: 'var(--text-h)' }}>💾 Save the {frames?.size ?? 0} lined-up maps as one map</span>
                    <input
                      value={stitch.name}
                      onChange={(e) => setStitch((st) => ({ ...st, name: e.target.value.replace(/[^A-Za-z0-9_]/g, ''), phase: 'edit', message: '' }))}
                      className="val-mono"
                      placeholder="map_name"
                      style={{ fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-h)' }}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      Detail
                      <select
                        value={stitch.res}
                        onChange={(e) => setStitch((st) => ({ ...st, res: Number(e.target.value), phase: 'edit', message: '' }))}
                        style={{ fontSize: 11, background: 'var(--bg)', color: 'var(--text-h)', border: '1px solid var(--border)', borderRadius: 4 }}
                      >
                        {[...new Set([byName.get(combinedBase)?.resolution, 0.05, 0.1].filter(Boolean))].map((r) => (
                          <option key={r} value={r}>{(r * 100).toFixed(0)} cm per pixel{r === byName.get(combinedBase)?.resolution ? ' (same as the maps)' : r === 0.05 ? ' (Nav2 usual, lighter)' : ' (lightest)'}</option>
                        ))}
                      </select>
                    </label>
                    {stitchPreview && (
                      <span style={{ color: stitchPreview.width * stitchPreview.height > MAX_STITCH_PIXELS ? '#F87171' : 'var(--text-dim)' }}>
                        {stitchPreview.width}×{stitchPreview.height} px, about {Math.round(stitchPreview.width * stitch.res)} × {Math.round(stitchPreview.height * stitch.res)} m
                        {stitchPreview.width * stitchPreview.height > MAX_STITCH_PIXELS && ' — too big at this detail, pick a lighter one'}
                      </span>
                    )}
                    {notJoined.length > 0 && <span style={{ color: '#FBBF24' }}>Left out (not lined up): {notJoined.join(', ')}</span>}
                    {stitchTaken && stitch.phase !== 'done' && <span style={{ color: '#FBBF24' }}>A map named {stitch.name} exists: saving replaces it.</span>}
                    {stitch.message && (
                      <span style={{ color: stitch.phase === 'done' ? '#4ADE80' : stitch.phase === 'saving' ? '#60A5FA' : '#F87171' }}>{stitch.message}</span>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-icon" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setStitch(null)}>
                        {stitch.phase === 'done' ? 'Close' : 'Cancel'}
                      </button>
                      {stitch.phase !== 'done' && (
                        <button
                          className="btn-icon"
                          style={{ fontSize: 11, padding: '4px 10px', borderColor: 'var(--accent-bright)', color: 'var(--text-h)' }}
                          disabled={!stitch.name || stitch.phase === 'saving' || !stitchPreview || stitchPreview.width * stitchPreview.height > MAX_STITCH_PIXELS}
                          onClick={saveStitch}
                        >
                          {stitch.phase === 'saving' ? 'Saving…' : stitchTaken ? `Replace ${stitch.name}` : 'Save'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {frames && frames.size > 1 && !adjust && (
                  <button
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '4px 10px', alignSelf: 'flex-start' }}
                    disabled={aligning?.running}
                    onClick={lineUpByWalls}
                    title="Match the walls again, e.g. after moving a Map Switch"
                  >
                    {aligning?.running ? 'Matching walls…' : '⟳ Match walls again'}
                  </button>
                )}
                {combinedMismatch > 0.2 && [...(frames?.values() ?? [])].some((f) => f.source === 'pins') && (
                  <span style={{ color: '#FBBF24' }}>
                    ⚠ Switches disagree by up to {combinedMismatch.toFixed(2)} m.
                  </span>
                )}
                {notJoined.length > 0 && (
                  <span style={{ color: '#FBBF24', wordBreak: 'break-all' }}>
                    Not joined yet: {notJoined.join(', ')}. Link a Map Switch pair to it, at a spot both maps share, to show it here.
                  </span>
                )}
              </div>
              <div style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 4 }}>
                <ZoomControls
                  zoom={(views[combinedBase] ?? BLANK_VIEW).scale}
                  onZoomIn={() => viewSetter(combinedBase)((v) => zoomAbout(v, sizes[combinedBase], ZOOM_STEP))}
                  onZoomOut={() => viewSetter(combinedBase)((v) => zoomAbout(v, sizes[combinedBase], 1 / ZOOM_STEP))}
                  onFit={() => viewSetter(combinedBase)(fitView(byName.get(combinedBase), sizes[combinedBase] ?? { width: 0, height: 0 }, 0.94, degToRad(rotations[combinedBase])))}
                />
              </div>
            </>
          )}

          {focusMap && byName.get(focusMap) && (
            <>
              <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="val-mono" style={{ padding: '4px 8px', borderRadius: 4, fontSize: 11, background: 'var(--panel-bg)', border: '1px solid var(--border)', color: 'var(--text-h)' }}>
                  {focusMap}
                </span>
                <RotateControl deg={rotations[focusMap] ?? 0} onChange={(d) => setRotation(focusMap, d)} />
              </div>
              <div style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 4 }}>
                <ZoomControls
                  zoom={(views[focusMap] ?? BLANK_VIEW).scale}
                  onZoomIn={() => viewSetter(focusMap)((v) => zoomAbout(v, sizes[focusMap], ZOOM_STEP))}
                  onZoomOut={() => viewSetter(focusMap)((v) => zoomAbout(v, sizes[focusMap], 1 / ZOOM_STEP))}
                  onFit={() => viewSetter(focusMap)(fitView(byName.get(focusMap), sizes[focusMap] ?? { width: 0, height: 0 }, 0.94, degToRad(rotations[focusMap])))}
                />
              </div>
              <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'flex-end', gap: 16, pointerEvents: 'none', zIndex: 4 }}>
                <CoordReadout world={hover?.map === focusMap ? hover : null} />
                <ScaleBar scale={(views[focusMap] ?? BLANK_VIEW).scale} resolution={byName.get(focusMap).resolution} />
              </div>
            </>
          )}
        </div>
      </div>

      {sidebarOpen && (
        <ResizeHandle direction="h" containerRef={pageRef} onResize={resizeSidebar} min={0.4} max={0.85} />
      )}
      <Rail open={sidebarOpen} onToggle={toggleSidebar} />
      <div
        id="path-editor-sidebar"
        inert={!sidebarOpen}
        className={sliding ? 'npt-slide-width' : undefined}
        style={{ width: sidebarOpen ? sidebarW : 0, flexShrink: 0, display: 'flex', overflow: 'hidden' }}
      >
        <div style={{ width: sidebarW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <C2PointsWidget
            pins={ownPins}
            mapPoints={mapPoints}
            maps={graphMaps}
            focusMap={focusMap}
            selectedId={selectedId}
            placingType={placingType}
            editable={editable}
            canUndo={history.past > 0}
            canRedo={history.future > 0}
            onUndo={undo}
            onRedo={redo}
            onArm={(t) => { setPlacingType(t); if (t) { setLinkMode(false); setLinkStart(null) } }}
            linkMode={linkMode}
            linkStartName={linkStart ? named.find((p) => p.id === linkStart)?.name : null}
            linkCount={links.length}
            onToggleLinkMode={() => { setLinkMode((on) => !on); setLinkStart(null); setPlacingType(null) }}
            onSelect={selectFromList}
            onRemove={removePin}
            onChange={updatePin}
            storeStatus={storeStatus}
            switchPartners={partners}
            hiddenCount={hidden.length}
            onRestoreHidden={restoreMapPois}
            selectedPhotos={selected ? named.find((p) => p.id === selected.id)?.poi ?? null : null}
            selectedExtra={popPin && (
              <C2PinPopover
                inline
                anchor={{ x: 0, y: 0 }}
                bounds={{ width: 0, height: 0 }}
                mapName={popPin.map}
                pin={popPin}
                name={displayName(popPin, pins)}
                step={routeOrder(ownPins).findIndex((p) => p.id === popPin.id) + 1}
                editable={editable}
                homeTaken={ownPins.some((p) => p.type === 'home')}
                partner={partners.get(popPin.id) ?? null}
                turnInfo={turnInfoFor(popPin)}
                onLineUp={lineUpWith}
                candidates={candidates}
                onType={(t) => setPinType(popPin.id, t)}
                onLink={(c) => pairSwitch(popPin.id, c.id)}
                onUnlink={() => unpairSwitch(popPin.id)}
                onDelete={() => removePin(popPin.id)}
                onClose={() => setSelectedId(null)}
              />
            )}
          />
        </div>
      </div>
    </div>
  )
}

function zoomAbout(v, size, factor) {
  const width = size?.width ?? 0
  const height = size?.height ?? 0
  const next = Math.min(40, Math.max(0.05, v.scale * factor))
  if (next === v.scale) return v
  return {
    ...v,
    scale: next,
    x: width / 2 - ((width / 2 - v.x) / v.scale) * next,
    y: height / 2 - ((height / 2 - v.y) / v.scale) * next,
  }
}
