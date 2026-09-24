import { useRef, useState } from 'react'
import { useKeyboard } from '../hooks/useKeyboard'
import { setQuadrupedPaused } from '../services/rosbridge'
import { ResizeHandle } from './ui/ResizeHandle'
import { LoadMapWidget } from './widgets/LoadMapWidget'
import { NavigationControlWidget } from './widgets/NavigationControlWidget'
import { QuadrupedWidget } from './widgets/QuadrupedWidget'

// Smallest share of the column either of the top two widgets may be squeezed to.
const MIN_SPAN = 0.12

export function NavigationPage({ onNavigate, status }) {
  const { heldKeys } = useKeyboard()

  // Boundary offsets from the top of the column, not per-widget heights: ResizeHandle reports
  // an absolute fraction of its container, so storing boundaries lets each handle write its
  // own state directly. Not persisted — same as Mapping and the dashboard's splits.
  const rightColRef = useRef(null)
  const [mapEnd, setMapEnd] = useState(0.32)   // bottom of LoadMapWidget
  const [navEnd, setNavEnd] = useState(0.55)   // bottom of NavigationControlWidget

  // quadruped_main_status arrives as a prop from App, which subscribes once for the whole
  // app: every page needs it, and separate subscriptions to the same 5Hz topic would both
  // waste bandwidth and let the panels disagree with each other mid-transition.
  const isPaused = status?.is_paused ?? true   // assume paused until told otherwise
  const currentMap = status?.current_map ?? ''
  const localizationStatus = status?.localization_status ?? ''
  const navigationState = status?.navigation_state ?? ''

  // rosbridge is always launched with ssl=true (operation.launch.py), so it's always
  // wss:// regardless of the protocol this page itself loaded over. The ds/ds.url query
  // params make Lichtblick auto-connect on load instead of requiring the operator to open
  // the connection dialog manually.
  const rosbridgeUrl = `wss://${window.location.hostname}:9090`
  // layoutUrl re-fetches and re-applies navigation_layout.json on every load, overriding
  // whatever layout is cached in the browser so this page always opens with the
  // navigation-specific panel setup (see tmms_lichtblick-compose.yaml).
  const layoutUrl = `http://${window.location.hostname}:8080/layouts/navigation_layout.json`
  const lichtblickUrl = `http://${window.location.hostname}:8080/?ds=rosbridge-websocket&ds.url=${encodeURIComponent(rosbridgeUrl)}&layoutUrl=${encodeURIComponent(layoutUrl)}`

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {/* Left 65%: embedded Lichtblick — where the initial pose and nav goals are set */}
      <div style={{ width: '65%', flexShrink: 0, overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
        <iframe
          src={lichtblickUrl}
          title="Lichtblick"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>

      {/* Right 35%, split three ways by two drag handles */}
      <div
        ref={rightColRef}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ height: `${mapEnd * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
          <LoadMapWidget currentMap={currentMap} onNavigate={onNavigate} />
        </div>

        {/* The cross-clamp lives here rather than in the handle's min/max, which are static
            constants and so cannot know where the other boundary currently sits. */}
        <ResizeHandle
          direction="v"
          containerRef={rightColRef}
          onResize={(pct) => setMapEnd(Math.min(pct, navEnd - MIN_SPAN))}
          min={MIN_SPAN}
          max={0.8}
        />

        <div style={{ height: `${(navEnd - mapEnd) * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
          <NavigationControlWidget
            currentMap={currentMap}
            localizationStatus={localizationStatus}
            navigationState={navigationState}
            isPaused={isPaused}
          />
        </div>

        <ResizeHandle
          direction="v"
          containerRef={rightColRef}
          onResize={(pct) => setNavEnd(Math.max(pct, mapEnd + MIN_SPAN))}
          min={0.2}
          max={1 - MIN_SPAN}
        />

        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <QuadrupedWidget
            heldKeys={heldKeys}
            blocked={!isPaused}
            onPause={() => setQuadrupedPaused(true)}
            onNavigateDashboard={() => onNavigate?.('dashboard')}
          />
        </div>
      </div>
    </div>
  )
}
