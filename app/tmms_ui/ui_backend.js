import express from 'express'
import cors from 'cors'

const PORT = 3001
const app = express()

app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

// Scaffold: future telemetry / logging endpoint
app.post('/api/log', (req, res) => {
  console.log('[ui_backend] log:', req.body)
  res.json({ received: true })
})

app.listen(PORT, () => {
  console.log(`[ui_backend] listening on http://localhost:${PORT}`)
})
