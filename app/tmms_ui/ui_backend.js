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

// MAPS_DIR is the ROOT of the map store, holding one subfolder per representation of a map:
//
//   <MAPS_DIR>/pcd/<name>.pcd    3D cloud, written by FAST-LIO's /map_save
//   <MAPS_DIR>/png/<name>.png    2D grid, written by the map editor in this UI
//   <MAPS_DIR>/png/<name>.yaml   its metadata, carrying a pcd_file key back to the .pcd
//
// Every ROS node takes the same root and derives its own subfolder, so this env var stays
// pointed at the root and the layout is agreed in exactly one place.
const MAPS_DIR = process.env.TMMS_MAPS_DIR
  || path.join(os.homedir(), '.htxgrrt', 'maps')
const PCD_DIR = path.join(MAPS_DIR, 'pcd')
const PNG_DIR = path.join(MAPS_DIR, 'png')
fs.mkdirSync(PCD_DIR, { recursive: true })
fs.mkdirSync(PNG_DIR, { recursive: true })

// Maps are FAST-LIO point clouds written by /map_save, one .pcd per session. Anchored,
// with no dot/slash/dash possible — this regex is the whole path-traversal defense for the
// routes below, which all path.join() straight onto PCD_DIR.
const MAP_FILENAME_RE = /^[A-Za-z0-9_]+\.pcd$/
const MAP_NAME_RE = /^[A-Za-z0-9_]+$/

// The three greys the map editor can produce, and the thresholds that make map_server read
// them back as what was drawn. map_server computes occ = (255 - pixel) / 255, so:
//
//   OBSTACLE 0   -> occ 1.000  > occupied_thresh -> 100
//   UNKNOWN  205 -> occ 0.196  in between        ->  -1
//   FREE     255 -> occ 0.000  < free_thresh     ->   0
//
// free_thresh is 0.15 rather than the conventional 0.196 on purpose. 205 is the standard ROS
// unknown grey and gives occ = 0.19607…, so against 0.196 the "is this unknown or free?"
// decision comes down to a float comparison that is true by six millionths. The canvas only
// ever holds these three exact values, so dropping the threshold costs nothing and the result
// stops depending on rounding.
const MAP_FREE_THRESH = 0.15
const MAP_OCCUPIED_THRESH = 0.65

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

// ---------------------------------------------------------------------------
// Map YAML
//
// Hand-rolled rather than js-yaml, because a backend dependency is the expensive kind here:
// deployment rsyncs dist/, ui_backend.js and scripts/ only — node_modules lives inside the
// container image, so adding one means rebuilding and pushing that image. These files are a
// flat scalar map plus one inline array, which is not worth that.
//
// Handles what map_server writes and what we write: `key: value`, quoted or bare scalars,
// `origin: [x, y, yaw]`, and # comments. Anything else is returned as a raw string.
function parseMapYaml(text) {
  const out = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep < 0) continue
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1).trim()
    if (!key) continue

    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map((v) => Number(v.trim()))
      continue
    }
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
      out[key] = value
      continue
    }
    out[key] = value !== '' && !Number.isNaN(Number(value)) ? Number(value) : value
  }
  return out
}

// `image` is always rewritten to <name>.png so a pair is self-consistent even if an uploaded
// yaml pointed somewhere else. pcd_file is an absolute path — the ROS containers and this one
// both mount the store at the same place, and an absolute path survives the file being copied
// somewhere the relative one would not resolve from.
function writeMapYaml({ name, resolution, origin, pcdFile }) {
  const [ox, oy, oyaw] = origin
  const lines = [
    `image: ${name}.png`,
    'mode: trinary',
    `resolution: ${resolution}`,
    `origin: [${ox}, ${oy}, ${oyaw}]`,
    'negate: 0',
    `occupied_thresh: ${MAP_OCCUPIED_THRESH}`,
    `free_thresh: ${MAP_FREE_THRESH}`,
  ]
  if (pcdFile) {
    lines.push('')
    lines.push('# 3D cloud this grid was flattened from.')
    lines.push(`pcd_file: ${pcdFile}`)
  }
  return lines.join('\n') + '\n'
}

