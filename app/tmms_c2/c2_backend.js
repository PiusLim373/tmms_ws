import express from 'express'
import { MongoClient } from 'mongodb'

const PORT = Number(process.env.PORT || 3002)
const HOST = process.env.HOST || '127.0.0.1'
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017'
const DB_NAME = process.env.C2_DB || 'tmms_c2'

const GRAPH_ID_RE = /^g_[a-z0-9]{1,32}$/
// Mapping points carry their map (poi_3@corridor), since one graph spans several maps.
const PIN_ID_SRC = 'pin_[a-z0-9_]{1,64}|poi_\\d{1,9}(?:@[A-Za-z0-9_]{1,128})?'
const PIN_ID_RE = new RegExp(`^(?:${PIN_ID_SRC})$`)
const NAME_RE = /^[A-Za-z0-9_]{1,128}$/
const PIN_TYPES = new Set(['action', 'simple', 'home', 'map_switch'])
const MAX_PINS = 2000
const LINK_KEY_RE = new RegExp(`^(?:${PIN_ID_SRC})\\|(?:${PIN_ID_SRC})$`)
const MAX_MAPS = 50
const MAX_LINKS = 10000
// Mapping POIs (from the map files) deleted from one route; the map files are not touched.
const MAPPED_POI_RE = /^poi_\d{1,9}@[A-Za-z0-9_]{1,128}$/

const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 3000 })
const graphs = client.db(DB_NAME).collection('graphs')

// A map switch's partner: the id of a map switch on another map of the same graph, or null.
function validPair(pair) {
  return pair == null || (typeof pair === 'string' && PIN_ID_RE.test(pair))
}

// How far each map is turned on screen, in degrees: display only, shared by Path Editor and C2.
function validRotations(r) {
  if (r == null) return true
  if (typeof r !== 'object' || Array.isArray(r)) return false
  const entries = Object.entries(r)
  return entries.length <= MAX_MAPS && entries.every(([k, v]) => NAME_RE.test(k)
    && typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 360)
}

// How map `from` sits on map `to` ("from|to"), found by matching their walls in the Path
// Editor: { turn (rad), tx, ty (m), score (0..1) }.
function validAlignments(a) {
  if (a == null) return true
  if (typeof a !== 'object' || Array.isArray(a)) return false
  const entries = Object.entries(a)
  const num = (v) => typeof v === 'number' && Number.isFinite(v)
  return entries.length <= MAX_MAPS * MAX_MAPS && entries.every(([k, v]) => {
    const [from, to] = k.split('|')
    return NAME_RE.test(from ?? '') && NAME_RE.test(to ?? '') && v && typeof v === 'object'
      && num(v.turn) && num(v.tx) && num(v.ty) && (v.score == null || num(v.score))
  })
}

function validPin(p) {
  return p && typeof p === 'object' && !Array.isArray(p)
    && typeof p.id === 'string' && PIN_ID_RE.test(p.id)
    && PIN_TYPES.has(p.type)
    && Number.isFinite(p.x) && Number.isFinite(p.y)
    && typeof p.map === 'string' && NAME_RE.test(p.map)
    && validPair(p.pair)
}

function toApi(doc) {
  return {
    id: doc._id,
    name: doc.name,
    // Graphs from before multi-map have `map` and no `maps`; the UI converts them on load.
    map: doc.map,
    maps: doc.maps,
    rotations: doc.rotations ?? {},
    hiddenPois: doc.hiddenPois ?? [],
    alignments: doc.alignments ?? {},
    pins: doc.pins,
    links: doc.links ?? [],
    updatedAt: doc.updatedAt,
  }
}

const app = express()
app.use(express.json({ limit: '2mb' }))

app.get('/health', async (_req, res) => {
  try {
    await client.db(DB_NAME).command({ ping: 1 })
    res.json({ ok: true })
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message })
  }
})

app.get('/graphs', async (_req, res) => {
  try {
    const docs = await graphs
      .find({ deletedAt: null }, { projection: { deletedPins: 0 } })
      .sort({ createdAt: 1 })
      .toArray()
    res.json(docs.map(toApi))
  } catch (err) {
    console.error('[c2_backend] list failed:', err.message)
    res.status(503).json({ error: 'pin store unavailable' })
  }
})

app.put('/graphs/:id', async (req, res) => {
  const { id } = req.params
  const { name, maps, pins, links = [], rotations = {}, hiddenPois = [], alignments = {} } = req.body ?? {}
  if (!GRAPH_ID_RE.test(id)) return res.status(400).json({ error: 'bad graph id' })
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return res.status(400).json({ error: 'name must match [A-Za-z0-9_]+' })
  }
  if (!Array.isArray(maps) || maps.length > MAX_MAPS
      || !maps.every((m) => typeof m === 'string' && NAME_RE.test(m))) {
    return res.status(400).json({ error: 'maps must be an array of names matching [A-Za-z0-9_]+' })
  }
  if (!Array.isArray(pins) || pins.length > MAX_PINS || !pins.every(validPin)
      || !pins.every((p) => maps.includes(p.map))) {
    return res.status(400).json({ error: 'pins must be an array of {id, type, map, x, y}, each on one of the maps' })
  }
  if (!Array.isArray(hiddenPois) || hiddenPois.length > MAX_PINS
      || !hiddenPois.every((h) => typeof h === 'string' && MAPPED_POI_RE.test(h))) {
    return res.status(400).json({ error: 'hiddenPois must be an array of mapping POI ids' })
  }
  if (!validAlignments(alignments)) {
    return res.status(400).json({ error: 'alignments must map "from|to" to {turn, tx, ty, score}' })
  }
  if (!validRotations(rotations)) {
    return res.status(400).json({ error: 'rotations must map map names to degrees' })
  }
  if (!Array.isArray(links) || links.length > MAX_LINKS
      || !links.every((k) => typeof k === 'string' && LINK_KEY_RE.test(k))) {
    return res.status(400).json({ error: 'links must be an array of "idA|idB" keys' })
  }

  try {
    const now = new Date().toISOString()
    const stored = await graphs.findOne({ _id: id }, { projection: { pins: 1 } })
    const keep = new Set(pins.map((p) => p.id))
    const removed = (stored?.pins ?? [])
      .filter((p) => !keep.has(p.id))
      .map((p) => ({ ...p, deletedAt: now }))

    await graphs.updateOne(
      { _id: id },
      {
        $set: { name, maps, pins, links, rotations, hiddenPois, alignments, updatedAt: now },
        $unset: { map: '' },
        $setOnInsert: { createdAt: now, deletedAt: null },
        ...(removed.length && { $push: { deletedPins: { $each: removed } } }),
      },
      { upsert: true },
    )
    res.json({ id, updatedAt: now, deletedPins: removed.length })
  } catch (err) {
    console.error(`[c2_backend] save ${id} failed:`, err.message)
    res.status(503).json({ error: 'pin store unavailable' })
  }
})

app.listen(PORT, HOST, () => {
  console.log(`[c2_backend] listening on http://${HOST}:${PORT}, mongo ${MONGO_URL}/${DB_NAME}`)
})
