import { Ros, Topic, Service } from 'roslib'

// https pages can't open a plain ws:// socket (browsers block it as mixed
// content), so match whatever scheme the page itself loaded over.
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss' : 'ws'
const WS_URL = `${WS_PROTOCOL}://${window.location.hostname}:9090`

export const ros = new Ros({ url: WS_URL })

// Memoized publishers — one Topic instance per topic name
const _publishers = {}
function getPublisher(name, messageType) {
  if (!_publishers[name]) {
    _publishers[name] = new Topic({ ros, name, messageType })
  }
  return _publishers[name]
}

export function publishQuadrupedCmdVel(lx, ly, az) {
  getPublisher('/quadruped_cmd_vel_ui', 'geometry_msgs/Twist').publish({
    linear:  { x: lx, y: ly, z: 0 },
    angular: { x: 0,  y: 0,  z: az },
  })
}

// axes: number[6]  (tx,ty,tz,rx,ry,rz)
// buttons: number[2]  (btn0, btn1)
export function publishZ1JoyUi(axes, buttons) {
  getPublisher('/z1_joy_ui', 'sensor_msgs/Joy').publish({ axes, buttons })
}

// Browser Gamepad API → drop-in replacement for joy_node's /joy, verified
// against the flight controller's raw axes/buttons via ros2 topic echo.
export function publishJoy(axes, buttons) {
  getPublisher('/joy', 'sensor_msgs/Joy').publish({ axes, buttons })
}

// Browser WebHID → drop-in replacement for spacenav_node's /spacenav/joy,
// verified against the SpaceMouse's raw axes/buttons via ros2 topic echo.
// axes: number[6] (tx,ty,tz,rx,ry,rz), buttons: number[2] (btn0, btn1)
export function publishSpacenavJoy(axes, buttons) {
  getPublisher('/spacenav/joy', 'sensor_msgs/Joy').publish({ axes, buttons })
}

export function publishThirdPersonCamControl(cmd) {
  getPublisher('/third_person_cam_control', 'std_msgs/String').publish({ data: cmd })
}

// Returns cleanup fn: call in useEffect cleanup
export function subscribe(topicName, messageType, callback) {
  const topic = new Topic({
    ros,
    name: topicName,
    messageType,
    throttle_rate: 0,
    queue_length: 1,
  })
  topic.subscribe(callback)
  return () => topic.unsubscribe()
}

// Camera topics — bandwidth throttled
export function subscribeCamera(topicName, callback) {
  const isCompressed = topicName.endsWith('/compressed')
  const topic = new Topic({
    ros,
    name: topicName,
    messageType: isCompressed ? 'sensor_msgs/CompressedImage' : 'sensor_msgs/Image',
    throttle_rate: 50,   // max ~20 fps from server side
    queue_length: 1,
  })
  topic.subscribe(callback)
  return () => topic.unsubscribe()
}

// Generic — caller supplies the full request object and service type.
// roslib v2: callService(request, successCb, errorCb) — successCb receives
// the response values object directly.
export function callRosService(serviceName, serviceType, request, onResult, onError) {
  if (!ros.isConnected) {
    onError?.('ROS not connected')
    return
  }
  const svc = new Service({ ros, name: serviceName, serviceType })
  svc.callService(
    request,
    (result) => onResult?.(result),
    (error)  => onError?.(error)
  )
}

export function callService(serviceName, data, onResult, onError) {
  callRosService(serviceName, 'tmms_msgs/StringTrigger', { data }, onResult, onError)
}

export function loadRtabmapDatabase(databasePath, clear, onResult, onError) {
  callRosService(
    '/rtabmap/load_database',
    'rtabmap_msgs/srv/LoadDatabase',
    { database_path: databasePath, clear },
    onResult, onError
  )
}

export function setRtabmapModeMapping(onResult, onError) {
  callRosService('/rtabmap/set_mode_mapping', 'std_srvs/srv/Empty', {}, onResult, onError)
}

export function setRtabmapModeLocalization(onResult, onError) {
  callRosService('/rtabmap/set_mode_localization', 'std_srvs/srv/Empty', {}, onResult, onError)
}
