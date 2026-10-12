import { useCallback, useEffect, useRef, useState } from 'react'
import { listGraphs, saveGraph } from '../lib/c2Store'

const DEBOUNCE_MS = 600
const RETRY_MS = 3000

export function useC2GraphStore() {
  const [graphs, setGraphs] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState('loading')
  const [kick, setKick] = useState(0)

  const graphsRef = useRef(graphs)
  const dirtyRef = useRef(new Map())
  const versionRef = useRef(0)
  const inFlightRef = useRef(false)
  const retryTimerRef = useRef(null)

  useEffect(() => { graphsRef.current = graphs }, [graphs])

  useEffect(() => {
    let stopped = false
    let timer = null
    const attempt = () => {
      listGraphs()
        .then((stored) => {
          if (stopped) return
          setGraphs((prev) => [...stored, ...prev.filter((g) => !stored.some((s) => s.id === g.id))])
          setStatus(dirtyRef.current.size ? 'saving' : 'saved')
          setLoaded(true)
        })
        .catch((err) => {
          if (stopped) return
          console.warn('[C2] pin store unavailable:', err.message)
          setStatus('offline')
          timer = setTimeout(attempt, RETRY_MS)
        })
    }
    attempt()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])

  const updateGraphs = useCallback((updater) => {
    setGraphs((prev) => {
      const next = updater(prev)
      if (next === prev) return prev
      const before = new Map(prev.map((g) => [g.id, g]))
      for (const g of next) {
        if (before.get(g.id) !== g) dirtyRef.current.set(g.id, ++versionRef.current)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!loaded || dirtyRef.current.size === 0) return
    setStatus((s) => (s === 'retrying' ? s : 'saving'))

    const timer = setTimeout(async () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      let failed = false
      for (const [id, version] of [...dirtyRef.current]) {
        const graph = graphsRef.current.find((g) => g.id === id)
        if (!graph) { dirtyRef.current.delete(id); continue }
        try {
          await saveGraph(graph)
          if (dirtyRef.current.get(id) === version) dirtyRef.current.delete(id)
        } catch (err) {
          failed = true
          console.warn(`[C2] saving graph ${graph.name} failed:`, err.message)
        }
      }
      inFlightRef.current = false

      if (failed) {
        setStatus('retrying')
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => setKick((k) => k + 1), RETRY_MS)
      } else if (dirtyRef.current.size) {
        setKick((k) => k + 1)
      } else {
        setStatus('saved')
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [graphs, loaded, kick])

  useEffect(() => {
    const flushNow = () => {
      for (const id of dirtyRef.current.keys()) {
        const graph = graphsRef.current.find((g) => g.id === id)
        if (graph) saveGraph(graph, { keepalive: true }).catch(() => {})
      }
    }
    window.addEventListener('pagehide', flushNow)
    return () => {
      window.removeEventListener('pagehide', flushNow)
      clearTimeout(retryTimerRef.current)
      flushNow()
    }
  }, [])

  return { graphs, updateGraphs, status }
}
