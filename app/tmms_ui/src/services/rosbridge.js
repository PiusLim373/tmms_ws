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

// Mapping sessions are owned by mapping_utils' mapping_manager_node, which starts and stops
// tmms_master's fast_lio.launch.py. It builds the .pcd path itself from the map name, so the
// UI never sends a filesystem path.
//
// NOTE: unlike the rtabmap std_srvs/Empty services these replaced, both of these return
// success + message. onResult fires on TRANSPORT success, so a rejected request (bad name,
// TF lookup failed, session already active) arrives through onResult with success: false.
// Every caller must branch on result.success and surface result.message.
export function startMapping(mapName, onResult, onError) {
  callRosService(
    '/mapping_manager/start_mapping',
    'tmms_msgs/srv/StringTrigger',
    { data: mapName },
    onResult, onError
  )
}

// Blocks for the whole /map_save write, which is seconds-to-minutes on a large map, and
// roslib applies no timeout of its own. Callers need a visible "saving" state, not just a
// disabled button.
export function stopMapping(onResult, onError) {
  callRosService('/mapping_manager/stop_mapping', 'std_srvs/srv/Trigger', {}, onResult, onError)
}

// Hands the robot between the operator and nav2. Paused = teleop owns it and nav2's cmd_vel
// is dropped; unpaused = nav2 owns it and every teleop surface is refused. Unpausing also
// runs balance_stand, so it can take a moment.
export function setQuadrupedPaused(paused, onResult, onError) {
  callRosService('/quadruped_controller/quadruped_pause', 'std_srvs/srv/SetBool',
    { data: paused }, onResult, onError)
}

// Preempts the active nav2 goal on the yasmin FSM, which then lands in `canceled`.
// std_srvs/Empty has no response fields — arriving in onResult IS the whole answer.
export function cancelNavGoal(onResult, onError) {
  callRosService('/cancel_goal', 'std_srvs/srv/Empty', {}, onResult, onError)
}

// BARE map name, never a path: localization_manager builds <maps_dir>/png/<name>.yaml
// itself, and the name regex on its side is the whole path-traversal defence.
//
// Gated on the robot's navigation_state, so a rejection (mid-navigation, no such map)
// arrives through onResult with success: false — branch on it and show result.message.
export function loadNavMap(name, onResult, onError) {
  callRosService('/map_load', 'tmms_msgs/srv/StringTrigger',
    { data: name }, onResult, onError)
}

// Loads <maps_dir>/pcd/<name>.pcd into map_flattener and publishes the flattened grid.
// Seconds on a large cloud — the PCD read plus a full filter pass.
export function loadPcdForFlattening(mapName, onResult, onError) {
  callRosService('/map_flattener/load_pcd', 'tmms_msgs/srv/StringTrigger',
    { data: mapName }, onResult, onError)
}

// Publishes the last flattened grid onto /editor_flattened_map. No rebuild, no filter pass —
// it re-sends the grid the flattener already has in hand, so it returns in milliseconds.
//
// That topic is volatile and this service is the only thing that ever publishes on it, so
// SUBSCRIBE FIRST, then call this — anything sent before the subscriber is listening is gone.
// See handleOpenEditor in MappingToolWidget for why the editor cannot just read /flattened_map.
//
// Returns success: false through onResult (not onError) when nothing has been flattened yet.
export function republishFlattenedMap(onResult, onError) {
  callRosService('/map_flattener/republish_map', 'std_srvs/srv/Trigger', {}, onResult, onError)
}

// rcl_interfaces ParameterType. Only the two the flattener's tunables use.
const PARAM_TYPE_INTEGER = 2
const PARAM_TYPE_DOUBLE = 3

// Sets parameters on another node. rosbridge fills absent message fields with defaults, but
// ParameterValue is a union discriminated by `type` and getting that wrong silently writes a
// zero, so every field is sent explicitly rather than trusting the fill-in.
//
// NOTE this returns as soon as the node ACCEPTS the value, which for map_flattener is the
// moment its debounce timer is armed — seconds before the map the caller actually wants
// exists. Watch /flattened_map_info for completion; see subscribeMapInfo below.
export function setNodeParameters(nodeName, params, onResult, onError) {
  const parameters = params.map(({ name, value, integer }) => ({
    name,
    value: {
      type: integer ? PARAM_TYPE_INTEGER : PARAM_TYPE_DOUBLE,
      bool_value: false,
      integer_value: integer ? Math.round(value) : 0,
      double_value: integer ? 0 : value,
      string_value: '',
      byte_array_value: [],
      bool_array_value: [],
      integer_array_value: [],
      double_array_value: [],
      string_array_value: [],
    },
  }))
  callRosService(`${nodeName}/set_parameters`, 'rcl_interfaces/srv/SetParameters',
    { parameters }, onResult, onError)
}

