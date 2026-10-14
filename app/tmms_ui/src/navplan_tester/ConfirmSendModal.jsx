import { quaternionToYaw } from '../lib/c2Coords'
import { degFromYaw } from './lib/quat'
import { TYPE_LABEL } from './lib/routePlan'
import { SWITCH_TEXT } from './lib/routeStyle'

const deg = (q) => `${degFromYaw(quaternionToYaw(q)).toFixed(0)}°`

// Its own modal rather than the shared WarningModal: that one renders `body` as a sentence,
// and the whole point of confirming here is seeing the actual numbers before they leave.
// Shows the tmms_msgs/Waypoint list exactly as it will be sent.
export function ConfirmSendModal({ open, navplanId, waypoints, robotStart, onConfirm, onCancel }) {
  if (!open) return null

  const maps = waypoints.length
    ? [waypoints[0].map_name, ...waypoints.filter((w) => w.new_map_name).map((w) => w.new_map_name)]
    : []

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 80, display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)',
      }}
      onClick={onCancel}
    >
      <div
        className="panel"
        style={{ width: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">CONFIRM NAVIGATION PLAN</div>

        <div className="val-mono" style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-dim)' }}>
          id {navplanId} · {waypoints.length} waypoint{waypoints.length === 1 ? '' : 's'}
          {' '}· {maps.join(' → ')}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px' }}>
          <table className="val-mono" style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                <th style={{ padding: '4px 0' }}>#</th>
                <th>map</th>
                <th>type</th>
                <th>x (m)</th>
                <th>y (m)</th>
                <th>yaw</th>
              </tr>
            </thead>
            <tbody>
              {/* Where the route starts from, for reference only. */}
              <tr style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
                <td style={{ padding: '4px 0' }}>0</td>
                <td colSpan={2}>robot · not sent</td>
                <td>{robotStart ? robotStart.x.toFixed(2) : '—'}</td>
                <td>{robotStart ? robotStart.y.toFixed(2) : '—'}</td>
                <td>
                  {robotStart && Number.isFinite(robotStart.yaw)
                    ? `${degFromYaw(robotStart.yaw).toFixed(0)}°` : '—'}
                </td>
              </tr>
              {waypoints.map((w, i) => {
                const p = w.pose.position
                const q = w.new_map_pose
                return [
                  <tr
                    key={`w${w.id}`}
                    style={{
                      borderTop: '1px solid var(--border)',
                      color: i === waypoints.length - 1 ? 'var(--text-h)' : 'var(--text)',
                    }}
                  >
                    <td style={{ padding: '4px 0' }}>{w.id}</td>
                    <td>{w.map_name}</td>
                    <td style={{ color: w.type === 'map_switch' ? SWITCH_TEXT : undefined }}>
                      {TYPE_LABEL[w.type]}
                    </td>
                    <td>{p.x.toFixed(2)}</td>
                    <td>{p.y.toFixed(2)}</td>
                    <td>{w.type === 'simple' ? '—' : deg(w.pose.orientation)}</td>
                  </tr>,
                  w.type === 'map_switch' && (
                    <tr key={`n${w.id}`} style={{ color: SWITCH_TEXT }}>
                      <td />
                      <td colSpan={2} style={{ paddingBottom: 4 }}>↳ relocalize on {w.new_map_name}</td>
                      <td>{q.position.x.toFixed(2)}</td>
                      <td>{q.position.y.toFixed(2)}</td>
                      <td>{deg(q.orientation)}</td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>

          {/* Stated rather than silently ignored: NavFn plans on a grid and discards
              orientation, and RemovePassedGoals drops intermediate waypoints at 0.7m before
              any goal checker sees them. Only each segment's last heading is enforced. */}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', margin: '8px 0' }}>
            Only the heading at the end of each map is enforced: at a map switch, and at the
            last waypoint. Intermediate waypoints are pruned once the robot passes within 0.7 m.
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn-icon px-4 py-1.5 text-xs" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button
            className="px-4 py-1.5 text-xs"
            style={{
              borderRadius: 4, border: 'none', background: 'var(--accent-bright)', color: '#fff',
              fontFamily: 'var(--font-mono)', cursor: 'pointer',
            }}
            onClick={onConfirm}
          >
            Send ▶
          </button>
        </div>
      </div>
    </div>
  )
}
