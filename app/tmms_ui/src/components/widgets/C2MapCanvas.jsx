import { useCallback, useEffect, useRef, useState } from 'react'
import { useThemeTick } from '../../hooks/useThemeTick'
import { screenToWorld, worldToScreen } from '../../lib/c2Coords'
import { displayName, displayNumber, effectiveYaw, HEADING_TYPES } from '../../lib/c2Pins'

const MIN_ZOOM = 0.05
const GLIDE_MS = 200
const GLIDE_MAX_JUMP_M = 2
const ROBOT_MIN_PX = 34
const ROBOT_IMG_SRC = '/b2_top.png'
const ROBOT_IMG_W_M = 1.5
const ROBOT_IMG_H_M = 0.8
const ROBOT_LEN_M = 1.08
const MAX_ZOOM = 40

const PIN_HIT_PX = 18
const HANDLE_HIT_PX = 11
const HANDLE_ORBIT_PX = 48

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function readColors() {
  const css = getComputedStyle(document.documentElement)
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback
  return {
    unknown: v('--map-unknown', '#0D0812'),
    border: v('--border', '#2D1F42'),
    accent: v('--accent-bright', '#7C3AED'),
    robot: v('--robot-marker', '#22D3EE'),
    action: v('--pin-poi', '#DC2626'),
    simple: v('--pin-simple', '#1D4ED8'),
    home: v('--pin-home', '#34D399'),
    pose: v('--robot-marker', '#22D3EE'),
  }
}

