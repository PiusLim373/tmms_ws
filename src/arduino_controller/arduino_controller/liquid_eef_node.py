import time
import serial
import rclpy
from rclpy.node import Node
from tmms_msgs.srv import StringTrigger


class LiquidEefNode(Node):
    def __init__(self):
        super().__init__('liquid_eef_node')
        self.ser = serial.Serial('/dev/ttyACM0', 9600, timeout=1)
        time.sleep(1)
        self.create_service(StringTrigger, 'liquid_eef_control', self.callback)

    def callback(self, request, response):
        if request.data == 'suck':
            self.ser.write(b'2')
            time.sleep(1)
            self.ser.write(b'1')
            response.success = True
            response.message = ''
        elif request.data == 'eject':
            self.ser.write(b'4')
            time.sleep(1)
            self.ser.write(b'3')
            response.success = True
            response.message = ''
        else:
            response.success = False
            response.message = f'Unknown command: {request.data}'
        return response


def main():
    rclpy.init()
    node = LiquidEefNode()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
