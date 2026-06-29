import os

from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    pkg_share = get_package_share_directory('z1_robot_controller')
    z1_ctrl_bin_dir = os.path.join(pkg_share, 'bin')
    z1_lib_dir = os.path.join(pkg_share, 'lib')

    existing_ld = os.environ.get('LD_LIBRARY_PATH', '')
    new_ld = f'{z1_lib_dir}:{existing_ld}' if existing_ld else z1_lib_dir

    return LaunchDescription([
        # Standalone z1_ctrl UDP service — NOT a ROS node
        # runs from z1_ctrl_bin/ so ../config/ resolves to config/
        ExecuteProcess(
            cmd=['./z1_ctrl'],
            cwd=z1_ctrl_bin_dir,
            additional_env={'LD_LIBRARY_PATH': new_ld},
            output='screen'),

        # SpaceNavigator driver
        Node(
            package='spacenav',
            executable='spacenav_node',
            name='spacenav',
            output='screen'),

        # Z1 arm ROS2 controller
        Node(
            package='z1_robot_controller',
            executable='z1_robot_controller_node',
            name='z1_robot_controller',
            output='screen'),

        # Gamepad driver (publishes /joy)
        Node(
            package='joy',
            executable='joy_node',
            name='joy',
            output='screen'),

        # B2 quadruped controller
        Node(
            package='quadruped_controller',
            executable='quadruped_controller_node',
            name='quadruped_controller',
            output='screen'),
    ])
