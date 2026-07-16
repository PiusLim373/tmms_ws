import os
import platform

from launch import LaunchDescription
from launch.actions import ExecuteProcess, IncludeLaunchDescription, TimerAction
from launch.launch_description_sources import (
    AnyLaunchDescriptionSource, PythonLaunchDescriptionSource)
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory

_Z1_CTRL_BIN_BY_ARCH = {
    'aarch64': 'z1_ctrl_arm64',
    'arm64': 'z1_ctrl_arm64',
    'x86_64': 'z1_ctrl_x86',
    'amd64': 'z1_ctrl_x86',
}


def generate_launch_description():
    pkg_share = get_package_share_directory('z1_robot_controller')
    z1_ctrl_bin_dir = os.path.join(pkg_share, 'bin')
    z1_lib_dir = os.path.join(pkg_share, 'lib')

    machine = platform.machine()
    z1_ctrl_bin = _Z1_CTRL_BIN_BY_ARCH.get(machine)
    if z1_ctrl_bin is None:
        raise RuntimeError(
            f"z1_robot_controller: no z1_ctrl binary for architecture '{machine}'")

    existing_ld = os.environ.get('LD_LIBRARY_PATH', '')
    new_ld = f'{z1_lib_dir}:{existing_ld}' if existing_ld else z1_lib_dir

    return LaunchDescription([
        # Standalone z1_ctrl UDP service — NOT a ROS node
        # runs from z1_ctrl_bin/ so ../config/ resolves to config/
        ExecuteProcess(
            cmd=[f'./{z1_ctrl_bin}'],
            cwd=z1_ctrl_bin_dir,
            additional_env={'LD_LIBRARY_PATH': new_ld},
            output='screen'),

        # Z1 arm ROS2 controller
        Node(
            package='z1_robot_controller',
            executable='z1_robot_controller_node',
            name='z1_robot_controller',
            output='screen'),

        # Remaining nodes start 5s after z1_ctrl_bin/spacenav/z1_robot_controller
        # come up — starting everything at once was causing the z1 gripper
        # bin to fail to connect.
        TimerAction(
            period=5.0,
            actions=[
                # B2 quadruped controller
                Node(
                    package='quadruped_controller',
                    executable='quadruped_controller_node',
                    name='quadruped_controller',
                    output='screen'),

                # Rosbridge WebSocket server (exposes ROS2 topics over wss://
                # — the dashboard now loads over https, and browsers block a
                # plain ws:// connection from an https page as mixed content)
                IncludeLaunchDescription(
                    AnyLaunchDescriptionSource([
                        get_package_share_directory('rosbridge_server'),
                        '/launch/rosbridge_websocket_launch.xml',
                    ]),
                    launch_arguments={
                        'ssl': 'true',
                        'certfile': '/home/htxgrrt/.htxgrrt/certs/tmms_b2.crt',
                        'keyfile': '/home/htxgrrt/.htxgrrt/certs/tmms_b2.key',
                    }.items()),

                # Rosbag recording (cameras + quadruped status)
                IncludeLaunchDescription(
                    PythonLaunchDescriptionSource([
                        get_package_share_directory('tmms_master'),
                        '/launch/rosbag_record.launch.py',
                    ])),
            ]),
    ])
