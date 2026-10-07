import { degFromYaw } from './lib/quat'

// Its own modal rather than the shared WarningModal: that one renders `body` as a sentence,
// and the whole point of confirming here is seeing the actual numbers before they leave.
export function ConfirmSendModal({
  open, navplanId, mapName, waypoints, robotStart, onConfirm, onCancel,
}) {
  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
      }}
      onClick={onCancel}
    >
      <div
        className="panel"
        style={{ width: 460, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">CONFIRM NAVIGATION PLAN</div>

        <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text)' }}>
          <div className="val-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            id {navplanId} · map {mapName} · {waypoints.length} waypoint
            {waypoints.length === 1 ? '' : 's'}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px' }}>
          <table
            className="val-mono"
            style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}
          >
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                <th style={{ padding: '4px 0' }}>#</th>
                <th>x (m)</th>
                <th>y (m)</th>
                <th>yaw</th>
              </tr>
            </thead>
            <tbody>
              {/* Where the route starts from, for reference. Not part of the plan and never
                  sent -- the dashed robot->wp1 link on the map is the same leg. */}
              <tr style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
                <td style={{ padding: '4px 0' }}>0</td>
                <td>{robotStart ? robotStart.x.toFixed(2) : '—'}</td>
                <td>{robotStart ? robotStart.y.toFixed(2) : '—'}</td>
                <td>
                  {robotStart && Number.isFinite(robotStart.yaw)
                    ? `${degFromYaw(robotStart.yaw).toFixed(0)}°`
                    : '—'}
                  <span style={{ marginLeft: 6, fontSize: 9 }}>robot · not sent</span>
                </td>
              </tr>
              {waypoints.map((w, i) => {
                const isLast = i === waypoints.length - 1
                return (
                  <tr
                    key={i}
                    style={{
                      borderTop: '1px solid var(--border)',
                      color: isLast ? 'var(--text-h)' : 'var(--text)',
                    }}
                  >
                    <td style={{ padding: '4px 0' }}>
                      {i + 1}
                      {w.label && <span style={{ marginLeft: 6, color: '#3B82F6' }}>{w.label}</span>}
                    </td>
                    <td>{w.x.toFixed(2)}</td>
                    <td>{w.y.toFixed(2)}</td>
                    <td>
                      {w.yaw == null
                        ? <span style={{ color: 'var(--text-dim)' }}>—</span>
                        : `${degFromYaw(w.yaw).toFixed(0)}°`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Stated rather than silently ignored: NavFn plans on a grid and discards
              orientation, and RemovePassedGoals drops intermediate waypoints at 0.7m before
              any goal checker sees them. Only the last heading is actually enforced. */}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', margin: '8px 0' }}>
            Only the final heading is enforced. Intermediate headings are ignored by the
            planner and those waypoints are pruned once the robot passes within 0.7 m.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: 12,
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="btn-icon px-4 py-1.5 text-xs" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button
            className="px-4 py-1.5 text-xs"
            style={{
              borderRadius: 4,
              border: 'none',
              background: 'var(--accent-bright)',
              color: '#fff',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
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
