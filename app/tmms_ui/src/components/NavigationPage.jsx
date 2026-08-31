import { useKeyboard } from '../hooks/useKeyboard'
import { useTopicActivity } from '../hooks/useTopicActivity'
import { setQuadrupedPaused } from '../services/rosbridge'
import { LoadMapWidget } from './widgets/LoadMapWidget'
import { NavigationControlWidget } from './widgets/NavigationControlWidget'
import { QuadrupedWidget } from './widgets/QuadrupedWidget'

export function NavigationPage({ onNavigate }) {
  const { heldKeys } = useKeyboard()

  // Subscribed ONCE here and passed down. All three widgets below read from
  // quadruped_main_status, and three separate subscriptions to the same 5Hz topic would
  // both waste bandwidth and let the panels disagree with each other mid-transition.
  const { lastMsg: status } = useTopicActivity(
    '/quadruped_main_status', 'tmms_msgs/QuadrupedMainStatus', 1000
  )

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

      {/* Right 35%, split three ways */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: '32%', flexShrink: 0, overflow: 'hidden', borderBottom: '1px solid var(--border)' }}>
          <LoadMapWidget currentMap={currentMap} onNavigate={onNavigate} />
        </div>
        <div style={{ height: '36%', flexShrink: 0, overflow: 'hidden', borderBottom: '1px solid var(--border)' }}>
          <NavigationControlWidget
            currentMap={currentMap}
            localizationStatus={localizationStatus}
            navigationState={navigationState}
            isPaused={isPaused}
          />
        </div>
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
