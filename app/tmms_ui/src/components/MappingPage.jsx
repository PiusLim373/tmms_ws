import { useEffect, useRef, useState } from 'react'
import { useKeyboard } from '../hooks/useKeyboard'
import { MappingToolWidget } from './widgets/MappingToolWidget'
import { QuadrupedWidget } from './widgets/QuadrupedWidget'
import { ResizeHandle } from './ui/ResizeHandle'

// One Lichtblick layout per sub-view: the 3D tab wants the raw mapping view, the 2D tab wants
// the flattening view (the grid and the sliced cloud) that the tuning sliders drive.
const LAYOUTS = {
  maps3d: 'mapping_layout.json',
  maps2d: 'mapping_editor_layout.json',
}
// Which tab the operator was last on. Owned here rather than in the widget because the iframe
// URL is derived from it — restoring it inside the widget instead would mean this page renders
// the 3D layout on first paint and then swaps, costing a whole extra Lichtblick boot every time
// the page is opened on the 2D tab.
const SUBVIEW_KEY = 'tmms.mapping.subView'

export function MappingPage() {
  const { heldKeys } = useKeyboard()

  // Validated against LAYOUTS rather than trusted: a stale or hand-edited key would otherwise
  // build a layoutUrl ending in "undefined" and Lichtblick would come up with no layout at all.
  const [subView, setSubView] = useState(() => {
    const saved = localStorage.getItem(SUBVIEW_KEY)
    return LAYOUTS[saved] ? saved : 'maps3d'
  })
  useEffect(() => { localStorage.setItem(SUBVIEW_KEY, subView) }, [subView])

  // Height split between the mapping tool and the teleop widget, so the operator can give
  // whichever one they are actually using the room. Not persisted — same as the dashboard's
  // splits in App.jsx.
  const rightColRef = useRef(null)
  const [toolPct, setToolPct] = useState(0.5)

  // rosbridge is always launched with ssl=true (operation.launch.py), so it's
  // always wss:// regardless of the protocol this page itself loaded over.
  // The ds/ds.url query params make Lichtblick auto-connect on load instead
  // of requiring the operator to open the connection dialog manually.
  const rosbridgeUrl = `wss://${window.location.hostname}:9090`
  // layoutUrl re-fetches and re-applies the layout on every load, overriding whatever is cached
  // in the browser so this page always opens with the panel setup for the current sub-view
  // (see tmms_lichtblick-compose.yaml, which mounts each layout file individually).
  const layoutUrl = `http://${window.location.hostname}:8080/layouts/${LAYOUTS[subView]}`
  const lichtblickUrl = `http://${window.location.hostname}:8080/?ds=rosbridge-websocket&ds.url=${encodeURIComponent(rosbridgeUrl)}&layoutUrl=${encodeURIComponent(layoutUrl)}`

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {/* Left 65%: embedded Lichtblick. Keyed on the URL so a layout change REMOUNTS the iframe
          rather than reassigning its src — assigning src pushes an entry onto the iframe's
          session history, and browser Back then walks back through stale layouts. */}
      <div style={{ width: '65%', flexShrink: 0, overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
        <iframe
          key={lichtblickUrl}
          src={lichtblickUrl}
          title="Lichtblick"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>

      {/* Right 35%, split top/bottom by the drag handle */}
      <div
        ref={rightColRef}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ height: `${toolPct * 100}%`, flexShrink: 0, overflow: 'hidden' }}>
          <MappingToolWidget subView={subView} onSubViewChange={setSubView} />
        </div>

        <ResizeHandle
          direction="v"
          containerRef={rightColRef}
          onResize={setToolPct}
          min={0.2}
          max={0.9}
        />

        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <QuadrupedWidget heldKeys={heldKeys} />
        </div>
      </div>
    </div>
  )
}
