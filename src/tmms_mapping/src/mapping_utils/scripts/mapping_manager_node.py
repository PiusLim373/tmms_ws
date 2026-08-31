#!/usr/bin/env python3
"""Owns the lifecycle of a FAST-LIO2 mapping session.

fast_lio.launch.py is deliberately NOT part of operation.launch.py: mapping is occasional,
and map_downsampler_node voxelising /Laser_map at 1 Hz is real CPU to burn for the majority
of the time nobody is mapping. This node starts that launch on demand instead, one session
at a time, and tears it down again on request.

    ros2 service call /mapping_manager/start_mapping tmms_msgs/srv/StringTrigger "{data: my_map}"
    ros2 service call /mapping_manager/stop_mapping  std_srvs/srv/Trigger

start_mapping spawns `ros2 launch tmms_master fast_lio.launch.py map_file_path:=<maps_dir>/<name>.pcd`.
The path has to be passed at spawn time, not set afterwards: laserMapping.cpp reads
map_file_path into a global once in its constructor and never looks at it again, so
`ros2 param set` on a running node silently does nothing. A launch-time override is already
in place before that constructor runs, which is why it works.

stop_mapping calls FAST-LIO's /map_save (which blocks until the .pcd is on disk), waits for
it, and only then SIGINTs the launch. If the save fails the launch is still torn down and the
failure is reported -- the map is already lost either way, and leaving a session the operator
cannot stop is strictly worse.

ANCHORING camera_init
---------------------
FAST-LIO's camera_init frame is wherever the IMU was when FAST-LIO finished initialising, and
FAST-LIO itself publishes only camera_init -> body. Nothing connects that to the robot. This
node closes the gap: at start_mapping it looks up odom -> dog_imu_link and latches exactly
that value as a static odom -> camera_init.

dog_imu_link IS FAST-LIO's `body` frame -- the config's extrinsic_T [0.34218, 0.02341, 0.12924]
is precisely (base_link->rslidar) - (base_link->dog_imu_link) -- so the pose of dog_imu_link at
session start is the pose of camera_init, and the resulting tree is:

    odom -(quadruped_controller)-> base_footprint -> base_link -> rslidar, dog_imu_link, ...
      +--(this node, static)-----> camera_init -(FAST-LIO)-> body

This replaces the identity map->camera_init / map->odom statics fast_lio.launch.py used to
publish, which were only ever correct when odom happened to be zero; at any other odom pose
the map and the robot model were displaced by exactly that pose.
"""

import os
import re
import signal
import subprocess
import threading

import rclpy
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.duration import Duration
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile
from rclpy.time import Time

from geometry_msgs.msg import TransformStamped
from std_srvs.srv import Trigger
from tf2_msgs.msg import TFMessage
from tmms_msgs.srv import StringTrigger

from tf2_ros import TransformException
from tf2_ros.buffer import Buffer
from tf2_ros.transform_listener import TransformListener

# Same rule the UI input and ui_backend.js enforce. Anchored, so it also rules out anything
# that could escape maps_dir once it is pasted into a path.
MAP_NAME_RE = re.compile(r'^[A-Za-z0-9_]+$')