// Reads parameters back off another node. The counterpart to setNodeParameters, and the reason
// it exists: after a browser refresh the flattener still holds whatever thresholds were tuned
// into it, and a panel that came back showing its own defaults would be claiming credit for a
// map those defaults did not produce. The node is the source of truth; ask it.
//
// onResult receives { name: value } for whichever of `names` came back typed. Parameters the
// node does not have arrive as PARAMETER_NOT_SET and are omitted rather than guessed at.
export function getNodeParameters(nodeName, names, onResult, onError) {
  callRosService(`${nodeName}/get_parameters`, 'rcl_interfaces/srv/GetParameters',
    { names },
    (res) => {
      const out = {}
      ;(res.values || []).forEach((v, i) => {
        // Only the two types the sliders use, matching what setNodeParameters writes. Anything
        // else is left out — a wrong value here is worse than a missing one.
        if (v.type === PARAM_TYPE_INTEGER) out[names[i]] = v.integer_value
        else if (v.type === PARAM_TYPE_DOUBLE) out[names[i]] = v.double_value
      })
      onResult?.(out)
    },
    onError)
}

// Per-rebuild JSON status from map_flattener: point counts, grid size, and the remediation
// when the cell cap is hit. Latched, so this fires once on subscribe with the current state.
export function subscribeMapInfo(callback) {
  return subscribe('/flattened_map_info', 'std_msgs/String', (msg) => {
    try {
      callback(JSON.parse(msg.data))
    } catch (err) {
      console.error('[rosbridge] bad /flattened_map_info payload:', msg.data, err)
    }
  })
}

// The editor reads /editor_flattened_map, NOT the /flattened_map Lichtblick shows. Lichtblick
// subscribes cbor-raw, and rosbridge shares one subscription per topic while honouring `raw`
// only for the first client to arrive — so on a topic Lichtblick has open, a cbor request makes
// rosbridge throw and the callback never fires. Keep the editor's topic off every Lichtblick
// layout.
//
// compression: 'cbor' is load-bearing, not an optimisation. OccupancyGrid.data is int8[],
// which rosbridge's default JSON encoding sends as a literal array of millions of numbers —
// tens of MB of text to parse for a map this app is expected to handle routinely. Its
// cbor_conversion.py maps sequence<int8> to CBOR tag 72 and roslib decodes that straight into
// a typed array, so the same message arrives as a compact binary blob.
const GRID_TYPE = 'nav_msgs/OccupancyGrid'

// RELIABLE is the whole point of this profile, and it has to be asked for explicitly.
//
// rosbridge picks a subscription QoS in subscribers.py::_get_default_qos_profile, and it infers
// reliability from the publishers' DURABILITY, never from their reliability: the default is
// BEST_EFFORT, upgraded to RELIABLE only when every publisher on the topic is TRANSIENT_LOCAL.
// /editor_flattened_map is reliable but deliberately volatile, so it falls straight into that
// gap and rosbridge subscribes best-effort. A multi-megabyte grid fragments into ~1400 UDP
// datagrams, one lost fragment discards the entire sample, and nothing is retransmitted — which
// is why the map arrives on the third click and never on the first, while `ros2 topic echo`
// (reliable by default) sees every one.
const GRID_QOS = {
  history: 'keep_last',
  depth: 1,
  reliability: 'reliable',
  durability: 'volatile',
}

let subscribeSeq = 0

// Stays subscribed until the returned fn is called.
//
// Sends the subscribe op by hand rather than going through roslib's Topic, which has no way to
// pass a QoS profile (see Topic.subscribe in roslib 2.1.0 — a fixed field set). rosbridge reads
// msg["qos"] and runs it through qos_extraction.py. Everything else is the same wire protocol
// Topic would have produced, and incoming messages arrive on the same `ros.on(topicName)`
// channel with CBOR already decoded by the transport.
//
// NOTE rosbridge keeps ONE subscription per topic and takes its QoS from whichever client
// subscribes FIRST, so this profile only holds while this is the sole subscriber to the topic —
// true by design here, since the editor topic is kept off every Lichtblick layout.
export function subscribeOccupancyGrid(topicName, onMessage, onError) {
  if (!ros.isConnected) {
    onError?.('ROS not connected')
    return () => {}
  }
  const id = `subscribe:${topicName}:${++subscribeSeq}`
  // ros.on(topic) delivers the whole {op, topic, msg} envelope; Topic unwraps it internally and
  // so must this.
  const handler = (envelope) => { if (envelope?.msg) onMessage(envelope.msg) }

  ros.on(topicName, handler)
  ros.callOnConnection({
    op: 'subscribe',
    id,
    type: GRID_TYPE,
    topic: topicName,
    compression: 'cbor',
    throttle_rate: 0,
    queue_length: 1,
    qos: GRID_QOS,
  })

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    ros.off(topicName, handler)
    ros.callOnConnection({ op: 'unsubscribe', id, topic: topicName })
  }
}