// Dimensions from the PNG header instead of decoding the image: IHDR is the first chunk, so
// width and height are big-endian uint32 at offsets 16 and 20. These files run to tens of MB
// and the list route touches every one of them, so decoding would make listing cost more than
// everything else in this backend put together.
function readPngSize(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const header = Buffer.alloc(24)
    if (fs.readSync(fd, header, 0, 24, 0) < 24) return null
    if (header.toString('ascii', 1, 4) !== 'PNG') return null
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

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
  const filenames = fs.readdirSync(PCD_DIR)
    .filter((f) => f.endsWith('.pcd'))
    .sort()
    .reverse()
  const files = filenames.map((filename) => {
    const stat = fs.statSync(path.join(PCD_DIR, filename))
    return { filename, sizeBytes: stat.size, mtime: stat.mtime.toISOString() }
  })
  res.json(files)
})

app.get('/api/maps/:filename', (req, res) => {
  const filename = req.params.filename
  if (!MAP_FILENAME_RE.test(filename)) {
    return res.status(400).end()
  }
  if (!fs.existsSync(path.join(PCD_DIR, filename))) {
    return res.status(404).json({ error: 'file not found', filename })
  }
  res.set('Content-Disposition', `attachment; filename="${filename}"`)
  res.sendFile(filename, { root: PCD_DIR })
})

app.post('/api/maps', mapsUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no file uploaded' })
  }
  const filename = req.file.originalname
  if (!MAP_FILENAME_RE.test(filename)) {
    return res.status(400).json({ error: 'filename must match [A-Za-z0-9_]+.pcd' })
  }
  const destPath = path.join(PCD_DIR, filename)
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
  const targetPath = path.join(PCD_DIR, filename)
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

// ---------------------------------------------------------------------------
// 2D navigation maps — <PNG_DIR>/<name>.png + <name>.yaml
//
// These routes take a BARE NAME, never a filename, so MAP_NAME_RE is the only thing that has
// to be right for path traversal to be impossible; the extensions are appended here.

const png2dPath = (name) => path.join(PNG_DIR, `${name}.png`)
const yaml2dPath = (name) => path.join(PNG_DIR, `${name}.yaml`)

// A map is only a map when BOTH halves are present. Half a pair is not reported as broken,
// it is simply not a map — map_server cannot load a yaml without its image, and an image with
// no yaml has no resolution or origin, so neither is something the operator can act on.
function readMap2d(name) {
  const pngPath = png2dPath(name)
  const yamlPath = yaml2dPath(name)
  if (!fs.existsSync(pngPath) || !fs.existsSync(yamlPath)) return null

  let meta = {}
  try {
    meta = parseMapYaml(fs.readFileSync(yamlPath, 'utf-8'))
  } catch {
    return null
  }
  const size = readPngSize(pngPath)
  const stat = fs.statSync(pngPath)
  return {
    name,
    pngBytes: stat.size,
    mtime: stat.mtime.toISOString(),
    width: size?.width ?? null,
    height: size?.height ?? null,
    resolution: typeof meta.resolution === 'number' ? meta.resolution : null,
    origin: Array.isArray(meta.origin) ? meta.origin : null,
    pcdFile: typeof meta.pcd_file === 'string' ? meta.pcd_file : null,
  }
}

app.use('/api/maps2d', cors({
  exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
}))

app.get('/api/maps2d', (_req, res) => {
  const names = fs.readdirSync(PNG_DIR)
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.replace(/\.png$/, ''))
    .filter((n) => MAP_NAME_RE.test(n))
    // Name-descending, matching /api/maps: with the YYMMDD_ prefix the UI seeds, that puts
    // the newest on top, and unlike an mtime sort it does not reshuffle when a map is edited.
    .sort()
    .reverse()
  res.json(names.map(readMap2d).filter(Boolean))
})

