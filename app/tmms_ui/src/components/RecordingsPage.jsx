import { useEffect, useState } from 'react'
import { VideoExportModal } from './ui/VideoExportModal'

// Absolute URL (not relative) because these are handed off to something
// else -- pasted into Lichtblick's Remote file dialog, or navigated to
// directly for a download -- so they must resolve correctly regardless
// of how the operator reached tmms_ui (localhost, LAN IP, hostname).
const bagFileUrl = (filename) => `http://${window.location.hostname}:3001/api/bags/${filename}`

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

// Both `tmms_<ts>.mcap` (renamed from actual start time) and
// `tmms_<ts>_<index>.mcap` (kept its original chunk name because
// rotation couldn't read a start time) share this same datetime prefix.
// Constructed from local wall-clock components and later read back with
// local getters (formatDateTime) -- symmetric, so no timezone shift.
function parseRecordedAt(filename) {
  const m = filename.match(/^tmms_(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})_(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
}

function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatTimeAgo(date) {
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hr ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
}

async function downloadBlobResponse(response, fallbackName) {
  const disposition = response.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : fallbackName

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function RecordingsPage() {
  const [files, setFiles] = useState([])
  const [copiedFile, setCopiedFile] = useState(null)
  const [exportTarget, setExportTarget] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)

  useEffect(() => {
    fetch('/api/bags')
      .then((r) => r.json())
      .then(setFiles)
      .catch((err) => console.error('[RecordingsPage] failed to list bags:', err))
  }, [])

  function copyText(text) {
    if (navigator.clipboard) {
      return navigator.clipboard.writeText(text)
    }
    // navigator.clipboard is only available in secure contexts (HTTPS, or
    // literally "localhost") -- the robot is served over plain HTTP from a
    // LAN IP, which doesn't qualify, so fall back to the old
    // execCommand('copy') trick via a throwaway offscreen textarea.
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }

  function handleCopyLink(filename) {
    setSelectedFile(filename)
    copyText(bagFileUrl(filename))
    setCopiedFile(filename)
    setTimeout(() => setCopiedFile((f) => (f === filename ? null : f)), 1500)
  }

  async function handleExportConfirm(topics) {
    const filename = exportTarget
    setExporting(true)
    try {
      const response = await fetch(`/api/bags/${filename}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topics }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `request failed (${response.status})`)
      }
      await downloadBlobResponse(response, `${filename}_videos`)
      setExportTarget(null)
    } catch (err) {
      console.error('[RecordingsPage] video export failed:', err)
      alert(`Video export failed: ${err.message}`)
    } finally {
      setExporting(false)
    }
  }

  const lichtblickUrl = `http://${window.location.hostname}:8080`

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {/* Left: file list */}
      <div
        className="panel"
        style={{ width: '17%', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid var(--border)' }}
      >
        <div className="panel-header">Recordings</div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {files.length === 0 && (
            <div style={{ padding: 12, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
              No recordings found.
            </div>
          )}
          {[...files].reverse().map(({ filename, sizeBytes }) => {
            const isSelected = filename === selectedFile
            const recordedAt = parseRecordedAt(filename)
            return (
              <div
                key={filename}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border)',
                  borderLeft: isSelected ? '3px solid var(--accent-bright)' : '3px solid transparent',
                  background: isSelected ? 'color-mix(in srgb, var(--accent-bright) 18%, transparent)' : 'transparent',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-h)', wordBreak: 'break-all' }}>
                  {filename}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
                  {recordedAt && `${formatDateTime(recordedAt)} | ${formatTimeAgo(recordedAt)} | `}{formatBytes(sizeBytes)}
                </div>
                <div className="flex flex-wrap" style={{ gap: 6 }}>
                  <button className="btn-icon" style={{ fontSize: 11, padding: '4px 7px' }} onClick={() => handleCopyLink(filename)}>
                    {copiedFile === filename ? '✓ Copied' : '🔗 Copy link'}
                  </button>
                  <a
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '4px 7px', textDecoration: 'none' }}
                    href={bagFileUrl(filename)}
                    download={filename}
                    onClick={() => setSelectedFile(filename)}
                  >
                    ⬇ Download .mcap
                  </a>
                  <button
                    className="btn-icon"
                    style={{ fontSize: 11, padding: '4px 7px' }}
                    onClick={() => { setSelectedFile(filename); setExportTarget(filename) }}
                  >
                    🎬 Videos
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Right: embedded Lichtblick */}
      <div style={{ width: '80%', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <iframe
          src={lichtblickUrl}
          title="Lichtblick"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>

      <VideoExportModal
        open={exportTarget !== null}
        filename={exportTarget}
        busy={exporting}
        onConfirm={handleExportConfirm}
        onCancel={() => setExportTarget(null)}
      />
    </div>
  )
}