export function C2MapCanvas({
  info, image, pins, selectedId, placingType, editable = true, view, robot,
  onViewChange, onPlace, onSelect, onMovePin, onSetYaw, onRename, onHover, onSizeChange,
  drawUnder, onEmptyClick, showNames = true,
}) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [cursor, setCursor] = useState('grab')
  const themeTick = useThemeTick()
  const dragRef = useRef(null)
  const lastPlaceRef = useRef(null)
  const chipRectsRef = useRef(new Map())

  const [robotImg, setRobotImg] = useState(null)
  useEffect(() => {
    const img = new Image()
    img.onload = () => setRobotImg(img)
    img.src = ROBOT_IMG_SRC
  }, [])

  const [shownRobot, setShownRobot] = useState(robot)
  const shownRef = useRef(robot)
  useEffect(() => {
    const show = (r) => { shownRef.current = r; setShownRobot(r) }
    const from = shownRef.current
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!robot?.position || !from?.position || reduce
        || Math.hypot(robot.position.x - from.position.x, robot.position.y - from.position.y) > GLIDE_MAX_JUMP_M) {
      show(robot)
      return undefined
    }
    const t0 = performance.now()
    const dYaw = robot.yaw != null && from.yaw != null
      ? Math.atan2(Math.sin(robot.yaw - from.yaw), Math.cos(robot.yaw - from.yaw))
      : 0
    let frame = 0
    const step = (now) => {
      const t = Math.min(1, (now - t0) / GLIDE_MS)
      show({
        ...robot,
        position: {
          x: from.position.x + (robot.position.x - from.position.x) * t,
          y: from.position.y + (robot.position.y - from.position.y) * t,
        },
        yaw: robot.yaw != null && from.yaw != null ? from.yaw + dYaw * t : robot.yaw,
      })
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [robot])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const fit = () => {
      const rect = el.getBoundingClientRect()
      const next = { width: Math.max(1, Math.floor(rect.width)), height: Math.max(1, Math.floor(rect.height)) }
      setSize(next)
      onSizeChange?.(next)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [onSizeChange])

  const toScreen = useCallback((wx, wy) => worldToScreen(wx, wy, info, view), [info, view])
  const toWorld = useCallback((sx, sy) => screenToWorld(sx, sy, info, view), [info, view])
  // The map can be turned on screen (view.rot); a world heading is drawn turned with it.
  const rot = view.rot ?? 0
  const localPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const hitTest = useCallback((pt) => {
    if (!info) return null

    const selected = pins.find((p) => p.id === selectedId)
    if (editable && selected && HEADING_TYPES.has(selected.type)) {
      const c = toScreen(selected.x, selected.y)
      const yaw = (effectiveYaw(selected) ?? 0) - rot
      const hx = c.x + Math.cos(-yaw) * HANDLE_ORBIT_PX
      const hy = c.y + Math.sin(-yaw) * HANDLE_ORBIT_PX
      if (Math.hypot(pt.x - hx, pt.y - hy) <= HANDLE_HIT_PX) return { kind: 'handle', id: selected.id }
    }
    for (let i = pins.length - 1; i >= 0; i--) {
      const pin = pins[i]
      const c = toScreen(pin.x, pin.y)
      if (Math.hypot(pt.x - c.x, pt.y - c.y) <= PIN_HIT_PX) return { kind: 'pin', id: pin.id }
    }

    for (let i = pins.length - 1; i >= 0; i--) {
      const r = chipRectsRef.current.get(pins[i].id)
      if (r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
        return { kind: 'pin', id: pins[i].id }
      }
    }

    return null
  }, [info, pins, selectedId, editable, toScreen, rot])
  function onPointerDown(e) {
    if (!info) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = localPoint(e)
    const hit = hitTest(pt)

    if (hit?.kind === 'handle') {
      dragRef.current = { kind: 'handle', id: hit.id, startX: pt.x, startY: pt.y, moved: false }
      setCursor('grabbing')
      return
    }
    if (hit?.kind === 'pin') {
      onSelect(hit.id)
      dragRef.current = editable
        ? { kind: 'pin', id: hit.id, startX: pt.x, startY: pt.y, moved: false }
        : null
      if (editable) setCursor('grabbing')
      return
    }
    dragRef.current = {
      kind: 'pan', startX: pt.x, startY: pt.y, moved: false, ox: view.x, oy: view.y,
    }
    if (!placingType) setCursor('grabbing')
  }
  function onPointerMove(e) {
    if (!info) return
    const pt = localPoint(e)
    const drag = dragRef.current
    if (!drag) {
      onHover?.(toWorld(pt.x, pt.y))
      if (placingType) setCursor('crosshair')
      else setCursor(hitTest(pt) ? 'pointer' : 'grab')
      return
    }
    if (!drag.moved && Math.hypot(pt.x - drag.startX, pt.y - drag.startY) > 4) drag.moved = true
    onHover?.(toWorld(pt.x, pt.y))
    if (drag.kind === 'pan') {
      onViewChange((v) => ({ ...v, x: drag.ox + (pt.x - drag.startX), y: drag.oy + (pt.y - drag.startY) }))
      return
    }
    if (!drag.moved) return
    if (drag.kind === 'pin') {
      onMovePin(drag.id, toWorld(pt.x, pt.y))
    } else if (drag.kind === 'handle') {
      const pin = pins.find((p) => p.id === drag.id)
      if (pin) {
        const c = toScreen(pin.x, pin.y)
        let yaw = Math.atan2(-(pt.y - c.y), pt.x - c.x) + rot

        if (e.shiftKey) {
          const step = Math.PI / 12
          yaw = Math.round(yaw / step) * step
        }
        onSetYaw(drag.id, yaw)
      }
    }
  }

  function onDoubleClick(e) {
    if (!info || !editable) return
    const hit = hitTest(localPoint(e))
    if (hit?.kind === 'pin') onRename?.(hit.id)
  }
  function onPointerUp(e) {
    const drag = dragRef.current
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setCursor(placingType ? 'crosshair' : 'grab')
    if (!drag || !info) return
    if (drag.kind === 'pan' && !drag.moved) {
      const pt = localPoint(e)
      if (!placingType) {
        if (onEmptyClick?.(pt)) return
        return onSelect(null)
      }
      const now = performance.now()
      const prev = lastPlaceRef.current
      const isEcho = prev
        && now - prev.t < 400
        && Math.hypot(pt.x - prev.x, pt.y - prev.y) < 8
      if (isEcho) return
      lastPlaceRef.current = { x: pt.x, y: pt.y, t: now }
      onPlace(placingType, toWorld(pt.x, pt.y))
    }
  }
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * 0.0015)
      onViewChange((v) => {
        const next = clamp(v.scale * factor, MIN_ZOOM, MAX_ZOOM)
        if (next === v.scale) return v
        return { ...v, scale: next, x: mx - (mx - v.x) * (next / v.scale), y: my - (my - v.y) * (next / v.scale) }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onViewChange])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width) return
    const ctx = canvas.getContext('2d')
    const c = readColors()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = c.unknown
    ctx.fillRect(0, 0, size.width, size.height)
    if (!info) return
    const { scale, x: ox, y: oy } = view
    const w = info.width * scale
    const h = info.height * scale

    ctx.save()
    ctx.translate(ox, oy)
    ctx.rotate(rot)
    ctx.imageSmoothingEnabled = rot !== 0
    if (image) ctx.drawImage(image, 0, 0, w, h)
    ctx.strokeStyle = c.border
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, w, h)
    ctx.restore()

    drawUnder?.(ctx, toScreen)

    const ordered = [...pins].sort(
      (a, b) => (a.type === 'simple' ? 0 : 1) - (b.type === 'simple' ? 0 : 1))

    const ownPins = pins.filter((p) => p.source !== 'mapping')
    const chipRects = new Map()
    for (const pin of ordered) {
      const s = toScreen(pin.x, pin.y)
      if (pin.type === 'pose') drawRobot(ctx, s, (pin.yaw ?? 0) - rot, scale / info.resolution, c.pose, robotImg, true)
      const color = c[pin.type] ?? c.simple
      const selected = pin.id === selectedId
      const yaw = effectiveYaw(pin)
      if (yaw != null) drawHeadingArrow(ctx, s, yaw - rot, color)
      const fromMap = pin.source === 'mapping'
      const chip = drawPin(ctx, s, pin, color, selected,
        // A page drawing one map of a graph passes each pin's graph-wide name and number, so
        // the map shows the same "POI3" as the lists; counted over this map's pins otherwise.
        fromMap ? 'P' : pin.number ?? displayNumber(pin, ownPins),
        showNames || selected ? pin.name ?? displayName(pin, ownPins) : null)
      if (fromMap) drawMappingRing(ctx, s)
      if (pin.unpaired) drawUnpairedRing(ctx, s)
      if (chip) chipRects.set(pin.id, chip)
    }
    chipRectsRef.current = chipRects

    if (shownRobot?.position) {
      drawRobot(ctx, toScreen(shownRobot.position.x, shownRobot.position.y), (shownRobot.yaw ?? 0) - rot,
        scale / info.resolution, c.robot, robotImg, false)
    }

    const selected = pins.find((p) => p.id === selectedId)
    if (editable && selected && HEADING_TYPES.has(selected.type)) {
      drawRotateHandle(ctx, toScreen(selected.x, selected.y), (effectiveYaw(selected) ?? 0) - rot, c.accent)
    }
  }, [size, info, image, view, rot, pins, selectedId, shownRobot, robotImg, editable, toScreen, themeTick, drawUnder, showNames])

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        width={size.width}
        height={size.height}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => onHover?.(null)}
        style={{ display: 'block', width: '100%', height: '100%', cursor, touchAction: 'none' }}
      />
    </div>
  )
}