app.get('/api/maps2d/:name/image', (req, res) => {
  const { name } = req.params
  if (!MAP_NAME_RE.test(name)) return res.status(400).end()
  if (!fs.existsSync(png2dPath(name))) {
    return res.status(404).json({ error: 'map not found', name })
  }
  // No Content-Disposition: the editor loads this into an <img> to seed the canvas, so it
  // must render inline rather than prompt a download.
  res.sendFile(`${name}.png`, { root: PNG_DIR })
})

app.get('/api/maps2d/:name/meta', (req, res) => {
  const { name } = req.params
  if (!MAP_NAME_RE.test(name)) return res.status(400).end()
  const entry = readMap2d(name)
  if (!entry) return res.status(404).json({ error: 'map not found', name })
  res.json(entry)
})

// Zipped because a 2D map IS the pair — handing back only the .png would give the operator
// something map_server cannot load.
app.get('/api/maps2d/:name/download', (req, res) => {
  const { name } = req.params
  if (!MAP_NAME_RE.test(name)) return res.status(400).end()
  if (!readMap2d(name)) return res.status(404).json({ error: 'map not found', name })

  res.set('Content-Disposition', `attachment; filename="${name}_map.zip"`)
  res.set('Content-Type', 'application/zip')
  const archive = archiver('zip')
  archive.on('warning', (err) => console.warn('[ui_backend] archiver warning:', err))
  archive.on('error', (err) => {
    console.error('[ui_backend] map2d zip failed:', err.message)
    res.end()
  })
  archive.pipe(res)
  archive.file(png2dPath(name), { name: `${name}.png` })
  archive.file(yaml2dPath(name), { name: `${name}.yaml` })
  archive.finalize()
})

app.post('/api/maps2d', mapsUpload.fields([{ name: 'png', maxCount: 1 }, { name: 'yaml', maxCount: 1 }]),
  (req, res) => {
    const png = req.files?.png?.[0]
    const yaml = req.files?.yaml?.[0]
    if (!png || !yaml) {
      return res.status(400).json({ error: 'both a .png and a .yaml file are required' })
    }

    const pngName = png.originalname.replace(/\.png$/i, '')
    const yamlName = yaml.originalname.replace(/\.ya?ml$/i, '')
    if (pngName !== yamlName) {
      return res.status(400).json({
        error: `filenames must match: got ${png.originalname} and ${yaml.originalname}`,
      })
    }
    if (!MAP_NAME_RE.test(pngName)) {
      return res.status(400).json({ error: 'map name must match [A-Za-z0-9_]+' })
    }

    // Parsed before anything is written: a yaml without resolution or origin produces a map
    // that loads as a picture at the wrong scale in the wrong place, which is worse than a
    // rejected upload because nothing about it looks broken.
    const meta = parseMapYaml(yaml.buffer.toString('utf-8'))
    if (typeof meta.resolution !== 'number' || !Array.isArray(meta.origin) || meta.origin.length < 2) {
      return res.status(400).json({ error: 'yaml must contain a numeric resolution and an origin [x, y, yaw]' })
    }

    const overwritten = fs.existsSync(png2dPath(pngName))
    fs.writeFileSync(png2dPath(pngName), png.buffer)
    // Rewritten rather than stored verbatim, so `image:` names the file we just wrote and the
    // thresholds match the palette this app produces.
    fs.writeFileSync(yaml2dPath(pngName), writeMapYaml({
      name: pngName,
      resolution: meta.resolution,
      origin: [meta.origin[0], meta.origin[1], meta.origin[2] ?? 0],
      pcdFile: typeof meta.pcd_file === 'string' ? meta.pcd_file : null,
    }))
    res.json({ name: pngName, overwritten })
  })

