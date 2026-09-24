import { useState, useEffect, useRef } from 'react'
import { ros, callRosService } from '../services/rosbridge'

// Two probes on one interval:
//   api — browser to ui_backend over its own TCP connection. No DDS, no Python, and not
//         queued behind the camera frames sharing the rosbridge socket, so it tracks the
//         actual link and reads close to `ping` on the command line.
//   ros — the control path. Costs more than the link alone (a DDS hop to rosapi plus
//         rosbridge's own work), but it is the only one of the two that can notice
//         rosbridge itself has stopped answering.
//
// Both settle within TIMEOUT_MS, which is shorter than the interval, so probes never overlap.
const TIMEOUT_MS = 4000

const PING_SERVICE = '/rosapi/get_time'
const PING_TYPE = 'rosapi_msgs/srv/GetTime'

// Each value is: undefined = no result yet, null = failed or timed out, number = round-trip ms.
export function usePing(intervalMs = 5000) {
  const [api, setApi] = useState(undefined)
  const [rosMs, setRosMs] = useState(undefined)
  const seqRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    async function probeApi(seq) {
      const started = performance.now()
      try {
        const res = await fetch('/api/health', {
          cache: 'no-store',                        // a cached 200 would report a fake ~0ms
          signal: AbortSignal.timeout(TIMEOUT_MS),  // fetch has no timeout of its own
        })
        if (cancelled || seq !== seqRef.current) return
        setApi(res.ok ? Math.round(performance.now() - started) : null)
      } catch {
        if (cancelled || seq !== seqRef.current) return
        setApi(null)
      }
    }

    function probeRos(seq) {
      if (!ros.isConnected) {
        setRosMs(null)
        return
      }

      const started = performance.now()
      const settle = (value) => {
        clearTimeout(timer)
        if (cancelled || seq !== seqRef.current) return
        setRosMs(value)
      }

      // roslib forwards `timeout` to rosbridge in the call_service payload and arms no timer
      // of its own, so a wedged rosbridge never answers AND never errors. Without this the
      // probe stays pending forever and the readout freezes on its last good value looking
      // healthy — which is the failure "Restart rosbridge" exists for. Keep this.
      const timer = setTimeout(() => settle(null), TIMEOUT_MS)

      callRosService(
        PING_SERVICE, PING_TYPE, {},
        () => settle(Math.round(performance.now() - started)),
        () => settle(null),
        Math.ceil(TIMEOUT_MS / 1000)
      )
    }

    function probe() {
      const seq = ++seqRef.current
      probeApi(seq)
      probeRos(seq)
    }

    probe()
    const id = setInterval(probe, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return { api, ros: rosMs }
}
