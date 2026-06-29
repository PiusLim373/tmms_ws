import { callService } from '../../services/rosbridge'
import { useCameraFeed } from './CameraWidget'

function CamBtn({ cmd, children, title }) {
  return (
    <button
      className="btn-icon px-2 py-0.5"
      title={title}
      style={{ fontSize: 11 }}
      onClick={(e) => {
        e.currentTarget.blur()
        callService('/third_person_cam_control', cmd, null, null)
      }}
    >
      {children}
    </button>
  )
}

export function ThirdPersonWidget() {
  const { canvasRef, active, fps } = useCameraFeed('/thrid_person_cam')

  return (
    <div className="panel flex flex-col h-full" style={{ overflow: 'hidden' }}>
      {/* Title bar */}
      <div className="panel-header">
        <span>3RD PERSON</span>
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

      {/* Camera canvas */}
      <div
        className="flex items-center justify-center flex-1"
        style={{ background: '#000', overflow: 'hidden', minHeight: 0 }}
      >
        {active ? (
          <canvas
            ref={canvasRef}
            style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
          />
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-2"
            style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="6" width="20" height="14" rx="2" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
            <span>NO SIGNAL</span>
            <span style={{ fontSize: 9, color: 'var(--border)' }}>/thrid_person_cam</span>
          </div>
        )}
      </div>

      {/* Camera angle controls */}
      <div
        className="flex items-center justify-center gap-4 flex-shrink-0 px-3"
        style={{
          height: 36,
          borderTop: '1px solid var(--border)',
          background: 'var(--panel-bg)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-dim)',
            letterSpacing: '0.06em',
          }}
        >
          CAM CTRL
        </span>
        <div className="flex items-center gap-1">
          <CamBtn cmd="pitch+" title="Pitch up">▲</CamBtn>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>PITCH</span>
          <CamBtn cmd="pitch-" title="Pitch down">▼</CamBtn>
        </div>
        <div className="flex items-center gap-1">
          <CamBtn cmd="yaw-" title="Yaw left">◄</CamBtn>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>YAW</span>
          <CamBtn cmd="yaw+" title="Yaw right">►</CamBtn>
        </div>
        <div className="flex items-center gap-1">
          <CamBtn cmd="z+" title="Height up">▲</CamBtn>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>HEIGHT</span>
          <CamBtn cmd="z-" title="Height down">▼</CamBtn>
        </div>
      </div>
    </div>
  )
}
