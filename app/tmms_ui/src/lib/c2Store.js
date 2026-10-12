async function asJson(res) {
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).error ?? '' } catch {}
    throw new Error(detail || `HTTP ${res.status}`)
  }
  return res.json()
}

export function listGraphs() {
  return fetch('/api/c2/graphs').then(asJson)
}

export function saveGraph(graph, { keepalive = false } = {}) {
  return fetch(`/api/c2/graphs/${encodeURIComponent(graph.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: graph.name,
      map: graph.map,
      pins: graph.pins,
      links: graph.links ?? [],
    }),
    keepalive,
  }).then(asJson)
}
