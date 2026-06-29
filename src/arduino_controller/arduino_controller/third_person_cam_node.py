import time
import serial
import rclpy
from rclpy.node import Node
from tmms_msgs.srv import StringTrigger

CMD_MAP = {
    'pitch+': b'w',
    'pitch-': b's',
    'yaw+':   b'd',
    'yaw-':   b'a',
    'z+':     b'f',
    'z-':     b'r',
}


class ThirdPersonCamNode(Node):
    def __init__(self):
        super().__init__('third_person_cam_node')
        self.ser = serial.Serial('/dev/ttyUSB0', 9600, timeout=1)
        time.sleep(1)
        self.create_service(StringTrigger, 'third_person_cam_control', self.callback)

    def callback(self, request, response):
        char = CMD_MAP.get(request.data)
        if char is not None:
            self.ser.write(char)
            response.success = True
            response.message = ''
        else:
            response.success = False
            response.message = f'Unknown command: {request.data}'
        return response


def main():
    rclpy.init()
    node = ThirdPersonCamNode()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
