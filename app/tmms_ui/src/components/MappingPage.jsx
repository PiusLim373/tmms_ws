import { useKeyboard } from '../hooks/useKeyboard'
import { MappingToolWidget } from './widgets/MappingToolWidget'
import { QuadrupedWidget } from './widgets/QuadrupedWidget'

export function MappingPage() {
  const { heldKeys } = useKeyboard()

  // rosbridge is always launched with ssl=true (operation.launch.py), so it's
  // always wss:// regardless of the protocol this page itself loaded over.
  // The ds/ds.url query params make Lichtblick auto-connect on load instead
  // of requiring the operator to open the connection dialog manually.
  const rosbridgeUrl = `wss://${window.location.hostname}:9090`
  const lichtblickUrl = `http://${window.location.hostname}:8080/?ds=rosbridge-websocket&ds.url=${encodeURIComponent(rosbridgeUrl)}`

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {/* Left 60%: embedded Lichtblick */}
      <div style={{ width: '70%', flexShrink: 0, overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
        <iframe
          src={lichtblickUrl}
          title="Lichtblick"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>

      {/* Right 40%, split top/bottom 50/50 */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: '50%', flexShrink: 0, overflow: 'hidden', borderBottom: '1px solid var(--border)' }}>
          <MappingToolWidget />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <QuadrupedWidget heldKeys={heldKeys} />
        </div>
      </div>
    </div>
  )
}
