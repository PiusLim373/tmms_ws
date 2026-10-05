import array
import math
import os
import time

import cv2
import numpy as np
import rclpy
import yaml
from rclpy.node import Node
from geometry_msgs.msg import PoseWithCovarianceStamped, Twist
from sensor_msgs.msg import CompressedImage, Joy, LaserScan
from std_srvs.srv import SetBool
from tmms_msgs.msg import QuadrupedMainStatus
from tmms_msgs.srv import RelocalizeTrigger

# Mock camera specs: (width, height)
_CAMERAS = [
    ('/topdown_cam/compressed',      780, 1040),
    ('/third_person_cam/compressed',  640, 480),
    ('/wrist_cam/compressed',         640, 480),
]
_CAM_FPS = 15

# Mirrors tmms_master/config/pointcloud_to_laser_scan.yaml
_SCAN_ANGLE_MIN = -3.14159
_SCAN_ANGLE_MAX = 3.14159
_SCAN_ANGLE_INC = 0.0087
_SCAN_RANGE_MIN = 0.78
_SCAN_RANGE_MAX = 30.0
_SCAN_TIME = 0.1
_SCAN_BEAMS = math.ceil((_SCAN_ANGLE_MAX - _SCAN_ANGLE_MIN) / _SCAN_ANGLE_INC)


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

        # Mock robot: map-frame pose + lidar scan raycast against the 2D map
        self.declare_parameter('maps_dir', os.path.expanduser('~/.htxgrrt/maps'))
        self.declare_parameter('map_name', 'startup_map')
        self._map_name = self.get_parameter('map_name').value
        self._map = self._load_map(self.get_parameter('maps_dir').value, self._map_name)
        self._pose = self._open_spot() if self._map else (0.0, 0.0, 0.0)
        self._ranges = None  # cached until the pose changes
        self._scan_angles = _SCAN_ANGLE_MIN + np.arange(_SCAN_BEAMS) * _SCAN_ANGLE_INC

        self._scan_pub = self.create_publisher(LaserScan, '/rslidar_scan', 10)
        self._status_pub = self.create_publisher(
            QuadrupedMainStatus, '/quadruped_main_status', 10)
        self.create_subscription(
            PoseWithCovarianceStamped, '/lichtblick_initialpose', self._initialpose_cb, 10)
        self.create_service(RelocalizeTrigger, '/relocalize', self._relocalize_cb)

        # Timers
        self.create_timer(0.01, self._publish_tick)          # 100 Hz
        self.create_timer(1.0 / _CAM_FPS, self._cam_tick)   # 15 Hz
        self.create_timer(_SCAN_TIME, self._scan_tick)       # 10 Hz
        self.create_timer(0.2, self._status_tick)            # 5 Hz
        self.create_timer(1.0, self._print_status)           # 1 Hz

        self.get_logger().info('tmms_mock node started')

    def _load_map(self, maps_dir, name):
        yaml_path = os.path.join(maps_dir, 'png', f'{name}.yaml')
        try:
            with open(yaml_path) as f:
                meta = yaml.safe_load(f)
            img_path = os.path.join(os.path.dirname(yaml_path), meta['image'])
            img = cv2.imread(img_path, cv2.IMREAD_GRAYSCALE)
            if img is None:
                raise FileNotFoundError(img_path)
        except Exception as e:
            self.get_logger().error(f'Mock scan disabled, cannot load map {yaml_path}: {e}')
            return None
        # Same thresholding as nav2 map_server
        occ = img.astype(np.float32) / 255.0
        if not meta.get('negate', 0):
            occ = 1.0 - occ
        self.get_logger().info(f'Mock scan raycasting against {yaml_path}')
        return {
            'occupied': occ > meta.get('occupied_thresh', 0.65),
            'free': occ < meta.get('free_thresh', 0.25),
            'res': float(meta['resolution']),
            'ox': float(meta['origin'][0]),
            'oy': float(meta['origin'][1]),
        }

    def _open_spot(self):
        """Free cell with >= 1 m clearance nearest the middle of the mapped obstacles, yaw 0."""
        m = self._map
        free = np.pad(m['free'], 1).astype(np.uint8)  # map edge counts as obstacle
        dist = cv2.distanceTransform(free, cv2.DIST_L2, 5)[1:-1, 1:-1]
        rows, cols = np.nonzero(dist * m['res'] >= 1.0)
        occ_rows, occ_cols = np.nonzero(m['occupied'])
        if len(rows) and len(occ_rows):
            i = np.argmin((rows - occ_rows.mean()) ** 2 + (cols - occ_cols.mean()) ** 2)
            row, col = rows[i], cols[i]
        else:
            row, col = np.unravel_index(np.argmax(dist), dist.shape)
        h = dist.shape[0]
        return (m['ox'] + (col + 0.5) * m['res'], m['oy'] + (h - row - 0.5) * m['res'], 0.0)

    def _raycast(self):
        m = self._map
        occ = m['occupied']
        h, w = occ.shape
        x, y, yaw = self._pose
        steps = np.arange(_SCAN_RANGE_MIN, _SCAN_RANGE_MAX, m['res'])
        a = yaw + self._scan_angles
        # Pixel convention matches worldToPixel in the UI's c2Coords.js
        cols = np.floor((x - m['ox'] + np.outer(steps, np.cos(a))) / m['res']).astype(np.int64)
        rows = np.floor(h - (y - m['oy'] + np.outer(steps, np.sin(a))) / m['res']).astype(np.int64)
        inside = (cols >= 0) & (cols < w) & (rows >= 0) & (rows < h)
        hit = np.zeros(inside.shape, dtype=bool)
        hit[inside] = occ[rows[inside], cols[inside]]
        ranges = np.where(hit.any(axis=0), steps[hit.argmax(axis=0)], np.inf)
        return array.array('f', ranges.astype(np.float32).tobytes())

    def _initialpose_cb(self, msg):
        p = msg.pose.pose
        q = p.orientation
        yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))
        self._pose = (p.position.x, p.position.y, yaw)
        self._ranges = None
        self.get_logger().info(
            f'Mock robot moved to x={p.position.x:.2f} y={p.position.y:.2f} yaw={yaw:.2f}')

    def _relocalize_cb(self, request, response):
        # Mirrors localization_manager's /relocalize: switch map, then pose. Always converges.
        name = request.map_name.strip()
        loaded = self._load_map(self.get_parameter('maps_dir').value, name)
        if loaded is None:
            response.success = False
            response.message = f"Relocalize rejected: map '{name}' not found"
            return response
        self._map, self._map_name = loaded, name
        self._initialpose_cb(request.initial_pose)
        response.success = True
        response.message = f"Mock relocalized on '{name}'"
        return response

    def _scan_tick(self):
        if self._map is None:
            return
        if self._ranges is None:
            self._ranges = self._raycast()
        msg = LaserScan()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'base_footprint'
        msg.angle_min = _SCAN_ANGLE_MIN
        msg.angle_max = _SCAN_ANGLE_MAX
        msg.angle_increment = _SCAN_ANGLE_INC
        msg.scan_time = _SCAN_TIME
        msg.range_min = _SCAN_RANGE_MIN
        msg.range_max = _SCAN_RANGE_MAX
        msg.ranges = self._ranges
        self._scan_pub.publish(msg)

    def _status_tick(self):
        x, y, yaw = self._pose
        s = QuadrupedMainStatus()
        s.pose.position.x = float(x)
        s.pose.position.y = float(y)
        s.pose.orientation.z = math.sin(yaw / 2.0)
        s.pose.orientation.w = math.cos(yaw / 2.0)
        s.battery_percentage = 80
        s.robot_mode = QuadrupedMainStatus.BALANCE_STAND
        s.navigation_state = QuadrupedMainStatus.IDLE
        s.localization_status = QuadrupedMainStatus.LOCALIZED
        s.current_map = self._map_name
        self._status_pub.publish(s)

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
