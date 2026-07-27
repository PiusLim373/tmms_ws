import os
from datetime import datetime

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration
from os.path import expanduser

# Instead of: "/home/htxgrrt/.htxgrrt/bags/..."
# Use:
home_dir = expanduser("~")
bag_path = os.path.join(home_dir, ".htxgrrt", "bags", "ongoing_rosbags")

TOPICS = [
    '/topdown_cam/compressed',
    '/wrist_cam/compressed',
    '/third_person_cam/compressed',
    '/quadruped_main_status',
    '/lf/sportmodestate',
    '/lf/odommodestate',
    '/lf/lowstate',
    
]

_DEFAULT_BAG_DIR = os.path.join(
    bag_path,
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
            '--max-bag-size', str(200 * 1024 * 1024),
            *TOPICS,
        ],
        output='screen')

    return LaunchDescription([
        output_arg,
        record_process,
    ])
