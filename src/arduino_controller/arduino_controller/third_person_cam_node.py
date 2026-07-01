import time
import serial
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

CMD_MAP = {
    'pitch+': b'w',
    'pitch-': b's',
    'yaw+':   b'a',
    'yaw-':   b'd',
    'z+':     b'r',
    'z-':     b'f',
}


class ThirdPersonCamNode(Node):
    def __init__(self):
        super().__init__('third_person_cam_node')
        self.ser = serial.Serial('/dev/ttyUSB0', 9600, timeout=1)
        time.sleep(1)
        self.create_subscription(String, 'third_person_cam_control', self.callback, 10)

    def callback(self, msg):
        char = CMD_MAP.get(msg.data)
        if char is not None:
            self.ser.write(char)
        else:
            self.get_logger().warn(f"Unknown command: {msg.data}")


def main():
    rclpy.init()
    node = ThirdPersonCamNode()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
