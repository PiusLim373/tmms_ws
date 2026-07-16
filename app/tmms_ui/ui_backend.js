import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import os from 'os'
import https from 'https'
import archiver from 'archiver'
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
