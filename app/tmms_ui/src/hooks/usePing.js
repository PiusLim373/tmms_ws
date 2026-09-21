import { useState, useEffect, useRef } from 'react'
import { ros, callRosService } from '../services/rosbridge'

// Round-trip over the rosbridge websocket — the same path teleop commands and camera frames
// travel, so this is the latency that actually matters to the operator.
//
// Not ICMP: a browser cannot send it, and ui_backend runs ON the robot (network_mode: host),
// so an ICMP probe from there would measure the robot pinging itself. This is what a game's
// ping readout is too — an application round trip over the connection already in use.
//
// It also catches a wedged rosbridge, which still reports the socket as open while answering
// nothing. That is the failure the header's "Restart rosbridge" exists for.
const PROBE_TIMEOUT_SEC = 4

// rosapi is spawned alongside rosbridge by rosbridge_websocket_launch.xml, so this service
// is available wherever the socket is. The type lives in rosapi_msgs on Jazzy, not rosapi.
const PING_SERVICE = '/rosapi/get_time'
const PING_TYPE = 'rosapi_msgs/srv/GetTime'

// Returns round-trip milliseconds, or null when disconnected or the probe went unanswered.
export function usePing(intervalMs = 5000) {
  const [ms, setMs] = useState(null)
  const inFlightRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    function probe() {
      // Skip rather than queue: overlapping probes would time each other's latency.
      if (inFlightRef.current) return
      if (!ros.isConnected) {
        setMs(null)
        return
      }

      inFlightRef.current = true
      const started = performance.now()
      const settle = (value) => {
        if (cancelled) return
        inFlightRef.current = false
        setMs(value)
      }

      callRosService(
        PING_SERVICE, PING_TYPE, {},
        () => settle(Math.round(performance.now() - started)),
        () => settle(null),
        PROBE_TIMEOUT_SEC
      )
    }

    probe()
    const id = setInterval(probe, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return ms
}
