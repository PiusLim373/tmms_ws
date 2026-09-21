import { publishThirdPersonCamControl } from '../../services/rosbridge'
import { CameraWidget } from './CameraWidget'

function CamBtn({ cmd, children, title }) {
  return (
    <button
      className="btn-icon px-2 py-0.5"
      title={title}
      style={{ fontSize: 11 }}
      onClick={(e) => {
        e.currentTarget.blur()
        publishThirdPersonCamControl(cmd)
      }}
    >
      {children}
    </button>
  )
}

// Physical camera angle — distinct from the widget's own zoom/pan, which only moves the
// decoded image around. These sit below the canvas so they stay clear of drag-to-pan.
function CamControls() {
  return (
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
  )
}

export function ThirdPersonWidget() {
  return (
    <CameraWidget
      topicName="/third_person_cam/compressed"
      title="3RD PERSON"
      footer={<CamControls />}
    />
  )
}