const ACTION_RADIUS = 14
const SIMPLE_RADIUS = 10
const HOME_RADIUS = 15
function drawPin(ctx, s, pin, color, selected, number, name) {
  if (pin.type === 'pose') { drawPose(ctx, s, color, selected); return null }
  if (pin.type === 'simple') { drawSimple(ctx, s, color, selected); return null }
  if (pin.type === 'home') { drawHome(ctx, s, color, selected); return null }
  if (pin.type === 'map_switch') return drawAction(ctx, s, color, selected, '⇄', name)
  return drawAction(ctx, s, color, selected, number, name)
}

function frostCircle(ctx, s, r) {
  const m = ctx.getTransform()
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.beginPath()
  ctx.arc(m.a * s.x + m.e, m.d * s.y + m.f, r * m.a, 0, Math.PI * 2)
  ctx.clip()
  ctx.filter = `blur(${3 * m.a}px)`
  ctx.drawImage(ctx.canvas, 0, 0)
  ctx.restore()
}

function drawAction(ctx, s, color, selected, number, name) {
  frostCircle(ctx, s, ACTION_RADIUS)
  ctx.save()
  ctx.translate(s.x, s.y)

  if (selected) {
    ctx.beginPath()
    ctx.arc(0, 0, ACTION_RADIUS + 9, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.2
    ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.beginPath()
  ctx.arc(0, 0, ACTION_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.globalAlpha = selected ? 0.8 : 0.55
  ctx.fill()
  ctx.globalAlpha = 1
  const shine = ctx.createRadialGradient(-ACTION_RADIUS * 0.4, -ACTION_RADIUS * 0.5, 0, 0, 0, ACTION_RADIUS)
  shine.addColorStop(0, 'rgba(255,255,255,0.65)')
  shine.addColorStop(0.45, 'rgba(255,255,255,0.12)')
  shine.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = shine
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = selected ? 3 : 1.6
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, ACTION_RADIUS + 1, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '700 14px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 3
  ctx.fillText(String(number), 0, 0.5)
  ctx.restore()
  return drawNameChip(ctx, s.x, s.y - ACTION_RADIUS - 6, name, selected, color)
}
function drawNameChip(ctx, cx, bottomY, name, selected, color) {
  if (!name) return null
  ctx.save()
  ctx.font = '700 13px Inter, system-ui, sans-serif'
  const padX = 8
  const w = ctx.measureText(name).width + padX * 2
  const h = 22
  const x = cx - w / 2
  const y = bottomY - h

  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 4)
  ctx.fillStyle = 'rgba(11, 7, 16, 0.94)'
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 1
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.shadowOffsetY = 0
  ctx.strokeStyle = color
  ctx.lineWidth = selected ? 2 : 1.4
  ctx.stroke()
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, cx, y + h / 2 + 0.5)
  ctx.restore()
  return { x, y, w, h }
}
function drawSimple(ctx, s, color, selected) {
  ctx.save()
  ctx.translate(s.x, s.y)
  if (selected) {
    ctx.beginPath()
    ctx.arc(0, 0, SIMPLE_RADIUS + 8, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.22
    ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.beginPath()
  ctx.arc(0, 0, SIMPLE_RADIUS, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 5.5
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, SIMPLE_RADIUS, 0, Math.PI * 2)
  ctx.setLineDash([5, 3.5])
  ctx.lineCap = 'round'
  ctx.strokeStyle = color
  ctx.lineWidth = selected ? 3.4 : 2.8
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineCap = 'butt'
  ctx.beginPath()
  ctx.arc(0, 0, 3, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

function drawHome(ctx, s, color, selected) {
  ctx.save()
  ctx.translate(s.x, s.y)
  if (selected) {
    ctx.beginPath()
    ctx.arc(0, 0, HOME_RADIUS + 9, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.2
    ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.beginPath()
  ctx.arc(0, 0, HOME_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 1.5
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.shadowOffsetY = 0
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = selected ? 3.2 : 2.6
  ctx.stroke()
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '700 18px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('H', 0, 0.5)
  ctx.restore()
}
function drawMappingRing(ctx, s) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(s.x, s.y, ACTION_RADIUS + 5, 0, Math.PI * 2)
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = 1.6
  ctx.setLineDash([3, 3])
  ctx.stroke()
  ctx.restore()
}

// A map switch still waiting for its pair, as the navplan tester draws it.
function drawUnpairedRing(ctx, s) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(s.x, s.y, 26, 0, Math.PI * 2)
  ctx.strokeStyle = '#FBBF24'
  ctx.lineWidth = 2.5
  ctx.setLineDash([6, 4])
  ctx.stroke()
  ctx.restore()
}

function drawPose(ctx, s, color, selected) {
  ctx.save()
  ctx.translate(s.x, s.y)
  if (selected) {
    ctx.beginPath()
    ctx.arc(0, 0, 26, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.18
    ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.beginPath()
  ctx.arc(0, 0, 4, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}
function drawHeadingArrow(ctx, s, yaw, color) {
  const len = 30
  const tipX = s.x + Math.cos(-yaw) * len
  const tipY = s.y + Math.sin(-yaw) * len
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(s.x, s.y)
  ctx.lineTo(tipX, tipY)
  ctx.stroke()
  const wing = 7
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - Math.cos(-yaw - 0.45) * wing, tipY - Math.sin(-yaw - 0.45) * wing)
  ctx.lineTo(tipX - Math.cos(-yaw + 0.45) * wing, tipY - Math.sin(-yaw + 0.45) * wing)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}
function drawRotateHandle(ctx, s, yaw, accent) {
  ctx.save()
  ctx.strokeStyle = accent
  ctx.globalAlpha = 0.35
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.arc(s.x, s.y, HANDLE_ORBIT_PX, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.arc(s.x + Math.cos(-yaw) * HANDLE_ORBIT_PX, s.y + Math.sin(-yaw) * HANDLE_ORBIT_PX, 6, 0, Math.PI * 2)
  ctx.fillStyle = accent
  ctx.fill()
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.restore()
}
function drawRobot(ctx, s, yaw, pxPerM, color, img, ghost) {
  if (!img) { drawQuadrupedFallback(ctx, s, yaw, pxPerM, color, ghost); return }
  const k = Math.max(pxPerM, ROBOT_MIN_PX / ROBOT_LEN_M)
  ctx.save()
  ctx.translate(s.x, s.y)
  ctx.rotate(-yaw)
  ctx.beginPath()
  ctx.ellipse(0, 0, 0.62 * k, 0.36 * k, 0, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.globalAlpha = ghost ? 0.12 : 0.22
  ctx.fill()
  ctx.globalAlpha = ghost ? 0.5 : 1
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(img, -ROBOT_IMG_W_M / 2 * k, -ROBOT_IMG_H_M / 2 * k, ROBOT_IMG_W_M * k, ROBOT_IMG_H_M * k)
  drawFrontTriangle(ctx, k, color)
  ctx.restore()
}

function drawFrontTriangle(ctx, k, color) {
  const tip = Math.max(0.78 * k, 0.62 * k + 14)
  const base = Math.max(0.62 * k, tip - Math.max(0.16 * k, 12))
  const half = Math.max(0.1 * k, 8)
  ctx.beginPath()
  ctx.moveTo(tip, 0)
  ctx.lineTo(base, -half)
  ctx.lineTo(base, half)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.stroke()
}

function drawQuadrupedFallback(ctx, s, yaw, pxPerM, color, ghost) {
  const k = Math.max(pxPerM, ROBOT_MIN_PX / 1.1)
  ctx.save()
  if (ghost) ctx.globalAlpha = 0.5
  ctx.translate(s.x, s.y)
  ctx.rotate(-yaw)
  ctx.scale(k, -k)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  ctx.beginPath()
  ctx.ellipse(0, 0, 0.62, 0.36, 0, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.globalAlpha = 0.18
  ctx.fill()
  ctx.globalAlpha = 1

  const legs = [[0.30, 0.15, 0.40, 0.26], [0.30, -0.15, 0.40, -0.26], [-0.30, 0.15, -0.40, 0.26], [-0.30, -0.15, -0.40, -0.26]]
  ctx.strokeStyle = '#1F2937'
  ctx.lineWidth = 0.09
  for (const [hx, hy, fx, fy] of legs) {
    ctx.beginPath()
    ctx.moveTo(hx, hy)
    ctx.lineTo(fx, fy)
    ctx.stroke()
  }
  ctx.fillStyle = '#111827'
  for (const [, , fx, fy] of legs) {
    ctx.beginPath()
    ctx.arc(fx, fy, 0.05, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.beginPath()
  ctx.roundRect(-0.42, -0.16, 0.84, 0.32, 0.08)
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = 0.035
  ctx.stroke()

  ctx.beginPath()
  ctx.roundRect(0.40, -0.11, 0.16, 0.22, 0.05)
  ctx.fillStyle = '#FFFFFF'
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 0.03
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(-0.12, 0, 0.07, 0, Math.PI * 2)
  ctx.fillStyle = '#1F2937'
  ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.translate(s.x, s.y)
  ctx.rotate(-yaw)
  if (ghost) ctx.globalAlpha = 0.5
  drawFrontTriangle(ctx, k, color)
  ctx.restore()
}
