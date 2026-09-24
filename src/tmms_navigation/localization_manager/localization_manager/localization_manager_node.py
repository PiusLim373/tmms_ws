#!/usr/bin/env python3
"""Gatekeeper between the navigation UI and nav2's localization services.

The UI never calls nav2 directly. Loading a map or dropping an initial pose while the robot
is mid-navigation would swap the world out from under the controller, so both requests come
here first, get checked against the robot's state, and are only then forwarded.

This node owns exactly one piece of published truth -- `localization_status` -- which the UI
renders directly and quadruped_controller mirrors into QuadrupedMainStatus.

A note on AMCL's covariance, since two decisions here depend on it: of the 36 entries AMCL
fills only [0], [7] (x/y variance) and [35] (yaw variance), and it reports the covariance of
the WHOLE particle set rather than the best cluster. That is deliberate upstream -- a filter
split between two hypotheses reads as low confidence even though each cluster is tight --
and it is exactly the behaviour we want out of a confidence number.
"""

import math
import os
import re
import threading

import rclpy
from geometry_msgs.msg import PoseWithCovarianceStamped
from nav2_msgs.srv import LoadMap
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile
from std_msgs.msg import String
from std_srvs.srv import Empty
from tmms_msgs.msg import QuadrupedMainStatus
from tmms_msgs.srv import StringTrigger

# Loading a map or re-seeding the pose is only safe when the robot is not actively driving
# itself somewhere, which is NAVIGATING alone.
#
# ERROR is allowed deliberately. The robot is stopped there (the goal was cancelled on the
# way in), and it is exactly when an operator needs to reload a map or re-seed a pose as part
# of recovering -- excluding it deadlocks a fault that the automatic restart could not clear.
ALLOWED_STATES = frozenset({
    QuadrupedMainStatus.UNLOCALIZED,
    QuadrupedMainStatus.IDLE,
    QuadrupedMainStatus.CANCELED,
    QuadrupedMainStatus.PAUSED,
    QuadrupedMainStatus.ERROR,
})

# Same rule as ui_backend.js's MAP_NAME_RE. /map_load takes a bare name and builds the path
# itself, so this anchored pattern is the whole path-traversal defence -- no dot, no slash.
MAP_NAME_RE = re.compile(r'^[A-Za-z0-9_]+$')

# nav2_msgs/LoadMap result codes -> something an operator can act on.
LOAD_MAP_ERRORS = {
    LoadMap.Response.RESULT_MAP_DOES_NOT_EXIST: 'map file does not exist',
    LoadMap.Response.RESULT_INVALID_MAP_DATA: 'invalid map data (is the .png readable?)',
    LoadMap.Response.RESULT_INVALID_MAP_METADATA: 'invalid map metadata (check the .yaml)',
    LoadMap.Response.RESULT_UNDEFINED_FAILURE: 'undefined failure in map_server',
}


