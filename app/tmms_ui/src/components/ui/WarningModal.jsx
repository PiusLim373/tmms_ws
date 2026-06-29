const TRANSITION_MESSAGES = {
  '1→2': { title: 'Robot will stand up', body: 'Ensure clear area around the robot. All personnel should stand back.' },
  '2→3': { title: 'Entering locomotion mode', body: 'Keep personnel clear of movement path. Robot will begin walking.' },
  '3→2': { title: 'Robot will stop locomotion', body: 'Robot will lock joints and stop walking.' },
  '2→1': { title: 'Robot will sit down', body: 'Ensure ground is clear below the robot.' },
}

export function WarningModal({ open, fromMode, toMode, onConfirm, onCancel }) {
  if (!open) return null

  const key = `${fromMode}→${toMode}`
  const msg = TRANSITION_MESSAGES[key] ?? { title: 'Mode change', body: 'Keep the area clear.' }

  const MODE_LABELS = { 1: 'SIT', 2: 'STAND LOCK', 3: 'WALK' }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="rounded-lg p-6 w-80 flex flex-col gap-4"
        style={{
          background: 'var(--panel-bg)',
          border: '1px solid var(--accent)',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2">
          <span style={{ color: '#EF4444', fontSize: 18 }}>⚠</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
            }}
          >
            MODE CHANGE WARNING
          </span>
        </div>

        {/* Transition label */}
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--text-h)',
          }}
        >
          {MODE_LABELS[fromMode]} → {MODE_LABELS[toMode]}
        </div>

        {/* Message */}
        <div style={{ fontSize: 13, color: 'var(--text)' }}>
          <strong style={{ color: 'var(--text-h)' }}>{msg.title}.</strong>
          <br />
          {msg.body}
        </div>

        {/* Buttons */}
        <div className="flex gap-3 justify-end mt-1">
          <button
            className="btn-icon px-4 py-1.5 text-xs"
            onClick={onCancel}
            autoFocus
          >
            Cancel
          </button>
          <button
            className="px-4 py-1.5 rounded text-xs font-medium"
            style={{
              background: 'var(--accent-bright)',
              color: '#fff',
              fontFamily: 'var(--font-mono)',
              border: 'none',
              cursor: 'pointer',
            }}
            onClick={onConfirm}
          >
            Confirm ▶
          </button>
        </div>
      </div>
    </div>
  )
}
