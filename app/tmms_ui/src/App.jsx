import { useState, useEffect, useRef } from 'react'
import { useRos } from './hooks/useRos'
import { useKeyboard } from './hooks/useKeyboard'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { CameraWidget } from './components/widgets/CameraWidget'
import { ThirdPersonWidget } from './components/widgets/ThirdPersonWidget'
import { QuadrupedWidget } from './components/widgets/QuadrupedWidget'
import { Z1ArmWidget } from './components/widgets/Z1ArmWidget'
import { ResizeHandle } from './components/ui/ResizeHandle'
import { RecordingsPage } from './components/RecordingsPage'

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')
  const [page, setPage] = useState('dashboard')

  useEffect(() => {
    document.documentElement.className = theme === 'light' ? 'light' : ''
    localStorage.setItem('theme', theme)
  }, [theme])

  // Resizable split state — fractions of available area
  const [camHeightPct, setCamHeightPct] = useState(0.65)
  const [topdownPct, setTopdownPct]     = useState(0.282)
  const [wristPct, setWristPct]         = useState(0.235)

  const mainRef   = useRef()  // area between header and footer
  const camRowRef = useRef()  // camera row container

  const { connected } = useRos()
  const { heldKeys }  = useKeyboard()

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        overflow: 'hidden',
      }}
    >
      {/* ── Header (52px) ── */}
      <Header
        connected={connected}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      {/* ── Main content (flex:1) ── */}
      <div
        ref={mainRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {page === 'dashboard' && (
        <>
        {/* ── Camera row ── */}
        <div
          ref={camRowRef}
          style={{
            height: `${camHeightPct * 100}%`,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'row',
            overflow: 'hidden',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {/* TopDown cam */}
          <div style={{ width: `${topdownPct * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
            <CameraWidget topicName="/topdown_cam/compressed" title="TOPDOWN 360°" />
          </div>

          <ResizeHandle
            direction="h"
            containerRef={camRowRef}
            onResize={setTopdownPct}
            min={0.12}
            max={0.40}
          />

          {/* 3rd person — fills remaining */}
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <ThirdPersonWidget />
          </div>

          <ResizeHandle
            direction="h"
            containerRef={camRowRef}
            onResize={(pct) => setWristPct(1 - pct)}
            min={0.60}
            max={0.88}
          />

          {/* Wrist cam */}
          <div style={{ width: `${wristPct * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
            <CameraWidget topicName="/wrist_cam/compressed" title="WRIST CAM" />
          </div>
        </div>

        {/* ── Vertical resize handle ── */}
        <ResizeHandle
          direction="v"
          containerRef={mainRef}
          onResize={setCamHeightPct}
          min={0.30}
          max={0.85}
        />

        {/* ── Control row (flex:1) ── */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'row',
            overflow: 'hidden',
          }}
        >
          {/* Z1 Arm — LEFT */}
          <div style={{ flex: 1, minWidth: 0, borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
            <Z1ArmWidget heldKeys={heldKeys} />
          </div>

          {/* Quadruped — RIGHT */}
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <QuadrupedWidget heldKeys={heldKeys} />
          </div>
        </div>
        </>
        )}

        {page === 'recordings' && <RecordingsPage />}
      </div>

      {/* ── Footer (40px) ── */}
      <Footer
        connected={connected}
        page={page}
        onNavigate={() => setPage((p) => (p === 'dashboard' ? 'recordings' : 'dashboard'))}
      />
    </div>
  )
}
