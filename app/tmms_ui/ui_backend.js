import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import os from 'os'
import https from 'https'
import archiver from 'archiver'
import multer from 'multer'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const PORT = process.env.PORT || 3001
const isProd = process.env.NODE_ENV === 'production'
const TLS_CERT = process.env.TMMS_TLS_CERT
const TLS_KEY = process.env.TMMS_TLS_KEY
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BAGS_DIR = process.env.TMMS_BAGS_DIR
  || path.join(__dirname, '..', 'tmms_recordings', 'rosbags')
const PYTHON_BIN = process.env.TMMS_PYTHON_BIN
  || path.join(os.homedir(), 'venvs', 'tmms_venv', 'bin', 'python3')
const MCAP_TO_MP4_SCRIPT = path.join(__dirname, 'scripts', 'mcap_to_mp4.py')

const TOPIC_MAP = {
  topdown: { topic: '/topdown_cam/compressed', label: 'topdown' },
  wrist: { topic: '/wrist_cam/compressed', label: 'wrist' },
  third_person: { topic: '/third_person_cam/compressed', label: 'third_person' },
}

const BAG_FILENAME_RE = /^[\w.-]+\.mcap$/

const MAPS_DIR = process.env.TMMS_MAPS_DIR
  || path.join(os.homedir(), '.htxgrrt', 'maps')
fs.mkdirSync(MAPS_DIR, { recursive: true })

// Maps are FAST-LIO point clouds written by /map_save, one .pcd per session. Anchored,
// with no dot/slash/dash possible — this regex is the whole path-traversal defense for the
// routes below, which all path.join() straight onto MAPS_DIR.
const MAP_FILENAME_RE = /^[A-Za-z0-9_]+\.pcd$/
const MAP_NAME_RE = /^[A-Za-z0-9_]+$/

// In-memory only — resets to idle on backend/container restart. Mirrors the session
// mapping_manager_node actually owns; the UI syncs it after each start/stop service call.
let mappingState = { mapping: false, mapName: null, startedAt: null }

// FAST-LIO .pcd maps run far larger than the rtabmap .db files this was sized for, and
// memoryStorage buffers the whole upload in the Node heap. Cap it rather than letting a
// big file OOM the backend.
const mapsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
})

const app = express()

// Vite's dev server proxies /api to this process from a different origin,
// so CORS is only needed in dev. In prod this same process serves the UI
// too, making everything same-origin.
if (!isProd) {
  app.use(cors({ origin: 'http://localhost:5173' }))
}
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

// Scaffold: future telemetry / logging endpoint
app.post('/api/log', (req, res) => {
  console.log('[ui_backend] log:', req.body)
  res.json({ received: true })
})

// Open CORS regardless of NODE_ENV since both Lichtblick (port 8080) and
// this server's own frontend are different origins from ui_backend.js.
app.use('/api/bags', cors({
  exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
}))

app.get('/api/bags', (_req, res) => {
  if (!fs.existsSync(BAGS_DIR)) {
    return res.json([])
  }
  const filenames = fs.readdirSync(BAGS_DIR)
    .filter((f) => f.endsWith('.mcap'))
    .sort()
  const files = filenames.map((filename) => ({
    filename,
    sizeBytes: fs.statSync(path.join(BAGS_DIR, filename)).size,
  }))
  res.json(files)
})

app.get('/api/bags/:filename', (req, res) => {
  const filename = req.params.filename
  if (!BAG_FILENAME_RE.test(filename)) {
    return res.status(400).end()
  }
  if (!fs.existsSync(path.join(BAGS_DIR, filename))) {
    return res.status(404).json({ error: 'file not found', filename })
  }
  res.set('Content-Disposition', `attachment; filename="${filename}"`)
  // Pass `root` instead of a pre-joined absolute path -- this is Express's
  // documented pattern for sendFile and avoids path-resolution ambiguity.
  res.sendFile(filename, { root: BAGS_DIR })
})

function runConversion(inputMcap, topic, outputMp4) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [MCAP_TO_MP4_SCRIPT, inputMcap, topic, outputMp4])
    let stderr = ''
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `mcap_to_mp4.py exited with code ${code}`))
    })
  })
}

app.post('/api/bags/:filename/videos', async (req, res) => {
  const filename = req.params.filename
  if (!BAG_FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'invalid filename' })
  }

  const topicKeys = req.body?.topics
  if (!Array.isArray(topicKeys) || topicKeys.length === 0 || !topicKeys.every((k) => k in TOPIC_MAP)) {
    return res.status(400).json({ error: 'topics must be a non-empty array of known topic keys' })
  }

  const inputMcap = path.join(BAGS_DIR, filename)
  if (!fs.existsSync(inputMcap)) {
    return res.status(404).json({ error: 'bag not found' })
  }

  const bagName = filename.replace(/\.mcap$/, '')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmms-video-'))
  const cleanup = () => fs.rm(outDir, { recursive: true, force: true }, () => {})

  try {
    const outputs = []
    for (const key of topicKeys) {
      const { topic, label } = TOPIC_MAP[key]
      const outputMp4 = path.join(outDir, `${bagName}_${label}.mp4`)
      console.log(`[ui_backend] converting ${filename} topic=${topic} -> ${outputMp4}`)
      await runConversion(inputMcap, topic, outputMp4)
      outputs.push({ label, outputMp4 })
    }

    if (outputs.length === 1) {
      const { outputMp4 } = outputs[0]
      res.download(outputMp4, path.basename(outputMp4), () => cleanup())
    } else {
      res.set('Content-Disposition', `attachment; filename="${bagName}_videos.zip"`)
      res.set('Content-Type', 'application/zip')
      const archive = archiver('zip')
      archive.on('warning', (err) => console.warn('[ui_backend] archiver warning:', err))
      archive.on('error', (err) => { throw err })
      res.on('close', cleanup)
      archive.pipe(res)
      for (const { outputMp4 } of outputs) {
        archive.file(outputMp4, { name: path.basename(outputMp4) })
      }
      await archive.finalize()
    }
  } catch (err) {
    console.error('[ui_backend] video export failed:', err.message)
    cleanup()
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    } else {
      res.end()
    }
  }
})