class LocalizationManagerNode(Node):

    def __init__(self):
        super().__init__('localization_manager')

        self.declare_parameter('xy_std_max', 0.5)
        self.declare_parameter('yaw_std_max', 0.3)
        self.declare_parameter('acquire_threshold', 0.50)
        self.declare_parameter('lost_threshold', 0.40)
        self.declare_parameter('lost_debounce_count', 15)
        self.declare_parameter('nomotion_attempts', 20)
        self.declare_parameter('nomotion_interval_sec', 0.3)
        self.declare_parameter('initial_cov_xy', 0.25)
        self.declare_parameter('initial_cov_yaw', 0.06853)
        self.declare_parameter('service_timeout_sec', 10.0)
        self.declare_parameter('global_frame', 'map')
        # Root of the map store, same convention as every other node: each derives its own
        # subfolder. 2D pairs live in png/, the clouds they were flattened from in pcd/.
        self.declare_parameter('maps_dir', '~/.htxgrrt/maps')

        self._state_lock = threading.Lock()
        self._status = QuadrupedMainStatus.NOT_STARTED
        self._navigation_state = ''
        self._confidence = 0.0
        self._have_amcl_pose = False
        self._low_count = 0
        # Empty until a map has been through /map_load AND nav2 returned RESULT_SUCCESS.
        # That is also what gates the initial-pose flow.
        self._current_map = ''

        # /map_load is mutually exclusive so two loads can never interleave. Everything
        # else is reentrant: the initialpose flow blocks for ~3s inside its own callback,
        # and both the service responses it waits on and the /amcl_pose updates that make
        # its final confidence check meaningful have to keep being delivered underneath it.
        self._srv_group = MutuallyExclusiveCallbackGroup()
        self._aux_group = ReentrantCallbackGroup()

        # TRANSIENT_LOCAL so a UI (or quadruped_controller) that connects after us still
        # gets the current state instead of a blank panel until the next transition.
        self._status_pub = self.create_publisher(
            String, 'localization_status',
            QoSProfile(depth=1,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL,
                       history=HistoryPolicy.KEEP_LAST))

        # Latched for the same reason as localization_status: the UI and
        # quadruped_controller both need the current map on connect, not on next change.
        self._current_map_pub = self.create_publisher(
            String, '/current_map',
            QoSProfile(depth=1,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL,
                       history=HistoryPolicy.KEEP_LAST))

        self._initialpose_pub = self.create_publisher(
            PoseWithCovarianceStamped, '/initialpose', 10)

        self.create_subscription(
            QuadrupedMainStatus, '/quadruped_main_status', self._main_status_cb, 10,
            callback_group=self._aux_group)
        self.create_subscription(
            PoseWithCovarianceStamped, '/amcl_pose', self._amcl_pose_cb, 10,
            callback_group=self._aux_group)
        self.create_subscription(
            PoseWithCovarianceStamped, '/lichtblick_initialpose', self._initialpose_cb, 10,
            callback_group=self._aux_group)

        self._load_map_cli = self.create_client(
            LoadMap, '/map_server/load_map', callback_group=self._aux_group)
        # Root-relative on AMCL's side: it creates this with a plain name, so it resolves to
        # /request_nomotion_update and NOT /amcl/request_nomotion_update.
        self._nomotion_cli = self.create_client(
            Empty, '/request_nomotion_update', callback_group=self._aux_group)
        # Takes a BARE pcd stem, not a path -- it re-expands to <maps_dir>/pcd/<stem>.pcd.
        self._load_pcd_cli = self.create_client(
            StringTrigger, '/map_downsampler/load_pcd', callback_group=self._aux_group)

        self.create_service(
            StringTrigger, '/map_load', self._map_load_cb, callback_group=self._srv_group)

        self._publish_status(QuadrupedMainStatus.NOT_STARTED)
        self._publish_current_map('')
        self.get_logger().info(
            f'localization_manager ready; maps_dir={self._maps_dir()}')

    # -- helpers ---------------------------------------------------------------

    def _param(self, name):
        return self.get_parameter(name).value

    def _publish_status(self, status):
        with self._state_lock:
            self._status = status
        self._status_pub.publish(String(data=status))
        self.get_logger().info(f'localization_status -> {status}')

    def _maps_dir(self):
        return os.path.expanduser(str(self._param('maps_dir')))

    def _yaml_path(self, name):
        return os.path.join(self._maps_dir(), 'png', f'{name}.yaml')

    def _publish_current_map(self, name):
        with self._state_lock:
            self._current_map = name
        self._current_map_pub.publish(String(data=name))
        self.get_logger().info(f'current_map -> {name or "(none)"}')

    def _read_pcd_stem(self, yaml_path):
        """Bare stem of the cloud this grid was flattened from, or None.

        The yaml carries pcd_file as an ABSOLUTE path, but map_downsampler's ~/load_pcd
        takes a bare name and re-roots it under <maps_dir>/pcd/ -- that is its whole
        path-traversal defence. So the two have to be bridged here.

        The stem is NOT assumed equal to the map name: one 3D cloud can be flattened into
        several 2D maps, so the png name and the pcd name genuinely differ.
        """
        with open(yaml_path, 'r') as handle:
            for line in handle:
                key, _, value = line.partition(':')
                if key.strip() == 'pcd_file':
                    stem = os.path.basename(value.strip())
                    if stem.endswith('.pcd'):
                        stem = stem[:-len('.pcd')]
                    return stem or None
        return None

    def _load_pcd_for(self, name, yaml_path):
        """Best-effort 3D context load. Never raises, never fails the map load.

        The cloud is what gives Lichtblick its 3D view; navigation works fine without it,
        and a png/yaml pair uploaded on its own legitimately has no cloud at all.
        """
        try:
            stem = self._read_pcd_stem(yaml_path)
            if stem is None:
                self.get_logger().warn(
                    f"'{name}' has no pcd_file in its yaml -- loaded the 2D map only, "
                    'no 3D cloud')
                return

            ok, result = self._call_and_wait(
                self._load_pcd_cli, StringTrigger.Request(data=stem),
                '/map_downsampler/load_pcd')
            if not ok:
                self.get_logger().warn(f'3D cloud not loaded: {result}')
            elif not result.success:
                # Most likely the yaml points outside <maps_dir>/pcd/, so re-rooting the
                # stem lands on a file that is not there.
                self.get_logger().warn(
                    f"3D cloud '{stem}' not loaded: {result.message}")
            else:
                self.get_logger().info(f"3D cloud '{stem}' loaded")
        except Exception as exc:  # noqa: BLE001 -- the 2D map is already live either way
            self.get_logger().warn(f'3D cloud not loaded: {exc}')

    def _gate_blocked(self):
        """Returns a reason string when the robot is in no state to accept this, else None."""
        with self._state_lock:
            nav_state = self._navigation_state
        if not nav_state:
            return 'no /quadruped_main_status received yet -- is quadruped_controller up?'
        if nav_state not in ALLOWED_STATES:
            return f"robot is '{nav_state}'; allowed: {', '.join(sorted(ALLOWED_STATES))}"
        return None

    def _confidence_from(self, covariance):
        """Map AMCL's covariance onto 0..1. See the module docstring for why only 3 entries."""
        xy_std = math.sqrt(max(covariance[0] + covariance[7], 0.0))
        yaw_std = math.sqrt(max(covariance[35], 0.0))
        worst = max(xy_std / float(self._param('xy_std_max')),
                    yaw_std / float(self._param('yaw_std_max')))
        return min(max(1.0 - worst, 0.0), 1.0)

    def _call_and_wait(self, client, request, what):
        """Returns (ok, result_or_message). The house idiom -- see mapping_manager_node.

        Never spin_until_future_complete() here: this runs inside a callback, and the thread
        that would do the spinning is the one already blocked.
        """
        timeout = float(self._param('service_timeout_sec'))
        if not client.wait_for_service(timeout_sec=5.0):
            return False, f'{what} is not available'

        future = client.call_async(request)
        done = threading.Event()
        future.add_done_callback(lambda _f: done.set())
        if not done.wait(timeout):
            future.cancel()
            return False, f'{what} did not return within {timeout:.0f}s'

        result = future.result()
        if result is None:
            return False, f'{what} call failed'
        return True, result

    # -- subscriptions ---------------------------------------------------------

    def _main_status_cb(self, msg):
        with self._state_lock:
            self._navigation_state = msg.navigation_state

    def _amcl_pose_cb(self, msg):
        confidence = self._confidence_from(msg.pose.covariance)

        with self._state_lock:
            self._confidence = confidence
            self._have_amcl_pose = True
            # Only a settled fix can decay into lost. Running this during `pending` would
            # let a slow-converging session flip itself to lost before it ever finished.
            if self._status != QuadrupedMainStatus.LOCALIZED:
                self._low_count = 0
                return

            if confidence >= float(self._param('lost_threshold')):
                self._low_count = 0
                return

            self._low_count += 1
            if self._low_count < int(self._param('lost_debounce_count')):
                return
            lost_conf = confidence

        self.get_logger().warn(
            f'Localization lost: confidence {lost_conf:.2f} below threshold for '
            f'{self._param("lost_debounce_count")} consecutive updates')
        self._publish_status(QuadrupedMainStatus.LOCALIZATION_LOST)

    def _initialpose_cb(self, msg):
        with self._state_lock:
            if self._status == QuadrupedMainStatus.PENDING:
                # Deliberately no status publish: overwriting a live session's PENDING with
                # FAILED would report the wrong outcome for the run that is still going.
                self.get_logger().warn(
                    'A localization attempt is already pending; ignoring this initial pose')
                return

        reason = self._gate_blocked()
        if reason is not None:
            self.get_logger().error(f'Initial pose rejected: {reason}')
            self._publish_status(QuadrupedMainStatus.FAILED)
            return

        with self._state_lock:
            current_map = self._current_map
        if not current_map:
            # AMCL would accept the pose and then warn "Waiting for map...." forever, which
            # reads to the operator as localization silently doing nothing.
            self.get_logger().error(
                'Initial pose rejected: no map loaded -- load one via /map_load first')
            self._publish_status(QuadrupedMainStatus.FAILED)
            return

        global_frame = str(self._param('global_frame'))
        if msg.header.frame_id.lstrip('/') != global_frame:
            # AMCL drops a mismatched frame with only a warning of its own, so without this
            # the pose would vanish and the run would fail with no visible cause.
            self.get_logger().error(
                f"Initial pose is in frame '{msg.header.frame_id}', AMCL only accepts "
                f"'{global_frame}' -- discarding")
            self._publish_status(QuadrupedMainStatus.FAILED)
            return

        outgoing = msg
        if (abs(msg.pose.covariance[0]) < 1e-9 and abs(msg.pose.covariance[7]) < 1e-9
                and abs(msg.pose.covariance[35]) < 1e-9):
            # AMCL reads this covariance as the INITIAL PARTICLE SPREAD. All-zero collapses
            # every particle onto one point, and the filter can never spread out to converge.
            outgoing = PoseWithCovarianceStamped()
            outgoing.header = msg.header
            outgoing.pose.pose = msg.pose.pose
            outgoing.pose.covariance = list(msg.pose.covariance)
            outgoing.pose.covariance[0] = float(self._param('initial_cov_xy'))
            outgoing.pose.covariance[7] = float(self._param('initial_cov_xy'))
            outgoing.pose.covariance[35] = float(self._param('initial_cov_yaw'))
            self.get_logger().warn(
                'Initial pose had zero covariance; substituting default particle spread')

        self._publish_status(QuadrupedMainStatus.PENDING)
        self._initialpose_pub.publish(outgoing)

        self._run_convergence()

    # -- the initial-pose convergence run --------------------------------------

    def _run_convergence(self):
        attempts = int(self._param('nomotion_attempts'))
        interval = float(self._param('nomotion_interval_sec'))

        # The spacing is load-bearing, not politeness. nomotionUpdateCallback only sets a
        # one-shot force_update_ flag which is consumed on the NEXT laser scan (~100ms at
        # 10Hz), so back-to-back calls collapse into a single filter update.
        for i in range(attempts):
            ok, result = self._call_and_wait(
                self._nomotion_cli, Empty.Request(), '/request_nomotion_update')
            if not ok:
                self.get_logger().error(f'Localization failed: {result}')
                self._publish_status(QuadrupedMainStatus.FAILED)
                return
            self.get_logger().debug(f'no-motion update {i + 1}/{attempts}')
            interval_done = threading.Event()
            interval_done.wait(interval)

        with self._state_lock:
            confidence = self._confidence
            have_pose = self._have_amcl_pose

        if not have_pose:
            self.get_logger().error(
                'Localization failed: no /amcl_pose received -- is AMCL running and is a '
                'map loaded?')
            self._publish_status(QuadrupedMainStatus.FAILED)
            return

        threshold = float(self._param('acquire_threshold'))
        if confidence > threshold:
            self.get_logger().info(
                f'Localization succeeded: confidence {confidence:.2f} > {threshold:.2f}')
            self._publish_status(QuadrupedMainStatus.LOCALIZED)
        else:
            self.get_logger().warn(
                f'Localization failed: confidence {confidence:.2f} <= {threshold:.2f}')
            self._publish_status(QuadrupedMainStatus.FAILED)

    # -- services --------------------------------------------------------------

    def _map_load_cb(self, request, response):
        reason = self._gate_blocked()
        if reason is not None:
            # Note this leaves localization_status alone: a refused load changed nothing, so
            # reporting a localization failure here would be a lie.
            response.success = False
            response.message = f'Map load rejected: {reason}'
            self.get_logger().error(response.message)
            return response

        # A BARE NAME, never a path -- MAP_NAME_RE is then the only thing that has to be
        # right for path traversal to be impossible, and the extensions are appended here.
        name = request.data.strip()
        if not MAP_NAME_RE.match(name):
            response.success = False
            response.message = (
                f"Map load rejected: '{name}' is not a valid map name "
                '(letters, digits and underscore only)')
            self.get_logger().error(response.message)
            return response

        yaml_path = self._yaml_path(name)
        if not os.path.isfile(yaml_path):
            response.success = False
            response.message = f'Map load rejected: {yaml_path} does not exist'
            self.get_logger().error(response.message)
            return response

        ok, result = self._call_and_wait(
            self._load_map_cli, LoadMap.Request(map_url=yaml_path),
            '/map_server/load_map')
        if not ok:
            response.success = False
            response.message = f'Map load failed: {result}'
            self.get_logger().error(response.message)
            return response

        if result.result != LoadMap.Response.RESULT_SUCCESS:
            detail = LOAD_MAP_ERRORS.get(result.result, f'unknown result code {result.result}')
            response.success = False
            response.message = f'Map load failed: {detail}'
            self.get_logger().error(response.message)
            return response

        # A new map invalidates any previous fix -- the old pose means nothing in it.
        self._publish_status(QuadrupedMainStatus.NOT_STARTED)
        with self._state_lock:
            self._have_amcl_pose = False
            self._low_count = 0
        self._publish_current_map(name)

        # Best effort, after the 2D map is already live: this never fails the load.
        self._load_pcd_for(name, yaml_path)

        response.success = True
        response.message = f'Map loaded: {name}'
        self.get_logger().info(response.message)
        return response


def main():
    rclpy.init()
    node = LocalizationManagerNode()
    # 4 threads: the initialpose flow blocks for ~3s while it needs the nomotion responses
    # and /amcl_pose updates delivered underneath it, with /map_load still answerable.
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == '__main__':
    main()
