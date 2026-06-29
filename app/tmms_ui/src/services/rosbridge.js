import { Ros, Topic, Service } from 'roslib'

const WS_URL = 'ws://localhost:9090'

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
  const topic = new Topic({
    ros,
    name: topicName,
    messageType: 'sensor_msgs/Image',
    throttle_rate: 50,   // max ~20 fps from server side
    queue_length: 1,
  })
  topic.subscribe(callback)
  return () => topic.unsubscribe()
}

export function callService(serviceName, data, onResult, onError) {
  if (!ros.isConnected) {
    onError?.('ROS not connected')
    return
  }
  const svc = new Service({
    ros,
    name: serviceName,
    serviceType: 'tmms_msgs/StringTrigger',
  })
  // roslib v2: callService(request, successCb, errorCb)
  // successCb receives the response values object directly
  svc.callService(
    { data },
    (result) => onResult?.(result),
    (error)  => onError?.(error)
  )
}