// Open CORS regardless of NODE_ENV, same reasoning as /api/bags above.
app.use('/api/maps', cors({
  exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
}))

app.get('/api/maps', (_req, res) => {
  const filenames = fs.readdirSync(MAPS_DIR)
    .filter((f) => f.endsWith('.pcd'))
    .sort()
    .reverse()
  const files = filenames.map((filename) => {
    const stat = fs.statSync(path.join(MAPS_DIR, filename))
    return { filename, sizeBytes: stat.size, mtime: stat.mtime.toISOString() }
  })
  res.json(files)
})

app.get('/api/maps/:filename', (req, res) => {
  const filename = req.params.filename
  if (!MAP_FILENAME_RE.test(filename)) {
    return res.status(400).end()
  }
  if (!fs.existsSync(path.join(MAPS_DIR, filename))) {
    return res.status(404).json({ error: 'file not found', filename })
  }
  res.set('Content-Disposition', `attachment; filename="${filename}"`)
  res.sendFile(filename, { root: MAPS_DIR })
})

app.post('/api/maps', mapsUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no file uploaded' })
  }
  const filename = req.file.originalname
  if (!MAP_FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'filename must match [A-Za-z0-9_]+.pcd' })
  }
  const destPath = path.join(MAPS_DIR, filename)
  const overwritten = fs.existsSync(destPath)
  // Overwrite confirmation is handled client-side (WarningModal) before this
  // request is ever sent — the backend just executes and reports the result.
  fs.writeFileSync(destPath, req.file.buffer)
  res.json({ filename, overwritten })
})

app.delete('/api/maps/:filename', (req, res) => {
  const filename = req.params.filename
  if (!MAP_FILENAME_RE.test(filename)) {
    return res.status(400).end()
  }
  const targetPath = path.join(MAPS_DIR, filename)
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'file not found', filename })
  }
  const mapName = filename.replace(/\.pcd$/, '')
  if (mappingState.mapping && mappingState.mapName === mapName) {
    // Only guard a LIVE session. mapName deliberately outlives action:'end' so the
    // "last saved" readout keeps working, but FAST-LIO holds no handle on the .pcd once
    // the session is over — keying on the name alone would block deleting a finished map.
    return res.status(409).json({ error: 'cannot delete the map being written right now', mapName })
  }
  fs.unlinkSync(targetPath)
  res.json({ filename, deleted: true })
})

app.get('/api/mapping-state', (_req, res) => {
  // FAST-LIO only writes the .pcd when /map_save runs at End Mapping, so this stays null
  // for the whole session and then jumps to a real value. (rtabmap used to write its .db
  // continuously, which is why this used to tick up live.)
  let lastSavedAgoSeconds = null
  if (mappingState.mapName) {
    const pcdPath = path.join(MAPS_DIR, `${mappingState.mapName}.pcd`)
    if (fs.existsSync(pcdPath)) {
      lastSavedAgoSeconds = Math.floor((Date.now() - fs.statSync(pcdPath).mtime.getTime()) / 1000)
    }
  }
  res.json({
    mapping: mappingState.mapping,
    mapName: mappingState.mapName,
    startedAt: mappingState.startedAt,
    lastSavedAgoSeconds,
  })
})

app.post('/api/mapping-state', (req, res) => {
  const { action, mapName } = req.body || {}

  if (action === 'start') {
    if (mappingState.mapping) {
      return res.status(409).json({ error: 'a mapping session is already active', mapName: mappingState.mapName })
    }
    if (!mapName || !MAP_NAME_RE.test(mapName)) {
      return res.status(400).json({ error: 'mapName must match [A-Za-z0-9_]+' })
    }
    mappingState = { mapping: true, mapName, startedAt: new Date().toISOString() }
    return res.json(mappingState)
  }

  if (action === 'end') {
    // Keep mapName so "last saved" keeps reading the right file after ending.
    mappingState = { mapping: false, mapName: mappingState.mapName, startedAt: null }
    return res.json(mappingState)
  }

  // No 'load' action: loading a map back in is a FAST-LIO problem with no service to bind
  // to (unlike rtabmap's load_database), so the Load button is gone until that is solved.

  return res.status(400).json({ error: 'action must be "start" or "end"' })
})

if (isProd) {
  app.use(express.static(path.join(__dirname, 'dist')))
}

if (TLS_CERT && TLS_KEY) {
  https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, app).listen(PORT, () => {
    console.log(`[ui_backend] https listening on ${PORT}`)
  })
} else {
  app.listen(PORT, () => {
    console.log(`[ui_backend] listening on http://localhost:${PORT}`)
  })
}