class MappingManagerNode(Node):

    def __init__(self):
        super().__init__('mapping_manager')

        self.declare_parameter('maps_dir', os.path.expanduser('~/.htxgrrt/maps'))
        self.declare_parameter('launch_package', 'tmms_master')
        self.declare_parameter('launch_file', 'fast_lio.launch.py')
        self.declare_parameter('extra_launch_args', [''])
        self.declare_parameter('parent_frame', 'odom')
        self.declare_parameter('imu_frame', 'dog_imu_link')
        self.declare_parameter('child_frame', 'camera_init')
        self.declare_parameter('tf_lookup_timeout_sec', 5.0)
        self.declare_parameter('map_save_timeout_sec', 120.0)
        self.declare_parameter('shutdown_timeout_sec', 20.0)

        # Session state. Everything that touches it holds _lock.
        self._lock = threading.Lock()
        self._proc = None
        self._map_name = None
        self._pcd_path = None

        # The two servers share one mutually-exclusive group so start and stop can never
        # interleave. The /map_save client, the reaper and the TF listener sit outside it,
        # which is what lets stop_mapping block on /map_save without deadlocking itself:
        # another executor thread stays free to deliver that response.
        self._srv_group = MutuallyExclusiveCallbackGroup()
        self._aux_group = ReentrantCallbackGroup()

        self._buffer = Buffer()
        # Default callback group -- separate from _srv_group, so /tf keeps being processed
        # while a lookup_transform timeout is blocking inside a service callback.
        self._tf_listener = TransformListener(self._buffer, self)
        # Raw /tf_static publisher rather than tf2_ros.StaticTransformBroadcaster, because
        # the rclpy broadcaster cannot re-anchor a frame. Its sendTransform() is append-only:
        #
        #     if t_in.child_frame_id not in self._child_frame_ids:
        #         self._child_frame_ids.add(...); self.net_message.transforms.append(t_in)
        #     self.pub_tf.publish(self.net_message)
        #
        # so a second sendTransform() for camera_init is silently DROPPED and it republishes
        # the first session's value -- every session after the first would be anchored at
        # session 1's pose. (The C++ broadcaster replaces by child frame; this one does not.)
        # Publishing the message ourselves gives one transform per send, and tf2's static
        # cache overwrites by child frame on receive, so each session re-anchors correctly.
        self._tf_static_pub = self.create_publisher(
            TFMessage, '/tf_static',
            QoSProfile(depth=1,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL,
                       history=HistoryPolicy.KEEP_LAST))

        self._map_save_cli = self.create_client(
            Trigger, '/map_save', callback_group=self._aux_group)

        self.create_service(
            StringTrigger, '~/start_mapping', self._start_cb, callback_group=self._srv_group)
        self.create_service(
            Trigger, '~/stop_mapping', self._stop_cb, callback_group=self._srv_group)

        # Notice a launch that died on its own (crash, or someone killing it by hand) so we
        # do not keep reporting a dead session as active.
        self.create_timer(1.0, self._reap, callback_group=self._aux_group)

        self.get_logger().info(
            f"mapping_manager ready; maps_dir={self.get_parameter('maps_dir').value}")

    # -- helpers ---------------------------------------------------------------

    def _child_alive(self):
        return self._proc is not None and self._proc.poll() is None

    def _param(self, name):
        return self.get_parameter(name).value

    def _reap(self):
        # Never block the timer behind a long stop_mapping.
        if not self._lock.acquire(blocking=False):
            return
        try:
            if self._proc is not None and self._proc.poll() is not None:
                self.get_logger().warning(
                    f'{self._param("launch_file")} exited on its own '
                    f'(rc={self._proc.returncode}); session "{self._map_name}" is over and '
                    'the map was NOT saved.')
                self._proc = None
                self._map_name = None
                self._pcd_path = None
        finally:
            self._lock.release()

    def _publish_anchor(self, looked_up):
        """Latch odom -> camera_init at the value just read for odom -> dog_imu_link.

        Re-sent fresh on every start_mapping. tf2 keys its static cache by child frame and
        overwrites, so session N's anchor replaces session N-1's rather than stacking up.
        Nothing retracts it when a session ends, but camera_init loses its children along
        with FAST-LIO, so a leftover anchor is inert until the next session overwrites it.
        """
        anchor = TransformStamped()
        anchor.header.stamp = self.get_clock().now().to_msg()
        anchor.header.frame_id = self._param('parent_frame')
        anchor.child_frame_id = self._param('child_frame')
        anchor.transform = looked_up.transform
        self._tf_static_pub.publish(TFMessage(transforms=[anchor]))

        t = anchor.transform.translation
        self.get_logger().info(
            f'anchored {anchor.header.frame_id} -> {anchor.child_frame_id} at '
            f'xyz=[{t.x:.3f}, {t.y:.3f}, {t.z:.3f}]')

    def _call_map_save(self):
        """Returns (ok, message). Blocks until the .pcd is written or the timeout expires."""
        timeout = float(self._param('map_save_timeout_sec'))
        if not self._map_save_cli.wait_for_service(timeout_sec=5.0):
            return False, '/map_save is not available (is FAST-LIO up?) -- map NOT saved.'

        future = self._map_save_cli.call_async(Trigger.Request())
        done = threading.Event()
        future.add_done_callback(lambda _f: done.set())
        if not done.wait(timeout):
            future.cancel()
            return False, f'/map_save did not return within {timeout:.0f}s -- map may be incomplete.'

        result = future.result()
        if result is None:
            return False, '/map_save call failed.'
        if not result.success:
            return False, f'/map_save reported failure: {result.message}'
        return True, result.message

    def _terminate_child(self):
        """SIGINT the whole launch process group, escalating if it will not go."""
        proc = self._proc
        if proc is None:
            return 'launch was already stopped.'

        launch_file = self._param('launch_file')
        try:
            pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            self._proc = None
            return f'{launch_file} had already exited.'

        # SIGINT first: that is what `ros2 launch` traps to shut its nodes down in order.
        grace = float(self._param('shutdown_timeout_sec'))
        for sig, wait_s in ((signal.SIGINT, grace), (signal.SIGTERM, 5.0), (signal.SIGKILL, 5.0)):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                break
            try:
                proc.wait(timeout=wait_s)
                break
            except subprocess.TimeoutExpired:
                self.get_logger().warning(
                    f'{launch_file} did not exit on {sig.name}; escalating.')

        self._proc = None
        return f'{launch_file} stopped.'

    def shutdown_child(self):
        """Called on node shutdown so the launch never outlives its manager."""
        with self._lock:
            if self._child_alive():
                self.get_logger().warning(
                    'shutting down with a mapping session active -- the map was NOT saved.')
                self._terminate_child()

    # -- services --------------------------------------------------------------

    def _start_cb(self, request, response):
        name = (request.data or '').strip()
        if not MAP_NAME_RE.match(name):
            response.success = False
            response.message = f"invalid map name '{name}': must match [A-Za-z0-9_]+"
            return response

        with self._lock:
            if self._child_alive():
                response.success = False
                response.message = f'a mapping session is already active ({self._map_name})'
                return response

            maps_dir = os.path.expanduser(self._param('maps_dir'))
            pcd_path = os.path.join(maps_dir, f'{name}.pcd')

            # FAST-LIO's save_to_pcd() hands the path straight to pcl::PCDWriter and does not
            # create the directory, so a missing maps_dir would only surface as a failed save
            # at the very end of the session.
            try:
                os.makedirs(maps_dir, exist_ok=True)
            except OSError as exc:
                response.success = False
                response.message = f'could not create {maps_dir}: {exc}'
                return response

            parent = self._param('parent_frame')
            imu = self._param('imu_frame')
            try:
                looked_up = self._buffer.lookup_transform(
                    parent, imu, Time(),
                    Duration(seconds=float(self._param('tf_lookup_timeout_sec'))))
            except TransformException as exc:
                response.success = False
                response.message = (
                    f'could not look up {parent} -> {imu}: {exc}.')
                return response

            # Anchor before spawning, so camera_init is already placed by the time FAST-LIO
            # emits its first camera_init -> body.
            self._publish_anchor(looked_up)

            cmd = ['ros2', 'launch', self._param('launch_package'), self._param('launch_file'),
                   f'map_file_path:={pcd_path}']
            cmd += [a for a in (self._param('extra_launch_args') or []) if a]

            try:
                # start_new_session gives the launch its own process group, which is what
                # makes the group-kill in stop_mapping reach every node it spawned.
                self._proc = subprocess.Popen(cmd, start_new_session=True, env=os.environ.copy())
            except OSError as exc:
                response.success = False
                response.message = f'could not spawn {" ".join(cmd)}: {exc}'
                return response

            self._map_name = name
            self._pcd_path = pcd_path

        self.get_logger().info(f'mapping session "{name}" started -> {pcd_path}')
        response.success = True
        response.message = f'mapping started; map will be saved to {pcd_path}'
        return response

    def _stop_cb(self, request, response):
        with self._lock:
            if not self._child_alive():
                response.success = False
                response.message = 'no active mapping session'
                return response

            name = self._map_name
            pcd_path = self._pcd_path

            save_ok, save_msg = self._call_map_save()
            if not save_ok:
                self.get_logger().error(f'map save failed for "{name}": {save_msg}')

            kill_msg = self._terminate_child()
            self._map_name = None
            self._pcd_path = None

        self.get_logger().info(f'mapping session "{name}" ended; {kill_msg}')
        response.success = save_ok
        response.message = (
            f'{save_msg} {kill_msg}' if save_ok
            else f'{save_msg} {kill_msg} (session ended anyway; {pcd_path} may be missing)')
        return response


def main():
    rclpy.init()
    node = MappingManagerNode()
    # 4 threads: the service group, the /map_save response, the reaper, and /tf delivery --
    # stop_mapping blocks on two of these at once.
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        node.shutdown_child()
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == '__main__':
    main()
