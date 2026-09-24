#!/usr/bin/env python3
"""Watches /rosout for a costmap whose cloud buffer has gone stale, and restarts the
publisher that feeds it.

THE FAULT. /rslidar_points_filtered intermittently stops reaching the STVL measurement
buffers in both costmaps while the topic itself keeps publishing at ~8Hz -- `ros2 topic echo`
shows data, `ros2 topic info -v` shows the subscriptions matched, and the costmaps still go
blind. Subscription matching, QoS, TF, stamp rewriting, AMCL, clock skew and startup ordering
have all been ruled out. The one thing that reliably fixes it is restarting the PUBLISHER
(lidar_self_filter) with the subscribers untouched, which is what this node automates until
the root cause is found.

THE SIGNAL. STVL's MeasurementBuffer::UpdatedAtExpectedRate logs

    /rslidar_points_filtered buffer updated in 497.75s, it should be updated every 1.50s.

once per costmap update cycle while the buffer is stale, under the logger names
local_costmap.local_costmap and global_costmap.global_costmap. The age is in the message, so
there is no need to time how long we have been complaining: a 2s blip reports 2s and is
ignored, a real fault reports hundreds and is not.

RECOVERY. Restart the filter, then wait for the complaints to stop. Waiting for silence
rather than for a success code is what handles the seconds during which STVL keeps reporting
a stale age while the filter is still coming back up. Bounded: after max_restart_attempts the
node stops acting and leaves the error raised for the operator, who has the dashboard's
System menu.

WHAT THE ERROR DOES. /system_error is read by tmms_yasmin, which enters its ERROR state,
cancels any active goal (the robot stops) and publishes 'error' on /yasmin_state, which
quadruped_controller mirrors into quadruped_main_status.navigation_state for the UI. Routing
it through the FSM rather than publishing the status directly keeps /yasmin_state
single-writer.
"""

import os
import re
import signal
import subprocess
import threading
import time

import rclpy
from rcl_interfaces.msg import Log
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile
from std_msgs.msg import String

# "<topic> buffer updated in <age>s, it should be updated every <rate>s."
STALE_RE = re.compile(r'^(\S+) buffer updated in ([0-9.]+)s')

LATCHED = QoSProfile(depth=1,
                     durability=DurabilityPolicy.TRANSIENT_LOCAL,
                     history=HistoryPolicy.KEEP_LAST)

# VOLATILE on purpose. /rosout publishers offer TRANSIENT_LOCAL with a 1000-deep history and
# a 10s lifespan, so a durable subscriber would be handed every warning of the last ten
# seconds the instant it connects -- restarting this node would re-raise an error that had
# already cleared.
ROSOUT_QOS = QoSProfile(depth=100)


