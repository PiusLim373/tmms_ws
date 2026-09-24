import { useState, useEffect, useRef } from 'react'
import { useRos } from './hooks/useRos'
import { useKeyboard } from './hooks/useKeyboard'
import { useTopicActivity } from './hooks/useTopicActivity'
import { setQuadrupedPaused } from './services/rosbridge'
import { Header } from './components/Header'
import { Footer } from './components/Footer'
import { CameraWidget } from './components/widgets/CameraWidget'
import { QuadrupedWidget } from './components/widgets/QuadrupedWidget'
import { Z1ArmWidget } from './components/widgets/Z1ArmWidget'
import { ResizeHandle } from './components/ui/ResizeHandle'
import { RecordingsPage } from './components/RecordingsPage'
import { MappingPage } from './components/MappingPage'
import { NavigationPage } from './components/NavigationPage'

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark')
  const [page, setPage] = useState('dashboard')

  useEffect(() => {
    document.documentElement.className = theme === 'light' ? 'light' : ''
    localStorage.setItem('theme', theme)
  }, [theme])

  // Resizable split state — fractions of available area
  const [topdownPct, setTopdownPct] = useState(0.20)   // left column width
  const [wristPct, setWristPct]     = useState(0.55)   // wrist cam height, right column
  const [z1Pct, setZ1Pct]           = useState(0.55)   // Z1 width, bottom row

  const dashRef      = useRef()  // dashboard row
  const rightColRef  = useRef()  // wrist cam over the control row
  const bottomRowRef = useRef()  // Z1 + quadruped

  const { connected } = useRos()
  const { heldKeys }  = useKeyboard()

  // Subscribed ONCE for the whole app and passed down. Pages unmount on every tab switch, so
  // a page-level subscription cannot keep the teleop-blocked state consistent across tabs —
  // the dashboard would show a live-looking quadruped panel whose commands the controller is
  // silently refusing. Hoisting it also keeps the header's battery reading in step.
  const { active: statusActive, lastMsg: status } = useTopicActivity(
    '/quadruped_main_status', 'tmms_msgs/QuadrupedMainStatus', 1000
  )

  const isPaused = status?.is_paused ?? true   // assume paused until told otherwise
  const battery = statusActive ? status?.battery_percentage : undefined

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
        battery={battery}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      {/* ── Main content (flex:1) ── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {page === 'dashboard' && (
        <div
          ref={dashRef}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'row',
            overflow: 'hidden',
          }}
        >
          {/* TopDown — full height, LEFT */}
          <div style={{ width: `${topdownPct * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
            <CameraWidget topicName="/topdown_cam/compressed" title="TOPDOWN" />
          </div>

          <ResizeHandle
            direction="h"
            containerRef={dashRef}
            onResize={setTopdownPct}
            min={0.18}
            max={0.55}
          />

          {/* RIGHT — wrist cam over the two control widgets */}
          <div
            ref={rightColRef}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ height: `${wristPct * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
              <CameraWidget topicName="/wrist_cam/compressed" title="WRIST CAM" />
            </div>

            <ResizeHandle
              direction="v"
              containerRef={rightColRef}
              onResize={setWristPct}
              min={0.15}
              max={0.75}
            />

            <div
              ref={bottomRowRef}
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'row',
                overflow: 'hidden',
              }}
            >
              <div style={{ width: `${z1Pct * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
                <Z1ArmWidget heldKeys={heldKeys} />
              </div>

              <ResizeHandle
                direction="h"
                containerRef={bottomRowRef}
                onResize={setZ1Pct}
                min={0.2}
                max={0.8}
              />

              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <QuadrupedWidget
                  heldKeys={heldKeys}
                  blocked={!isPaused}
                  onPause={() => setQuadrupedPaused(true)}
                />
              </div>
            </div>
          </div>
        </div>
        )}

        {page === 'recordings' && <RecordingsPage />}

        {page === 'mapping' && <MappingPage isPaused={isPaused} />}

        {page === 'navigation' && <NavigationPage onNavigate={setPage} status={status} />}
      </div>

      {/* ── Footer (40px) ── */}
      <Footer
        connected={connected}
        page={page}
        onNavigate={setPage}
      />
    </div>
  )
}
