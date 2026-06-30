import { useRef, useState } from 'react'

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Circular SVG joystick pad — ROS convention: x=forward, y=left
// x prop: forward/back (+x = forward = dot up)
// y prop: left/right  (+y = left   = dot left)
// hints: { up, down, left, right } — labels drawn at quadrant centers
// size: SVG width/height in px (default 160)
// maxValue: clamps drag output and scales display (default 1.0)
// xLabel/yLabel: labels for the value readout (default 'x'/'y')
// onChange(x, y): optional — enables drag/touch; springs back to 0,0 on release
export function JoystickDisplay({ x = 0, y = 0, label = '', hints, size = 160, maxValue = 1, xLabel = 'x', yLabel = 'y', onChange }) {
  const cx = size / 2
  const cy = size / 2
  const r  = size * 0.44
  const dotTravel = r * 0.82
  const dotRadius = size * 0.06
  const hintSize  = size * 0.090
  const qd        = r * 0.52

  // Normalize value into [-1,1] display range so knob fills full visual travel
  const normX = maxValue > 0 ? x / maxValue : 0
  const normY = maxValue > 0 ? y / maxValue : 0
  const dotX = cx - normY * dotTravel
  const dotY = cy - normX * dotTravel
  const isActive = Math.abs(x) > 0.01 || Math.abs(y) > 0.01

  const svgRef = useRef()
  const [dragging, setDragging] = useState(false)

  function toRosXY(clientX, clientY) {
    const rect = svgRef.current.getBoundingClientRect()
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    return {
      x: clamp((cy - sy) / dotTravel * maxValue, -maxValue, maxValue),
      y: clamp((cx - sx) / dotTravel * maxValue, -maxValue, maxValue),
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      {label && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-dim)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
      )}

      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{
          cursor: onChange ? 'crosshair' : 'default',
          touchAction: 'none',
          userSelect: 'none',
        }}
        onPointerDown={onChange ? (e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          const { x: rx, y: ry } = toRosXY(e.clientX, e.clientY)
          onChange(rx, ry)
        } : undefined}
        onPointerMove={onChange ? (e) => {
          if (!dragging) return
          const { x: rx, y: ry } = toRosXY(e.clientX, e.clientY)
          onChange(rx, ry)
        } : undefined}
        onPointerUp={onChange ? (e) => {
          if (!dragging) return
          setDragging(false)
          onChange(0, 0)
        } : undefined}
      >
        {/* Outer ring */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="var(--bg)"
          stroke="var(--border)"
          strokeWidth="1.5"
        />
        {/* Crosshairs */}
        <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke="var(--border)" strokeWidth="0.5" />
        <line x1={cx} y1={cy - r} x2={cx} y2={cy + r} stroke="var(--border)" strokeWidth="0.5" />
        {/* Inner dead-zone ring */}
        <circle cx={cx} cy={cy} r={size * 0.05} fill="none" stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2 2" />

        {/* Key hint labels — centered in each quadrant */}
        {hints && (
          <>
            <text x={cx} y={cy - qd}
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--text-dim)" fontSize={hintSize} fontFamily="var(--font-mono)">
              {hints.up}
            </text>
            <text x={cx} y={cy + qd}
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--text-dim)" fontSize={hintSize} fontFamily="var(--font-mono)">
              {hints.down}
            </text>
            <text x={cx - qd} y={cy}
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--text-dim)" fontSize={hintSize} fontFamily="var(--font-mono)">
              {hints.left}
            </text>
            <text x={cx + qd} y={cy}
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--text-dim)" fontSize={hintSize} fontFamily="var(--font-mono)">
              {hints.right}
            </text>
          </>
        )}

        {/* Dot */}
        <circle
          cx={dotX}
          cy={dotY}
          r={dotRadius}
          fill={isActive || dragging ? 'var(--accent-bright)' : 'var(--accent)'}
          style={{ transition: dragging ? 'none' : 'cx 0.05s, cy 0.05s' }}
        />
        {/* Center marker */}
        <circle cx={cx} cy={cy} r={size * 0.02} fill="var(--border)" />
      </svg>

      {/* Value readout */}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-dim)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>{xLabel}:</span>
        <span style={{ color: 'var(--text-h)', marginLeft: 2 }}>
          {x >= 0 ? '+' : ''}{x.toFixed(2)}
        </span>
        {'  '}
        <span>{yLabel}:</span>
        <span style={{ color: 'var(--text-h)', marginLeft: 2 }}>
          {y >= 0 ? '+' : ''}{y.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

// Interactive 1D axis knob — drag up/down (vertical) or left/right (horizontal)
// Springs to 0 on pointer release.
// maxValue: clamps output and scales display (default 1.0)
// trackLen: length of the track in px (default 80); match to paired joystick size
export function AxisKnob({ label, value = 0, onChange, orientation = 'v', maxValue = 1, trackLen = 80, hints }) {
  const isV        = orientation === 'v'
  const trackCross = 10
  const knobR      = 10
  const travel     = (trackLen - knobR * 2) / 2
  const isActive   = Math.abs(value) > 0.01

  const trackRef   = useRef()
  const [dragging, setDragging] = useState(false)

  const svgW = isV ? trackCross + knobR * 2 : trackLen
  const svgH = isV ? trackLen : trackCross + knobR * 2

  function toValue(clientX, clientY) {
    const rect = trackRef.current.getBoundingClientRect()
    if (isV) {
      const raw = -((clientY - rect.top - trackLen / 2) / travel) * maxValue
      return clamp(raw, -maxValue, maxValue)
    } else {
      const raw = ((clientX - rect.left - trackLen / 2) / travel) * maxValue
      return clamp(raw, -maxValue, maxValue)
    }
  }

  // Normalize to [-1,1] so knob always uses full visual travel
  const normVal = maxValue > 0 ? value / maxValue : 0

  const knobCx = isV ? svgW / 2 : trackLen / 2 + normVal * travel
  const knobCy = isV ? trackLen / 2 - normVal * travel : svgH / 2

  const fillProps = isV
    ? {
        x: svgW / 2 - 2, width: 4,
        ...(normVal >= 0
          ? { y: knobCy, height: svgH / 2 - knobCy }
          : { y: svgH / 2, height: knobCy - svgH / 2 }),
      }
    : {
        y: svgH / 2 - 2, height: 4,
        ...(normVal >= 0
          ? { x: svgW / 2, width: knobCx - svgW / 2 }
          : { x: knobCx, width: svgW / 2 - knobCx }),
      }

  return (
    <div
      className="flex flex-col items-center gap-0.5"
      style={isV ? { width: svgW + 8 } : { flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-dim)',
          letterSpacing: '0.06em',
          flexShrink: 0,
        }}
      >
        {label}
      </span>

      <svg
        ref={trackRef}
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{
          cursor: onChange ? (isV ? 'ns-resize' : 'ew-resize') : 'default',
          touchAction: 'none',
          userSelect: 'none',
          overflow: 'visible',
        }}
        onPointerDown={onChange ? (e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          onChange(toValue(e.clientX, e.clientY))
        } : undefined}
        onPointerMove={onChange ? (e) => {
          if (!dragging) return
          onChange(toValue(e.clientX, e.clientY))
        } : undefined}
        onPointerUp={onChange ? (e) => {
          if (!dragging) return
          setDragging(false)
          onChange(0)
        } : undefined}
      >
        {/* Track background */}
        <rect
          x={isV ? svgW / 2 - trackCross / 2 : 0}
          y={isV ? 0 : svgH / 2 - trackCross / 2}
          width={isV ? trackCross : svgW}
          height={isV ? svgH : trackCross}
          rx={3}
          fill="var(--bg)"
          stroke="var(--border)"
          strokeWidth="1"
        />
        {/* Center reference line — vertical tick at neutral position */}
        <line
          x1={svgW / 2} y1={0}
          x2={svgW / 2} y2={svgH}
          stroke="var(--border)"
          strokeWidth="0.5"
        />
        {/* Fill bar from center to knob */}
        {isActive && (
          <rect {...fillProps} fill="var(--accent)" />
        )}
        {/* Key hints — at ±50% travel so they stay visible most of the time */}
        {hints && isV && (
          <>
            <text x={svgW / 2} y={svgH / 2 - travel * 0.5}
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--text-dim)" fontSize={9} fontFamily="var(--font-mono)">
              {hints.up}
            </text>
            <text x={svgW / 2} y={svgH / 2 + travel * 0.5}
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--text-dim)" fontSize={9} fontFamily="var(--font-mono)">
              {hints.down}
            </text>
          </>
        )}
        {/* Knob */}
        <circle
          cx={knobCx}
          cy={knobCy}
          r={knobR}
          fill={isActive || dragging ? 'var(--accent-bright)' : 'var(--accent)'}
          stroke="var(--border)"
          strokeWidth="1"
          style={{ transition: dragging ? 'none' : 'cx 0.05s, cy 0.05s' }}
        />
      </svg>

      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-h)',
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
        }}
      >
        {value >= 0 ? '+' : ''}{value.toFixed(1)}
      </span>
    </div>
  )
}
