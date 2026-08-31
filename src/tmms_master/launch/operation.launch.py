import os
import platform

from launch import LaunchDescription
from launch.actions import ExecuteProcess, IncludeLaunchDescription, TimerAction
from launch.launch_description_sources import (
    AnyLaunchDescriptionSource, PythonLaunchDescriptionSource)
from launch.substitutions import Command
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
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

    description_share = get_package_share_directory('tmms_description')
    urdf_path = os.path.join(description_share, 'urdf', 'tmms_description.urdf.xacro')
    robot_description = ParameterValue(Command(['xacro ', urdf_path]), value_type=str)

    return LaunchDescription([
        # Publishes robot_description + TF for the URDF's kinematic tree from
        Node(
            package='robot_state_publisher',
            executable='robot_state_publisher',
            name='robot_state_publisher',
            output='screen',
            parameters=[{'robot_description': robot_description}]),

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

                # Starts/stops fast_lio.launch.py on request. That launch is deliberately
                # NOT included here -- mapping is occasional, and map_downsampler_node
                # voxelising /Laser_map at 1 Hz is real CPU to burn the rest of the time.
                # Listed after quadruped_controller because it anchors camera_init from a
                # live odom -> dog_imu_link lookup, which needs that node's TF flowing.
                Node(
                    package='mapping_utils',
                    executable='mapping_manager_node.py',
                    name='mapping_manager',
                    output='screen',
                    parameters=[{'maps_dir': '/home/htxgrrt/.htxgrrt/maps'}]),

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
                        'max_message_size': '50000000',
                        'use_compression': 'true',
                    }.items()),

                # Rosbag recording (cameras + quadruped status)
                IncludeLaunchDescription(
                    PythonLaunchDescriptionSource([
                        get_package_share_directory('tmms_master'),
                        '/launch/rosbag_record.launch.py',
                    ])),

            ]),
    ])
