import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { centreOn, fitView, normaliseMapEntry, rotateView, screenToPixel } from '../lib/c2Coords'
import { buildClearanceGrid } from '../lib/c2Graph'

// The robot's 2D map store, for the Path Editor and C2: the list, the images of the maps in
// `wanted` (fetched once each), and their clearance grids, built on first use and kept.
export function useC2Maps(wanted) {
  const [maps, setMaps] = useState(null)
  const [error, setError] = useState(null)
  const [images, setImages] = useState(() => new Map())
  const grids = useRef(new Map())

  const refresh = useCallback(() => {
    setError(null)
    fetch('/api/maps2d')
      .then((r) => r.json())
      .then((list) => setMaps(list.map(normaliseMapEntry).filter(Boolean)))
      .catch((err) => {
        console.warn('[C2] /api/maps2d unavailable:', err.message)
        setError('Could not read the map store.')
        setMaps([])
      })
  }, [])
  useEffect(refresh, [refresh])

  const byName = useMemo(() => new Map((maps ?? []).map((m) => [m.name, m])), [maps])

  const wantedKey = wanted.join('|')
  useEffect(() => {
    const names = wantedKey ? wantedKey.split('|') : []
    const loading = []
    for (const name of names) {
      if (!byName.has(name) || images.has(name)) continue
      const img = new Image()
      img.onload = () => setImages((prev) => new Map(prev).set(name, img))
      img.onerror = () => setError(`Could not load ${name}.png from the map store.`)
      img.src = `/api/maps2d/${encodeURIComponent(name)}/image`
      loading.push(img)
    }
    return () => { for (const img of loading) img.onload = null }
  }, [wantedKey, byName, images])

  const gridFor = useCallback((name) => {
    const img = images.get(name)
    const info = byName.get(name)
    if (!img || !info) return null
    const hit = grids.current.get(name)
    if (hit?.img === img) return hit.value
    const value = { grid: buildClearanceGrid(img, info), info }
    grids.current.set(name, { img, value })
    return value
  }, [images, byName])

  return { maps, byName, images, error, refresh, gridFor }
}

const VIEWS_KEY = 'tmms.c2.mapViews'
const BLANK_VIEW = { scale: 1, x: 0, y: 0 }
const SAVE_VIEWS_MS = 500

function savedViews() {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY) ?? '{}') } catch { return {} }
}

function writeViews(entries) {
  if (!entries || !Object.keys(entries).length) return
  try { localStorage.setItem(VIEWS_KEY, JSON.stringify({ ...savedViews(), ...entries })) } catch {}
}

// Per-map views { scale, x, y, rot } for the Path Editor and C2. A map is fitted the first time
// it is shown and then left where the user put it: a box that changes size keeps the zoom and
// the same spot in its middle, a new ↻ angle turns the map about its middle, and where each map
// was left (zoom and middle spot) is kept in this browser per graph, so it comes back as it was.
export function useMapViews(graphId, shown, byName, images, rotOf) {
  const [views, setViews] = useState({})
  const [sizes, setSizes] = useState({})
  // The box size each map was last laid out for.
  const laidOut = useRef(new Map())

  useEffect(() => {
    setViews({})
    laidOut.current = new Map()
  }, [graphId])

  useEffect(() => {
    let next = views
    for (const m of shown) {
      const info = byName.get(m)
      const size = sizes[m]
      if (!info || !images.get(m) || !size?.width) continue
      const rot = rotOf(m)
      const was = laidOut.current.get(m)
      let view = next[m]
      if (!view || !was) {
        const saved = savedViews()[`${graphId}|${m}`]
        const fit = fitView(info, size, 0.94, rot)
        // Saved as a multiple of the fitted zoom, so a box of another size (C2 next to the
        // Path Editor) frames the same part of the map.
        const scale = saved ? (saved.zoom != null ? saved.zoom * fit.scale : saved.scale) : null
        view = saved ? centreOn({ scale, x: 0, y: 0, rot }, saved.cx, saved.cy, size) : fit
      } else {
        if (was.width !== size.width || was.height !== size.height) {
          const mid = screenToPixel(was.width / 2, was.height / 2, view)
          view = centreOn(view, mid.x, mid.y, size)
        }
        if ((view.rot ?? 0) !== rot) view = rotateView(view, rot, size)
      }
      laidOut.current.set(m, size)
      if (view !== next[m]) next = { ...next, [m]: view }
    }
    if (next !== views) setViews(next)
  }, [graphId, shown, byName, images, sizes, rotOf, views])

  // Saved a moment after the map stops moving, and at once when the page closes (switching to
  // the other tab), so a quick switch still finds where the map was left.
  const pending = useRef(null)
  useEffect(() => {
    if (!graphId) return undefined
    const entries = {}
    for (const m of shown) {
      const v = views[m]
      const size = sizes[m]
      const info = byName.get(m)
      if (!v || !size?.width || !info) continue
      const mid = screenToPixel(size.width / 2, size.height / 2, v)
      const fit = fitView(info, size, 0.94, v.rot ?? 0).scale
      entries[`${graphId}|${m}`] = { zoom: v.scale / fit, cx: mid.x, cy: mid.y }
    }
    pending.current = entries
    const t = setTimeout(() => { writeViews(pending.current); pending.current = null }, SAVE_VIEWS_MS)
    return () => clearTimeout(t)
  }, [graphId, shown, views, sizes, byName])
  useEffect(() => () => { if (pending.current) writeViews(pending.current) }, [])

  const viewSetter = useCallback((m) => (u) => setViews((v) => ({
    ...v, [m]: typeof u === 'function' ? u(v[m] ?? BLANK_VIEW) : u,
  })), [])
  const sizeSetter = useCallback((m) => (size) => setSizes((s) => (
    s[m]?.width === size.width && s[m]?.height === size.height ? s : { ...s, [m]: size })), [])

  return { views, setViews, sizes, viewSetter, sizeSetter }
}