class ErrorMonitoringNode(Node):

    def __init__(self):
        super().__init__('error_monitoring')

        self.declare_parameter(
            'costmap_loggers',
            ['local_costmap.local_costmap', 'global_costmap.global_costmap'])
        # The log reports the age directly, so this is a threshold on that age, not a
        # patience timer. Missing an update by a couple of seconds is normal.
        self.declare_parameter('stale_threshold_sec', 20.0)
        self.declare_parameter('clear_quiet_sec', 10.0)
        self.declare_parameter('restart_cooldown_sec', 60.0)
        self.declare_parameter('max_restart_attempts', 3)
        # Anchored on the installed executable path, not the bare node name: this is matched
        # against whole command lines and a loose pattern would also match the `ros2 launch`
        # parent.
        self.declare_parameter('filter_pattern', 'lib/pcl_ros/filter_crop_box_node')

        self._lock = threading.Lock()
        self._error_active = False
        self._last_complaint = 0.0
        self._last_restart = 0.0
        self._attempts = 0
        self._gave_up = False

        self._error_pub = self.create_publisher(String, '/system_error', LATCHED)
        # Say "healthy" once rather than staying silent, so a subscriber that connects later
        # gets a definite answer off the latch instead of waiting for the first fault.
        self._error_pub.publish(String(data=''))

        self.create_subscription(Log, '/rosout', self._rosout_cb, ROSOUT_QOS)
        self.create_timer(1.0, self._tick)

        self.get_logger().info(
            f'watching {list(self._param("costmap_loggers"))} for buffers stale by more '
            f'than {self._param("stale_threshold_sec"):.0f}s')

    # -- helpers ---------------------------------------------------------------

    def _param(self, name):
        return self.get_parameter(name).value

    def _now(self):
        """Monotonic seconds. Deliberately not the ROS clock -- every interval here is a
        patience, and none of them should jump if the time source steps."""
        return time.monotonic()

    # -- /rosout ---------------------------------------------------------------

    def _rosout_cb(self, msg):
        if msg.name not in self._param('costmap_loggers'):
            return
        match = STALE_RE.match(msg.msg)
        if match is None:
            return

        topic, age = match.group(1), float(match.group(2))
        if age < float(self._param('stale_threshold_sec')):
            return

        now = self._now()
        restart = False
        reason = None
        with self._lock:
            self._last_complaint = now
            if not self._error_active:
                self._error_active = True
                self._attempts = 0
                self._gave_up = False
                restart = True
                reason = f'{topic} stale in {msg.name} ({age:.0f}s)'
            elif (not self._gave_up
                    and now - self._last_restart > float(self._param('restart_cooldown_sec'))
                    and self._attempts < int(self._param('max_restart_attempts'))):
                restart = True

        if reason is not None:
            self.get_logger().error(f'system_error -> {reason}')
            self._error_pub.publish(String(data=reason))
        if restart:
            self._restart_filter()

    def _tick(self):
        with self._lock:
            if not self._error_active:
                return
            quiet = self._now() - self._last_complaint
            if quiet <= float(self._param('clear_quiet_sec')):
                return
            self._error_active = False
            self._attempts = 0
            self._gave_up = False

        self.get_logger().info(f'system_error cleared after {quiet:.0f}s without a complaint')
        self._error_pub.publish(String(data=''))

    # -- restarting the filter -------------------------------------------------

    def _restart_filter(self):
        with self._lock:
            self._last_restart = self._now()
            self._attempts += 1
            attempt = self._attempts
            last = attempt >= int(self._param('max_restart_attempts'))
            self._gave_up = last

        self.get_logger().warn(
            f'restarting lidar_self_filter (attempt {attempt}/'
            f'{self._param("max_restart_attempts")})'
            + (' -- last attempt, will stop acting after this' if last else ''))
        # Off the callback thread: pgrep plus a signal is quick, but nothing about a
        # subprocess belongs inside a /rosout callback.
        threading.Thread(target=self._signal_filter, daemon=True).start()

    def _signal_filter(self):
        """SIGINT every process matching filter_pattern. launch's respawn brings it back.

        pgrep + os.kill rather than pkill: this is matched against whole command lines, so a
        pattern that ever reaches an argv upstream of us makes the naive version signal
        ourselves or the `ros2 launch` that owns us. Excluding both pids makes that
        impossible by construction rather than by luck -- launch passes parameters in a temp
        YAML today, but that is not a property worth depending on.
        """
        pattern = str(self._param('filter_pattern'))
        try:
            proc = subprocess.run(['pgrep', '-f', pattern],
                                  capture_output=True, text=True, timeout=10.0)
        except (OSError, subprocess.SubprocessError) as err:
            self.get_logger().error(f'pgrep failed: {err}')
            return

        never = {os.getpid(), os.getppid()}
        pids = [int(p) for p in proc.stdout.split() if p.isdigit() and int(p) not in never]
        if not pids:
            # Nothing to signal. Either respawn has not brought it back yet, or it is not
            # running at all -- neither is something to retry here.
            self.get_logger().error(f'no process matching "{pattern}"; nothing to restart')
            return

        for pid in pids:
            try:
                os.kill(pid, signal.SIGINT)
                self.get_logger().info(f'SIGINT -> pid {pid}')
            except OSError as err:
                self.get_logger().error(f'could not signal pid {pid}: {err}')


def main():
    rclpy.init()
    node = ErrorMonitoringNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == '__main__':
    main()