// Save from the editor: the PNG blob plus the metadata it was opened with.
app.post('/api/maps2d/:name', mapsUpload.single('png'), (req, res) => {
  const { name } = req.params
  if (!MAP_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'map name must match [A-Za-z0-9_]+' })
  }
  if (!req.file) return res.status(400).json({ error: 'no png uploaded' })

  let meta
  try {
    meta = JSON.parse(req.body?.meta ?? '')
  } catch {
    return res.status(400).json({ error: 'meta must be a JSON object' })
  }
  if (typeof meta.resolution !== 'number' || !Array.isArray(meta.origin)) {
    return res.status(400).json({ error: 'meta needs a numeric resolution and an origin array' })
  }

  const overwritten = fs.existsSync(png2dPath(name))
  fs.writeFileSync(png2dPath(name), req.file.buffer)
  fs.writeFileSync(yaml2dPath(name), writeMapYaml({
    name,
    resolution: meta.resolution,
    origin: [meta.origin[0], meta.origin[1], meta.origin[2] ?? 0],
    // Absolute, and built here rather than trusted from the client, so a name is all the
    // browser ever sends and the path can never point outside the store.
    pcdFile: MAP_NAME_RE.test(meta.pcdName ?? '')
      ? path.join(PCD_DIR, `${meta.pcdName}.pcd`)
      : null,
  }))
  res.json({ name, overwritten })
})

app.delete('/api/maps2d/:name', (req, res) => {
  const { name } = req.params
  if (!MAP_NAME_RE.test(name)) return res.status(400).end()
  if (!fs.existsSync(png2dPath(name)) && !fs.existsSync(yaml2dPath(name))) {
    return res.status(404).json({ error: 'map not found', name })
  }
  // force: true so a half-pair (which the list hides) can still be cleaned up.
  fs.rmSync(png2dPath(name), { force: true })
  fs.rmSync(yaml2dPath(name), { force: true })
  res.json({ name, deleted: true })
})

app.get('/api/mapping-state', (_req, res) => {
  // FAST-LIO only writes the .pcd when /map_save runs at End Mapping, so this stays null
  // for the whole session and then jumps to a real value. (rtabmap used to write its .db
  // continuously, which is why this used to tick up live.)
  let lastSavedAgoSeconds = null
  if (mappingState.mapName) {
    const pcdPath = path.join(PCD_DIR, `${mappingState.mapName}.pcd`)
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

// ─────────────────────────────────────────────────────────────────────────────────────────
// System reboot — thin proxy to reboot_manager.py on the host
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// The restarts themselves (docker exec into tmms_run, supervisorctl) are host operations this
// container cannot perform — it has no docker socket and no supervisor. reboot_manager.py does
// them and binds loopback only; this container is network_mode: host, so 127.0.0.1 reaches it.
//
// The proxy exists so the dashboard can call these same-origin. It is served over https, and a
// direct fetch to the manager's http port would be blocked as mixed content — and giving the
// manager its own TLS listener would instead mean exposing the reboot endpoints to the whole
// network and making the operator accept a second self-signed cert.
const REBOOT_MANAGER_URL = process.env.TMMS_REBOOT_URL || 'http://127.0.0.1:5055'
const REBOOT_TARGETS = new Set(['rosbridge', 'tmms_ws'])

// Upstream status codes are passed straight through: 409 (a reboot is already running) is a
// state the dashboard renders differently from a failure.
async function proxyToRebootManager(res, urlPath, init) {
  try {
    const upstream = await fetch(`${REBOOT_MANAGER_URL}${urlPath}`, init)
    res.status(upstream.status).json(await upstream.json())
  } catch (err) {
    // Reachable in normal operation: the manager is a separate supervisor program and may be
    // stopped or not yet deployed. The dashboard degrades to hiding the reboot controls, so
    // this must answer rather than hang.
    console.error(`[ui_backend] reboot manager ${urlPath} failed:`, err.message)
    res.status(503).json({ error: 'reboot manager unreachable' })
  }
}

app.get('/api/system/status', (_req, res) =>
  proxyToRebootManager(res, '/status'))

app.post('/api/system/reboot/:target', (req, res) => {
  // Allowlisted here as well as in the manager so an unknown target never reaches the host
  // service at all.
  const { target } = req.params
  if (!REBOOT_TARGETS.has(target)) {
    return res.status(400).json({ error: `unknown reboot target: ${target}` })
  }
  proxyToRebootManager(res, `/reboot/${target}`, { method: 'POST' })
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
