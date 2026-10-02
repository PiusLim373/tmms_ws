import { useEffect, useRef } from 'react'
import { useThemeTick } from '../hooks/useThemeTick'
import { worldToPixel } from '../lib/c2Coords'

// Deliberately NOT a theme token. The accent colours are tuned to sit quietly inside the UI,
// which is the opposite of what live sensor data wants -- and the map underneath is greyscale
// (obstacle 0 / unknown 205 / free 255), so one loud red reads in both themes. Kept brighter
// than --pin-action (#DC2626) so a spray of scan points never looks like a waypoint.
const SCAN_COLOR = '#FF2D2D'
const SCAN_POINT_PX = 3

// This canvas sits ABOVE C2MapCanvas, so a link drawn centre-to-centre would cross the pin
// glyphs. Each end is trimmed to the rim of the marker it meets instead. Screen-space and
// zoom-independent, matching C2MapCanvas's ACTION_RADIUS (14) and robot ring radius (17).
const PIN_RIM_PX = 14 + 2
const ROBOT_RIM_PX = 17 + 2
const LINK_WIDTH_PX = 2

// A sibling canvas laid over C2MapCanvas rather than a change to it: that component belongs
// to the C2 work and is imported read-only here. pointerEvents none keeps every click, drag
// and wheel event with the canvas underneath, so its interaction model is untouched.
//
// Draws, bottom to top: route links, scan points, the relocalize ghost marker.
export function MapOverlay({ info, view, size, robot, waypoints, scan, ghost }) {
  const canvasRef = useRef(null)
  const themeTick = useThemeTick()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !info) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, size.width, size.height)

    const css = getComputedStyle(document.documentElement)
    const ghostColor = css.getPropertyValue('--pin-home').trim() || '#F59E0B'
    const linkColor = css.getPropertyValue('--pin-action').trim() || '#DC2626'

    const toScreen = (wx, wy) => {
      const p = worldToPixel(wx, wy, info)
      return { x: view.x + p.x * view.scale, y: view.y + p.y * view.scale }
    }

    // -- route links -------------------------------------------------------
    // Derived from the ordered list every draw, so deleting a middle waypoint relinks its
    // neighbours and dragging one moves its links -- no link state to keep in sync.
    if (waypoints?.length) {
      ctx.save()
      ctx.strokeStyle = linkColor
      ctx.globalAlpha = 0.75
      ctx.lineWidth = LINK_WIDTH_PX
      ctx.lineCap = 'round'

      // The implicit first leg. Dashed because the operator did not place it -- it moves as
      // the robot does. Only drawn when the robot is on this map (robot is null otherwise).
      if (robot?.position) {
        ctx.setLineDash([6, 4])
        drawTrimmedLink(ctx, toScreen(robot.position.x, robot.position.y),
          toScreen(waypoints[0].x, waypoints[0].y), ROBOT_RIM_PX, PIN_RIM_PX)
        ctx.setLineDash([])
      }

      for (let i = 1; i < waypoints.length; i++) {
        drawTrimmedLink(ctx, toScreen(waypoints[i - 1].x, waypoints[i - 1].y),
          toScreen(waypoints[i].x, waypoints[i].y), PIN_RIM_PX, PIN_RIM_PX)
      }
      ctx.restore()
    }

    // -- scan --------------------------------------------------------------
    if (scan && robot?.position && Number.isFinite(robot.yaw)) {
      const { angle_min: a0, angle_increment: da, range_min: rmin, range_max: rmax } = scan
      const cy = Math.cos(robot.yaw)
      const sy = Math.sin(robot.yaw)
      ctx.fillStyle = SCAN_COLOR
      const half = SCAN_POINT_PX / 2

      for (let i = 0; i < scan.ranges.length; i++) {
        const r = scan.ranges[i]
        // use_inf is true upstream, so a no-return arrives as Infinity. Ranges outside the
        // configured window are equally meaningless.
        if (!Number.isFinite(r) || r < rmin || r > rmax) continue

        const a = a0 + i * da
        const bx = r * Math.cos(a)
        const by = r * Math.sin(a)
        // base_footprint -> map, using the robot's own map pose.
        const s = toScreen(robot.position.x + bx * cy - by * sy,
          robot.position.y + bx * sy + by * cy)
        // fillRect rather than arc: ~700 points per frame, and this is an order of
        // magnitude cheaper than a path per point.
        ctx.fillRect(s.x - half, s.y - half, SCAN_POINT_PX, SCAN_POINT_PX)
      }
    }

    // -- ghost marker ------------------------------------------------------
    // Follows the pointer while a pose is being placed. C2MapCanvas owns its own CSS cursor
    // (it sets crosshair whenever placingType is set) and exposes no prop for it, so the
    // marker is drawn in map space instead -- which also shows exactly where the pin lands.
    if (ghost) {
      const s = toScreen(ghost.x, ghost.y)
      ctx.strokeStyle = ghostColor
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.arc(s.x, s.y, 11, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(s.x - 5, s.y)
      ctx.lineTo(s.x + 5, s.y)
      ctx.moveTo(s.x, s.y - 5)
      ctx.lineTo(s.x, s.y + 5)
      ctx.stroke()
    }
  }, [info, view, size, robot, waypoints, scan, ghost, themeTick])

  return (
    <canvas
      ref={canvasRef}
      width={size.width}
      height={size.height}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  )
}

// Line from a to b, shortened by trimA at a's end and trimB at b's end. Skipped outright when
// the two markers overlap on screen -- trimming a segment shorter than trimA + trimB would
// flip its direction and draw a stub pointing the wrong way.
function drawTrimmedLink(ctx, a, b, trimA, trimB) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len <= trimA + trimB) return
  const ux = dx / len
  const uy = dy / len
  ctx.beginPath()
  ctx.moveTo(a.x + ux * trimA, a.y + uy * trimA)
  ctx.lineTo(b.x - ux * trimB, b.y - uy * trimB)
  ctx.stroke()
}
