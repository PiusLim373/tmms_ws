import os
from datetime import datetime

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration

TOPICS = [
    '/topdown_cam/compressed',
    '/wrist_cam/compressed',
    '/third_person_cam/compressed',
    '/quadruped_main_status',
    '/lf/sportmodestate',
    '/lf/odommodestate',
    '/lf/lowstate',
    'api/sport/request',
    'api/sport/response',
    '/api/motion_switcher/request',
    '/api/motion_switcher/response',
    '/dog_odom',
    '/dog_imu_raw',
    '/consolidated_quadruped_cmd_vel',
    '/consolidated_z1_cmd_vel'
    # '/rslidar_points'
]

_DEFAULT_BAG_DIR = os.path.join(
    '/home/htxgrrt/.htxgrrt/bags/ongoing_rosbags',
    'tmms_' + datetime.now().strftime('%Y_%m_%d-%H_%M_%S'))


def generate_launch_description():
    output_arg = DeclareLaunchArgument(
        'output', default_value=_DEFAULT_BAG_DIR,
        description='Output directory for the recorded bag')

    record_process = ExecuteProcess(
        cmd=[
            'ros2', 'bag', 'record',
            '-o', LaunchConfiguration('output'),
            '--storage', 'mcap',
            '--max-bag-size', str(300 * 1024 * 1024),
            *TOPICS,
        ],
        output='screen')

    return LaunchDescription([
        output_arg,
        record_process,
    ])
