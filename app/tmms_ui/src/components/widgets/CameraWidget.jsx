import { useRef, useEffect, useState, useCallback } from 'react'
import { subscribeCamera } from '../../services/rosbridge'

function decodeCompressedImage(msg, canvas) {
  const { data: b64, format } = msg
  if (!b64) return
  const mimeType = format && format.includes('png') ? 'image/png' : 'image/jpeg'
  const img = new window.Image()
  img.onload = () => {
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width
      canvas.height = img.height
    }
    canvas.getContext('2d').drawImage(img, 0, 0)
  }
  img.src = `data:${mimeType};base64,${b64}`
}

function decodeRosImage(msg, canvas) {
  const { width, height, encoding, data: b64 } = msg
  if (!width || !height || !b64) return

  const binStr = atob(b64)
  const bytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i)

  const imageData = new ImageData(width, height)
  const rgba = imageData.data

  if (encoding === 'rgb8') {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4]     = bytes[i * 3]
      rgba[i * 4 + 1] = bytes[i * 3 + 1]
      rgba[i * 4 + 2] = bytes[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
  } else if (encoding === 'bgr8') {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4]     = bytes[i * 3 + 2]
      rgba[i * 4 + 1] = bytes[i * 3 + 1]
      rgba[i * 4 + 2] = bytes[i * 3]
      rgba[i * 4 + 3] = 255
    }
  } else if (encoding === 'mono8') {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = bytes[i]
      rgba[i * 4 + 3] = 255
    }
  } else if (encoding === 'bgra8') {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4]     = bytes[i * 4 + 2]
      rgba[i * 4 + 1] = bytes[i * 4 + 1]
      rgba[i * 4 + 2] = bytes[i * 4]
      rgba[i * 4 + 3] = bytes[i * 4 + 3]
    }
  } else if (encoding === 'rgba8') {
    rgba.set(bytes.subarray(0, width * height * 4))
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  canvas.getContext('2d').putImageData(imageData, 0, 0)
}

// Shared hook — re-used by ThirdPersonWidget
export function useCameraFeed(topicName) {
  const canvasRef     = useRef(null)
  const pendingRef    = useRef(null)
  const rafRef        = useRef(null)
  const [active, setActive] = useState(false)
  const [fps, setFps]       = useState(0)
  const frameTimesRef = useRef([])
  const isCompressed  = topicName.endsWith('/compressed')

  const drawPending = useCallback(() => {
    rafRef.current = null
    const msg = pendingRef.current
    if (msg && canvasRef.current) {
      isCompressed ? decodeCompressedImage(msg, canvasRef.current) : decodeRosImage(msg, canvasRef.current)
      const now = Date.now()
      frameTimesRef.current.push(now)
      frameTimesRef.current = frameTimesRef.current.filter((t) => now - t < 1000)
      setFps(frameTimesRef.current.length)
    }
  }, [])

  useEffect(() => {
    const unsub = subscribeCamera(topicName, (msg) => {
      pendingRef.current = msg
      setActive(true)
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(drawPending)
      }
    })
    return () => {
      unsub()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [topicName, drawPending])

  return { canvasRef, active, fps }
}

function NoSignal({ topicName }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 w-full h-full"
      style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
    >
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="6" width="20" height="14" rx="2" />
        <line x1="2" y1="2" x2="22" y2="22" />
      </svg>
      <span>NO SIGNAL</span>
      <span style={{ fontSize: 9, color: 'var(--border)' }}>{topicName}</span>
    </div>
  )
}

export function CameraWidget({ topicName, title, className = '' }) {
  const { canvasRef, active, fps } = useCameraFeed(topicName)

  return (
    <div
      className={`panel flex flex-col h-full ${className}`}
      style={{ overflow: 'hidden' }}
    >
      <div className="panel-header">
        <span>{title}</span>
        <div className="flex items-center gap-2">
          {active && (
            <span style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
              {fps} fps
            </span>
          )}
          <span
            style={{
              width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
              background: active ? '#22C55E' : 'var(--border)',
            }}
          />
        </div>
      </div>
      <div className="flex items-center justify-center flex-1" style={{ background: '#000', overflow: 'hidden', minHeight: 0 }}>
        {active
          ? <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }} />
          : <NoSignal topicName={topicName} />
        }
      </div>
    </div>
  )
}
