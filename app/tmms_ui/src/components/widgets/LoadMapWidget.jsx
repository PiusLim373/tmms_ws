import { useState, useEffect, useCallback } from 'react'
import { loadNavMap } from '../../services/rosbridge'

// /api/maps2d already reports ONLY complete maps: ui_backend's readMap2d returns null
// unless both <name>.png and <name>.yaml exist, so there is no validity filtering to do
// here. It also hands back the pcd_file the grid was flattened from, which is what
// localization_manager follows to load the 3D cloud alongside the 2D map.
export function LoadMapWidget({ currentMap, onNavigate }) {
  const [maps, setMaps] = useState(null)     // null = still loading, [] = genuinely none
  const [loadingName, setLoadingName] = useState(null)
  const [result, setResult] = useState(null) // { ok, message }

  const refresh = useCallback(() => {
    fetch('/api/maps2d')
      .then((r) => r.json())
      .then(setMaps)
      .catch((err) => {
        console.error('[LoadMapWidget] /api/maps2d failed:', err)
        setMaps([])
      })
  }, [])

  useEffect(refresh, [refresh])

  function handleLoad(name) {
    setLoadingName(name)
    setResult(null)
    loadNavMap(
      name,
      (res) => {
        setLoadingName(null)
        // Transport success only — the gate rejects (mid-navigation, missing yaml) come
        // back here with success: false, so the message is the whole point.
        setResult({ ok: res.success, message: res.message })
      },
      (err) => {
        setLoadingName(null)
        setResult({ ok: false, message: String(err) })
      }
    )
  }

  const mappingLink = (
    <button
      onClick={() => onNavigate?.('mapping')}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: 'var(--accent-bright)',
        textDecoration: 'underline',
        cursor: 'pointer',
      }}
    >
      Mapping page
    </button>
  )

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      <div className="panel-header flex items-center justify-between">
        <span>LOAD MAP</span>
        <button
          onClick={refresh}
          className="btn-icon"
          style={{ padding: '2px 8px', fontSize: 11 }}
          title="Re-read the map store"
        >
          ⟳
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
        {maps === null && (
          <div style={{ fontSize: 12, opacity: 0.6 }}>Reading map store…</div>
        )}

        {maps?.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
            No maps yet. Head to the {mappingLink} to record a new one or upload an
            existing map.
          </div>
        )}

        {maps?.map((m) => {
          const isCurrent = m.name === currentMap
          return (
            <div
              key={m.name}
              className="flex items-center justify-between"
              style={{
                padding: '6px 8px',
                marginBottom: 4,
                borderRadius: 4,
                border: '1px solid var(--border)',
                background: isCurrent ? 'var(--accent-dim, rgba(96,165,250,0.12))' : 'transparent',
              }}
            >
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {m.name} {isCurrent && <span style={{ opacity: 0.8 }}>· loaded</span>}
                </div>
                <div style={{ fontSize: 10, opacity: 0.6 }}>
                  {m.width}×{m.height}
                  {m.resolution ? ` · ${m.resolution} m/px` : ''}
                  {m.pcdFile ? ' · 3D cloud' : ' · no 3D cloud'}
                </div>
              </div>
              <button
                onClick={() => handleLoad(m.name)}
                disabled={loadingName !== null}
                className="btn-icon"
                style={{ padding: '4px 12px', fontSize: 11, flexShrink: 0 }}
              >
                {loadingName === m.name ? 'Loading…' : 'Load'}
              </button>
            </div>
          )
        })}

        {result && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              lineHeight: 1.5,
              color: result.ok ? 'var(--ok, #4ADE80)' : '#F87171',
            }}
          >
            {result.message}
          </div>
        )}

        {maps?.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 10, opacity: 0.55, lineHeight: 1.5 }}>
            Need a different map? Create or upload one on the {mappingLink}.
          </div>
        )}
      </div>
    </div>
  )
}
