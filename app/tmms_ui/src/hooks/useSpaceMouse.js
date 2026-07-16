import { useCallback, useEffect, useRef, useState } from 'react'
import { publishSpacenavJoy } from '../services/rosbridge'

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Typical raw magnitude of a 3Dconnexion axis sample — used only to scale
// into roughly [-1, 1]; not a calibrated value.
const SM_SCALE = 350

// Confirmed by comparing this SpaceMouse's raw translation/rotation against a
// live `ros2 topic echo /spacenav/joy`: x/y are swapped and inverted, z is
// inverted, and rx/ry are swapped and inverted; rz is inverted.
function toSpacenavJoy(translation, rotation, buttons) {
  return {
    axes: [
      -translation.y, -translation.x, -translation.z,
      -rotation.ry, -rotation.rx, -rotation.rz,
    ],
    buttons: buttons.map((b) => (b ? 1 : 0)),
  }
}

// WebHID capture for a 3Dconnexion SpaceMouse — publishes a /spacenav/joy-
// compatible sensor_msgs/Joy on every input report, a drop-in browser
// replacement for spacenav_node. Self-contained: closes the device and stops
// publishing on unmount, so navigating away from the widget that calls this
// stops driving the robot.
export function useSpaceMouse() {
  const [state, setState] = useState({
    connected: false,
    deviceName: '',
    translation: { x: 0, y: 0, z: 0 },
    rotation: { rx: 0, ry: 0, rz: 0 },
    buttons: [false, false],
    rawReports: {},
    error: '',
  })
  const deviceRef = useRef(null)

  const handleInputReport = useCallback((event) => {
    const { data, reportId } = event
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ')

    setState((prev) => {
      const next = { ...prev, rawReports: { ...prev.rawReports, [reportId]: hex } }
      // Common 3Dconnexion raw-HID layout: reportId 1 = translation (x,y,z),
      // reportId 2 = rotation (rx,ry,rz), each int16 LE. Some models pack
      // both into a single 12-byte reportId 1. reportId 3 = button bitmask.
      if (reportId === 1 && data.byteLength >= 6) {
        next.translation = {
          x: clamp(data.getInt16(0, true) / SM_SCALE, -1, 1),
          y: clamp(data.getInt16(2, true) / SM_SCALE, -1, 1),
          z: clamp(data.getInt16(4, true) / SM_SCALE, -1, 1),
        }
        if (data.byteLength >= 12) {
          next.rotation = {
            rx: clamp(data.getInt16(6, true) / SM_SCALE, -1, 1),
            ry: clamp(data.getInt16(8, true) / SM_SCALE, -1, 1),
            rz: clamp(data.getInt16(10, true) / SM_SCALE, -1, 1),
          }
        }
      } else if (reportId === 2 && data.byteLength >= 6) {
        next.rotation = {
          rx: clamp(data.getInt16(0, true) / SM_SCALE, -1, 1),
          ry: clamp(data.getInt16(2, true) / SM_SCALE, -1, 1),
          rz: clamp(data.getInt16(4, true) / SM_SCALE, -1, 1),
        }
      } else if (reportId === 3) {
        // This SpaceMouse only has 2 physical buttons — always publish a
        // fixed 2-element array (never empty) so the downstream ROS node's
        // fixed buttons[0]/buttons[1] indexing never sees an out-of-range read.
        const b0 = bytes.length > 0 ? Boolean(bytes[0] & 0x01) : false
        const b1 = bytes.length > 0 ? Boolean(bytes[0] & 0x02) : false
        next.buttons = [b0, b1]
      }

      const msg = toSpacenavJoy(next.translation, next.rotation, next.buttons)
      publishSpacenavJoy(msg.axes, msg.buttons)

      return next
    })
  }, [])

  const openDevice = useCallback(async (device) => {
    if (!device.opened) await device.open()
    deviceRef.current = device
    device.addEventListener('inputreport', handleInputReport)
    setState((prev) => ({ ...prev, connected: true, deviceName: device.productName, error: '' }))
  }, [handleInputReport])

  const connect = useCallback(async () => {
    if (!navigator.hid) {
      setState((prev) => ({ ...prev, error: 'WebHID not available — use Chrome/Edge over localhost or HTTPS' }))
      return
    }
    try {
      const [device] = await navigator.hid.requestDevice({ filters: [] })
      if (!device) return
      await openDevice(device)
    } catch (err) {
      setState((prev) => ({ ...prev, error: String(err) }))
    }
  }, [openDevice])

  // Auto-reconnect to a previously-authorized device on mount — WebHID
  // permission grants persist per-origin across reloads, so the operator
  // shouldn't have to re-click Connect every time they return to this widget.
  useEffect(() => {
    if (!navigator.hid) return
    let cancelled = false
    navigator.hid.getDevices().then((devices) => {
      if (cancelled || devices.length === 0) return
      openDevice(devices[0])
    })
    return () => { cancelled = true }
  }, [openDevice])

  useEffect(() => {
    return () => {
      deviceRef.current?.removeEventListener('inputreport', handleInputReport)
      deviceRef.current?.close()
    }
  }, [handleInputReport])

  return { ...state, connect }
}
