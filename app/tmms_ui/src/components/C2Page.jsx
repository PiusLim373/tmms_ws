import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTopicActivity } from '../hooks/useTopicActivity'
import { ResizeHandle } from './ui/ResizeHandle'
import {
  ZoomControls, ViewToggle, ScaleBar, CoordReadout,
} from './ui/C2MapControls'
import { C2MapCanvas } from './widgets/C2MapCanvas'
import { C2LoadMapWidget } from './widgets/C2LoadMapWidget'
import { C2RobotStatusWidget } from './widgets/C2RobotStatusWidget'
import { C2PointsWidget } from './widgets/C2PointsWidget'
import { fitView, normaliseMapEntry, quaternionToYaw, worldToPixel } from './../lib/c2Coords'
import { defaultName, makePin, reindexOrder, routeOrder } from './../lib/c2Pins'
import { loadUploadedMap } from './../lib/c2MapFile'

const MIN_SPAN = 0.12
const ZOOM_STEP = 1.4
const STATUS_TOPIC = '/quadruped_main_status'
const STATUS_TYPE = 'tmms_msgs/QuadrupedMainStatus'

export function C2Page() {

  const [storeMaps, setStoreMaps] = useState(null)
  const [uploaded, setUploaded] = useState([])
  const [mapName, setMapName] = useState(null)
  const [mapError, setMapError] = useState(null)
  const [images, setImages] = useState(() => new Map())

  const refreshMaps = useCallback(() => {
    setMapError(null)
    fetch('/api/maps2d')
      .then((r) => r.json())
      .then((list) => setStoreMaps(
        list.map(normaliseMapEntry).filter(Boolean).map((m) => ({ ...m, source: 'store' }))))
      .catch((err) => {
        console.warn('[C2] /api/maps2d unavailable:', err.message)
        setStoreMaps([])
      })
  }, [])

  useEffect(refreshMaps, [refreshMaps])

  const maps = useMemo(
    () => [...uploaded, ...(storeMaps ?? [])],
    [uploaded, storeMaps],
  )
  const selectedMap = maps.find((m) => m.name === mapName) ?? null
  const image = selectedMap ? images.get(selectedMap.name) ?? null : null

  useEffect(() => {
    if (!selectedMap || selectedMap.source !== 'store' || images.has(selectedMap.name)) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setImages((prev) => new Map(prev).set(selectedMap.name, img))
    }
    img.onerror = () => {
      if (!cancelled) setMapError(`Could not load ${selectedMap.name}.png from the map store.`)
    }
    img.src = `/api/maps2d/${encodeURIComponent(selectedMap.name)}/image`
    return () => { cancelled = true }
  }, [selectedMap, images])

  const fileRef = useRef(null)
  const requestUpload = useCallback(() => fileRef.current?.click(), [])

  const handleUpload = useCallback(async (files) => {
    if (files.length === 0) return
    setMapError(null)
    try {
      const loaded = await loadUploadedMap(files)
      setImages((prev) => new Map(prev).set(loaded.name, loaded.image))
      setUploaded((prev) => [
        { name: loaded.name, source: 'upload', pngBytes: loaded.bytes, ...loaded.info },
        ...prev.filter((m) => m.name !== loaded.name),
      ])
      setMapName(loaded.name)
    } catch (err) {
      setMapError(err.message)
    }
  }, [])

  const { active: statusLive, lastMsg: status } = useTopicActivity(STATUS_TOPIC, STATUS_TYPE, 1500)

  const robot = useMemo(() => {
    if (!status) return null
    const p = status.pose?.position
    return {
      position: p ? { x: p.x, y: p.y } : null,
      yaw: quaternionToYaw(status.pose?.orientation),
      battery: status.battery_percentage,
      mode: status.robot_mode,
      navState: status.navigation_state,
      localization: status.localization_status,
      paused: status.is_paused,
      currentMap: status.current_map,
    }
  }, [status])

  const robotMap = statusLive ? robot?.currentMap || null : null
  const robotOnThisMap = Boolean(robotMap && mapName && robotMap === mapName)

  const [graphs, setGraphs] = useState([])
  const [graph, setGraph] = useState(null)
  const [editing, setEditing] = useState(false)
  const [graphPanel, setGraphPanel] = useState(null)

  const [pins, setPins] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [placingType, setPlacingType] = useState(null)
  const [renaming, setRenaming] = useState(null)

  const pinsRef = useRef(pins)
  const historyRef = useRef({ past: [], future: [], key: null, at: 0 })
  const [history, setHistory] = useState({ past: 0, future: 0 })

  const HISTORY_LIMIT = 200
  const COALESCE_MS = 700

  const applyPins = useCallback((next, { selection } = {}) => {
    pinsRef.current = next
    setPins(next)
    if (selection !== undefined) setSelectedId(selection)
  }, [])

  const mutate = useCallback((key, updater) => {
    const prev = pinsRef.current
    const next = updater(prev)
    if (next === prev) return

    const h = historyRef.current
    const now = performance.now()
    const sameRun = key !== null && h.key === key && now - h.at < COALESCE_MS
    if (!sameRun) {
      h.past.push(prev)
      if (h.past.length > HISTORY_LIMIT) h.past.shift()
      h.future = []
      setHistory({ past: h.past.length, future: 0 })
    }
    h.key = key
    h.at = now
    applyPins(next)
  }, [applyPins])

  const resetHistory = useCallback((next) => {
    historyRef.current = { past: [], future: [], key: null, at: 0 }
    setHistory({ past: 0, future: 0 })
    pinsRef.current = next
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (h.past.length === 0) return
    h.future.push(pinsRef.current)
    const restored = h.past.pop()
    h.key = null
    setHistory({ past: h.past.length, future: h.future.length })
    const stillThere = restored.some((pin) => pin.id === selectedId)
    applyPins(restored, { selection: stillThere ? selectedId : null })
  }, [applyPins, selectedId])

  const redo = useCallback(() => {
    const h = historyRef.current
    if (h.future.length === 0) return
    h.past.push(pinsRef.current)
    const restored = h.future.pop()
    h.key = null
    setHistory({ past: h.past.length, future: h.future.length })
    const stillThere = restored.some((pin) => pin.id === selectedId)
    applyPins(restored, { selection: stillThere ? selectedId : null })
  }, [applyPins, selectedId])

  useEffect(() => {
    if (!graph) return
    setGraphs((prev) => prev.map((g) => (
      g.id === graph.id ? { ...g, pins, updatedAt: new Date().toISOString() } : g
    )))
  }, [pins, graph])

  const closeGraph = useCallback(() => {
    setRenaming(null)
    setGraph(null)
    setEditing(false)
    setPins([])
    resetHistory([])
    setSelectedId(null)
    setPlacingType(null)
  }, [resetHistory])

  const selectMap = useCallback((name) => {
    setMapName(name)
    setMapError(null)
    closeGraph()
  }, [closeGraph])

  const createGraph = useCallback((name) => {
    const entry = {
      id: `g_${Date.now().toString(36)}`,
      name,
      map: mapName,
      pins: [],
      updatedAt: new Date().toISOString(),
    }
    setGraphs((prev) => [...prev, entry])
    setGraph({ id: entry.id, name: entry.name })
    setPins([])
    resetHistory([])
    setSelectedId(null)
    setEditing(true)
    setGraphPanel(null)
  }, [mapName, resetHistory])

  const loadGraph = useCallback((id) => {
    const found = graphs.find((g) => g.id === id)
    if (!found) return
    setGraph({ id: found.id, name: found.name })
    setPins(found.pins)
    resetHistory(found.pins)
    setSelectedId(null)
    setEditing(false)
    setGraphPanel(null)
  }, [graphs, resetHistory])

  const addPin = useCallback((type, world) => {
    let placedId = null
    mutate(null, (prev) => {
      if (type === 'home') {
        const existing = prev.find((p) => p.type === 'home')
        if (existing) {
          placedId = existing.id
          return prev.map((p) => (p.id === existing.id ? { ...p, x: world.x, y: world.y } : p))
        }
      }
      const pin = makePin(type, world, prev)
      placedId = pin.id
      return [...prev, pin]
    })
    if (placedId) setSelectedId(placedId)

    if (type === 'home') setPlacingType(null)
  }, [mutate])

  const movePin = useCallback((id, world) => {
    mutate(`move:${id}`, (prev) => prev.map((p) => (
      p.id === id ? { ...p, x: world.x, y: world.y } : p
    )))
  }, [mutate])

  const updatePin = useCallback((id, patch) => {
    mutate(`edit:${id}:${Object.keys(patch).join(',')}`, (prev) => prev.map((p) => (
      p.id === id ? { ...p, ...patch } : p
    )))
  }, [mutate])

  const setYaw = useCallback((id, yaw) => {
    mutate(`yaw:${id}`, (prev) => prev.map((p) => (
      p.id === id ? { ...p, yaw: yaw ?? 0, headingSet: yaw != null } : p
    )))
  }, [mutate])

  const removePin = useCallback((id) => {
    mutate(null, (prev) => reindexOrder(prev.filter((p) => p.id !== id)))
    setSelectedId((cur) => (cur === id ? null : cur))
    setRenaming((cur) => (cur?.id === id ? null : cur))
  }, [mutate])

  const beginRename = useCallback((id) => {
    const pin = pinsRef.current.find((p) => p.id === id)
    if (!pin) return
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

  const reorderPin = useCallback((id, toIndex) => {
    mutate(null, (prev) => {
      const ordered = routeOrder(prev)
      const from = ordered.findIndex((p) => p.id === id)
      if (from === -1 || from === toIndex) return prev
      const next = ordered.slice()
      const [moved] = next.splice(from, 1)
      next.splice(toIndex, 0, moved)
      return reindexOrder(next.map((p, i) => ({ ...p, order: i })))
    })
  }, [mutate])

  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [hover, setHover] = useState(null)
  const [viewMode, setViewMode] = useState('2D')
  const sizeRef = useRef({ width: 0, height: 0 })
  const fittedFor = useRef(null)

  const onSizeChange = useCallback((size) => {
    sizeRef.current = size
  }, [])

  const info = useMemo(() => (selectedMap
    ? {
      width: selectedMap.width,
      height: selectedMap.height,
      resolution: selectedMap.resolution,
      origin: selectedMap.origin,
    }
    : null), [selectedMap])

  useEffect(() => {
    if (!info || !image) return
    const key = `${mapName}:${info.width}x${info.height}`
    if (fittedFor.current === key || !sizeRef.current.width) return
    fittedFor.current = key
    setView(fitView(info, sizeRef.current))
  }, [info, mapName, image])

  const zoomBy = useCallback((factor) => {
    const { width, height } = sizeRef.current
    setView((v) => {
      const next = Math.min(40, Math.max(0.05, v.scale * factor))
      if (next === v.scale) return v
      return {
        scale: next,
        x: width / 2 - ((width / 2 - v.x) / v.scale) * next,
        y: height / 2 - ((height / 2 - v.y) / v.scale) * next,
      }
    })
  }, [])

  const fit = useCallback(() => {
    if (info) setView(fitView(info, sizeRef.current))
  }, [info])

  const canEdit = Boolean(graph) && editing

  const renamingPin = renaming ? pins.find((p) => p.id === renaming.id) : null
  const renamePos = renamingPin && info
    ? (() => {
      const g = worldToPixel(renamingPin.x, renamingPin.y, info)
      return { x: view.x + g.x * view.scale, y: view.y + g.y * view.scale - 22 }
    })()
    : null
  const renamePlaceholder = renamingPin ? defaultName(renamingPin, pins) : ''

  const isTyping = (target) => {
    if (!target) return false
    if (target.isContentEditable) return true
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  }

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e.target)) return

      if (e.key === 'Escape') {
        setPlacingType(null)
        setSelectedId(null)
        setRenaming(null)
        return
      }

      if (!canEdit) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      } else if (mod && key === 'z') {
        e.preventDefault()
        undo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        removePin(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, undo, redo, removePin, selectedId])

  const rightColRef = useRef(null)
  const [mapEnd, setMapEnd] = useState(0.21)
  const [pointsEnd, setPointsEnd] = useState(0.70)

  const graphsForMap = graphs.filter((g) => g.map === mapName)

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      <input
        ref={fileRef}
        type="file"
        accept=".png,.yaml,.yml"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleUpload(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />

      <div
        className="panel flex flex-col"
        style={{ width: '65%', flexShrink: 0, minWidth: 0, overflow: 'hidden', borderRight: '1px solid var(--border)' }}
      >
        <div className="panel-header">
          <span>C2 — SCENE MARKUP</span>
          <span className="val-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            {mapName ?? 'no map'}
            {graph ? ` · ${graph.name}${editing ? ' · editing' : ''}` : ''}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          <C2MapCanvas
            info={info}
            image={image}
            pins={pins}
            selectedId={selectedId}
            placingType={canEdit ? placingType : null}
            editable={canEdit}
            view={view}
            robot={robotOnThisMap ? robot : null}
            onViewChange={setView}
            onPlace={addPin}
            onSelect={setSelectedId}
            onMovePin={movePin}
            onSetYaw={setYaw}
            onRename={beginRename}
            onHover={setHover}
            onSizeChange={onSizeChange}
          />

          {robotMap && !robotOnThisMap && (
            <div
              className="val-mono"
              style={{
                position: 'absolute',
                top: 10,
                left: '50%',
                transform: 'translateX(-50%)',
                maxWidth: 'calc(100% - 20px)',
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid #FBBF24',
                background: 'var(--panel-bg)',
                color: '#FBBF24',
                fontSize: 11,
                textAlign: 'center',
                pointerEvents: 'none',
                zIndex: 4,
              }}
            >
              Robot is localized in {robotMap} — not shown on this map
            </div>
          )}

          {renaming && renamePos && (
            <input
              autoFocus
              value={renaming.draft}
              placeholder={renamePlaceholder}
              onChange={(e) => setRenaming((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
              }}
              className="val-mono"
              style={{
                position: 'absolute',
                left: renamePos.x,
                top: renamePos.y,
                transform: 'translate(-50%, -100%)',
                width: 150,
                padding: '4px 6px',
                borderRadius: 4,
                border: '1px solid var(--accent-bright)',
                background: 'var(--panel-bg)',
                color: 'var(--text-h)',
                fontSize: 12,
                textAlign: 'center',
                outline: 'none',
                zIndex: 5,
              }}
            />
          )}
          {!image && (
            <div
              style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 13, color: 'var(--text-dim)',
                textAlign: 'center', padding: 24, pointerEvents: 'none',
              }}
            >
              {selectedMap ? `Loading ${selectedMap.name}…` : 'No map loaded.'}
            </div>
          )}
          <div style={{ position: 'absolute', inset: 0, padding: 10, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', bottom: 10, left: 10 }}>
              <ViewToggle mode={viewMode} onChange={setViewMode} />
            </div>
            <div style={{ position: 'absolute', bottom: 10, right: 10 }}>
              <ZoomControls
                zoom={view.scale}
                onZoomIn={() => zoomBy(ZOOM_STEP)}
                onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
                onFit={fit}
              />
            </div>
            <div
              style={{
                position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
                display: 'flex', alignItems: 'flex-end', gap: 16,
              }}
            >
              <CoordReadout world={hover} />
              <ScaleBar scale={view.scale} resolution={info?.resolution} />
            </div>
          </div>
        </div>
      </div>
      <div
        ref={rightColRef}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ height: `${mapEnd * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
          <C2LoadMapWidget
            maps={maps}
            loading={storeMaps === null}
            selectedName={mapName}
            onSelect={selectMap}
            onRequestUpload={requestUpload}
            onRefresh={refreshMaps}
            error={mapError}
          />
        </div>
        <ResizeHandle
          direction="v"
          containerRef={rightColRef}
          onResize={(pct) => setMapEnd(Math.min(pct, pointsEnd - MIN_SPAN))}
          min={MIN_SPAN}
          max={0.8}
        />
        <div style={{ height: `${(pointsEnd - mapEnd) * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
          <C2PointsWidget
            pins={pins}
            selectedId={selectedId}
            placingType={placingType}
            editable={editing}
            mapName={mapName}
            canUndo={history.past > 0}
            canRedo={history.future > 0}
            onUndo={undo}
            onRedo={redo}
            graph={graph}
            graphs={graphsForMap}
            panelMode={graphPanel}
            onPanelMode={setGraphPanel}
            onCreateGraph={createGraph}
            onLoadGraph={loadGraph}
            onToggleEdit={() => setEditing((e) => !e)}
            onCloseGraph={closeGraph}
            onArm={setPlacingType}
            onSelect={setSelectedId}
            onRemove={removePin}
            onReorder={reorderPin}
            onChange={updatePin}
            onSetYaw={setYaw}
          />
        </div>
        <ResizeHandle
          direction="v"
          containerRef={rightColRef}
          onResize={(pct) => setPointsEnd(Math.max(pct, mapEnd + MIN_SPAN))}
          min={0.2}
          max={1 - MIN_SPAN}
        />
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <C2RobotStatusWidget robot={robot} live={statusLive} mapName={mapName} />
        </div>
      </div>
    </div>
  )
}
