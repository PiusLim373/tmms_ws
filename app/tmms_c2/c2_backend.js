import express from 'express'
import { MongoClient } from 'mongodb'

const PORT = Number(process.env.PORT || 3002)
const HOST = process.env.HOST || '127.0.0.1'
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017'
const DB_NAME = process.env.C2_DB || 'tmms_c2'

const GRAPH_ID_RE = /^g_[a-z0-9]{1,32}$/
const PIN_ID_RE = /^(pin_[a-z0-9_]{1,64}|poi_\d{1,9})$/
const NAME_RE = /^[A-Za-z0-9_]{1,128}$/
const PIN_TYPES = new Set(['action', 'simple', 'home'])
const MAX_PINS = 2000
const LINK_KEY_RE = /^(pin_[a-z0-9_]{1,64}|poi_\d{1,9})\|(pin_[a-z0-9_]{1,64}|poi_\d{1,9})$/
const MAX_LINKS = 10000

const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 3000 })
const graphs = client.db(DB_NAME).collection('graphs')

function validPin(p) {
  return p && typeof p === 'object' && !Array.isArray(p)
    && typeof p.id === 'string' && PIN_ID_RE.test(p.id)
    && PIN_TYPES.has(p.type)
    && Number.isFinite(p.x) && Number.isFinite(p.y)
}

function toApi(doc) {
  return {
    id: doc._id,
    name: doc.name,
    map: doc.map,
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
  const { name, map, pins, links = [] } = req.body ?? {}
  if (!GRAPH_ID_RE.test(id)) return res.status(400).json({ error: 'bad graph id' })
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return res.status(400).json({ error: 'name must match [A-Za-z0-9_]+' })
  }
  if (typeof map !== 'string' || !NAME_RE.test(map)) {
    return res.status(400).json({ error: 'map must match [A-Za-z0-9_]+' })
  }
  if (!Array.isArray(pins) || pins.length > MAX_PINS || !pins.every(validPin)) {
    return res.status(400).json({ error: 'pins must be an array of {id, type, x, y}' })
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
        $set: { name, map, pins, links, updatedAt: now },
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
