import math
import time

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from sensor_msgs.msg import CompressedImage, Joy
from std_srvs.srv import SetBool

# Mock camera specs: (width, height)
_CAMERAS = [
    ('/topdown_cam/compressed',      780, 1040),
    ('/third_person_cam/compressed',  640, 480),
    ('/wrist_cam/compressed',         640, 480),
]
_CAM_FPS = 15


class TmmsMockNode(Node):
    def __init__(self):
        super().__init__('tmms_mock')

        self._spacemouse_on = False
        self._flight_ctrl_on = False
        self._last_z1_twist = None
        self._last_quad_twist = None

        # Publishers — simulate physical devices only
        self._spacenav_joy_pub = self.create_publisher(Joy, '/spacenav/joy', 10)
        self._joy_pub = self.create_publisher(Joy, '/joy', 10)

        # Mock camera publishers
        self._cam_pubs = [
            (self.create_publisher(CompressedImage, topic, 10), w, h)
            for topic, w, h in _CAMERAS
        ]

        # Subscriptions — monitor consolidated pipeline output from real controller nodes
        self.create_subscription(Twist, '/consolidated_z1_cmd_vel', self._z1_cb, 10)
        self.create_subscription(Twist, '/consolidated_quadruped_cmd_vel', self._quad_cb, 10)

        # Device-connection SetBool services
        self.create_service(SetBool, 'connect_spacemouse', self._connect_spacemouse)
        self.create_service(SetBool, 'connect_flight_controller', self._connect_flight_controller)

        # Timers
        self.create_timer(0.01, self._publish_tick)          # 100 Hz
        self.create_timer(1.0 / _CAM_FPS, self._cam_tick)   # 15 Hz
        self.create_timer(1.0, self._print_status)           # 1 Hz

        self.get_logger().info('tmms_mock node started')

    def _z1_cb(self, msg):
        self._last_z1_twist = msg

    def _quad_cb(self, msg):
        self._last_quad_twist = msg

    def _connect_spacemouse(self, req, res):
        self._spacemouse_on = req.data
        state = 'connected' if req.data else 'disconnected'
        self.get_logger().info(f'SpaceMouse {state}')
        res.success = True
        res.message = f'SpaceMouse {state}'
        return res

    def _connect_flight_controller(self, req, res):
        self._flight_ctrl_on = req.data
        state = 'connected' if req.data else 'disconnected'
        self.get_logger().info(f'Flight controller {state}')
        res.success = True
        res.message = f'Flight controller {state}'
        return res

    def _cam_tick(self):
        t = time.monotonic()
        hue = int((t * 30) % 180)
        stamp = self.get_clock().now().to_msg()
        for pub, w, h in self._cam_pubs:
            frame = np.full((h, w, 3), [hue, 200, 180], dtype=np.uint8)
            frame = cv2.cvtColor(frame, cv2.COLOR_HSV2BGR)
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
            msg = CompressedImage()
            msg.header.stamp = stamp
            msg.format = 'jpeg'
            msg.data = buf.tobytes()
            pub.publish(msg)

    def _publish_tick(self):
        t = self.get_clock().now().nanoseconds * 1e-9

        if self._spacemouse_on:
            axes = [0.5 * math.sin(t + i * 0.5) for i in range(6)]
            joy = Joy()
            joy.header.stamp = self.get_clock().now().to_msg()
            joy.axes = axes
            joy.buttons = [0, 0]
            self._spacenav_joy_pub.publish(joy)

        if self._flight_ctrl_on:
            axes = [0.5 * math.sin(t + i * 0.5) for i in range(6)]
            joy = Joy()
            joy.header.stamp = self.get_clock().now().to_msg()
            joy.axes = axes
            joy.buttons = [0] * 29
            self._joy_pub.publish(joy)

    def _print_status(self):
        if self._last_z1_twist:
            tw = self._last_z1_twist
            self.get_logger().info(
                f'Z1  consolidated | '
                f'lx={tw.linear.x:.3f} ly={tw.linear.y:.3f} lz={tw.linear.z:.3f} '
                f'ax={tw.angular.x:.3f} ay={tw.angular.y:.3f} az={tw.angular.z:.3f}')
        else:
            self.get_logger().info('Z1  consolidated | (no data)')

        if self._last_quad_twist:
            tw = self._last_quad_twist
            self.get_logger().info(
                f'Quad consolidated | '
                f'lx={tw.linear.x:.3f} ly={tw.linear.y:.3f} az={tw.angular.z:.3f}')
        else:
            self.get_logger().info('Quad consolidated | (no data)')


def main(args=None):
    rclpy.init(args=args)
    node = TmmsMockNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
