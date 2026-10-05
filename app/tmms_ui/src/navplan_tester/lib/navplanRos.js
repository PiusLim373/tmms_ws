// ROS calls this page needs that rosbridge.js does not already export.
//
// Built entirely on rosbridge.js's public surface so that shared file needs no edit — which
// keeps this page's footprint to two one-line changes elsewhere (vite.config.js and
// ui_backend.js) and nothing the C2 work can collide with.
import { Topic } from 'roslib'
import { ros, callRosService } from '../../services/rosbridge'
import { decodeLaserScanCdr } from '../../lib/rosCdr'

import { yawToQuaternion } from './quat'

// localization_manager rejects anything whose frame_id is not its global_frame.
const MAP_FRAME = 'map'

// rosbridge gives up on a service call after 5 s unless told otherwise. /relocalize answers
// only after a possible map load plus ~6 s of convergence; /navigation_plan can wait on yasmin.
const RELOCALIZE_TIMEOUT_SEC = 60
const NAVPLAN_TIMEOUT_SEC = 20

/**
 * Load `mapName` on the robot if it isn't already, seed AMCL at the pose, and answer once it
 * has converged or failed -- the reply is the outcome, not just an acknowledgement.
 *
 * Covariance is left at zeros on purpose: localization_manager substitutes its own
 * initial_cov_xy / initial_cov_yaw when entries 0, 7 and 35 are all zero, so the spread stays
 * configured in one place rather than being hardcoded here.
 */
export function relocalize({ mapName, x, y, yaw }, onResult, onError) {
  callRosService(
    '/relocalize',
    'tmms_msgs/srv/RelocalizeTrigger',
    {
      map_name: mapName,
      initial_pose: {
        header: { frame_id: MAP_FRAME },
        pose: {
          pose: { position: { x, y, z: 0 }, orientation: yawToQuaternion(yaw) },
          covariance: new Array(36).fill(0),
        },
      },
    },
    onResult,
    onError,
    RELOCALIZE_TIMEOUT_SEC,
  )
}

/**
 * Hand a plan to navplan_processor, which validates it and forwards it to the state machine.
 *
 * onResult fires on TRANSPORT success, so a validation rejection arrives there with
 * success:false and the reason in message — branch on it.
 */
export function sendNavigationPlan({ navplanId, mapName, waypoints }, onResult, onError) {
  callRosService(
    '/navigation_plan',
    'tmms_msgs/srv/NavigationPlanTrigger',
    {
      navigation_plan: {
        navplan_id: navplanId,
        map_name: mapName,
        timestamp: new Date().toISOString(),
        status: 'created',
        waypoints: waypoints.map(({ x, y, yaw }) => ({
          position: { x, y, z: 0 },
          orientation: yawToQuaternion(yaw ?? 0),
        })),
      },
    },
    onResult,
    onError,
    NAVPLAN_TIMEOUT_SEC,
  )
}

// Epoch ms: strictly increasing without any stored counter, and well inside both int64 and
// JS's 2^53 safe-integer range. Stands in for the ids a plan store would hand out later.
export function nextNavplanId() {
  return Date.now()
}

/**
 * The 2D scan AMCL localizes against, for overlaying on the map.
 *
 * Throttled server-side: the scan is ~722 beams at 10 Hz, and redrawing that much faster
 * than the eye needs only costs rosbridge and the browser. Same approach as
 * subscribeCamera in services/rosbridge.js.
 *
 * cbor-raw is load-bearing. rosbridge shares one ROS subscription per topic between all
 * clients, and the first subscriber fixes it as raw or decoded. The Navigation page's
 * Lichtblick shows /rslidar_scan and always asks for cbor-raw, so asking for anything else
 * here means whichever page opens second gets nothing. See lib/rosCdr.js.
 *
 * Points are in base_footprint (the target_frame in pointcloud_to_laser_scan.yaml), so
 * drawing them on a map needs the robot's map pose to transform through.
 */
export function subscribeLaserScan(onScan) {
  const topic = new Topic({
    ros,
    name: '/rslidar_scan',
    messageType: 'sensor_msgs/LaserScan',
    compression: 'cbor-raw',
    throttle_rate: 150,
    queue_length: 1,
  })
  let warned = false
  topic.subscribe((msg) => {
    try {
      onScan(decodeLaserScanCdr(msg.bytes))
    } catch (err) {
      // Once, not per scan: a bad decode would otherwise flood the console at ~6 Hz.
      if (!warned) console.error('[navplanRos] /rslidar_scan decode failed:', err)
      warned = true
    }
  })
  return () => topic.unsubscribe()
}
