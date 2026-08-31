"""FAST-LIVO2 mapping on the B2: mapping_utils' lidar_converter + fastlivo_mapping
(RS32 + front RealSense).

Headless by design -- no RViz. Monitor the run in Lichtblick on /converted_rslidar_points
and the mapper's /cloud_registered, /aft_mapped_to_init and /rgb_img.

The RealSense is NOT started here -- it runs in its own container (app/tmms_realsense,
camera_front at 848x480x30). Bring that up first, or the VIO half never gets an image and
the run silently degrades to LIO-only.

Live system (defaults are already correct for it):

    ros2 launch tmms_master fast_livo.launch.py

Offline against bags (in another terminal):

    ros2 launch tmms_master fast_livo.launch.py use_sim_time:=true input_best_effort:=false

    ros2 bag play -i bags/tmms_2026_08_07-16_52_05.mcap mcap \\
                  -i bags/tmms_2026_08_07-16_52_47.mcap mcap \\
                  -i bags/tmms_2026_08_07-16_53_28.mcap mcap \\
                  --clock 500 -r 0.3 \\
                  --topics /rslidar_points /dog_imu_raw /camera/camera_front/color/image_raw

The three bags are contiguous splits of one 104 s recording (~2 ms gaps), so `-i` repeated
plays them as a single continuous session.

-r 0.3 because 30 Hz VIO + 10 Hz LIO runs slower than realtime. The mapper's subscriptions
are 200000-deep, so nothing gets dropped at full rate -- it just falls behind and grows
memory.

use_sim_time:=true REQUIRES `--clock` on the bag.

img_en:=0 runs LIO-only, which isolates lidar-inertial problems from camera-extrinsic ones.

Ctrl-C THIS launch (not the bag) when the run finishes: savePCD() runs only after run()'s
rclcpp::ok() loop exits, so SIGINT is what writes the map. The output path is compiled into
the binary as ROOT_DIR/Log/PCD/ -> tmms_ws/src/tmms_mapping/src/FAST-LIVO2-ROS2/Log/PCD/
(all_raw_points.pcd, all_downsampled_points.pcd). Killing harder than SIGINT loses the map.

This launch file lives in tmms_master rather than in fast_livo or mapping_utils so the
dependency runs one way only (tmms_master -> {mapping_utils, fast_livo}).
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def generate_launch_description():
    default_config_file = os.path.join(
        get_package_share_directory('tmms_master'),
        'config', 'fast_livo_converted_rslidar.yaml')

    args = [
        # False for the real system. The B2, the lidar and the camera share the wall clock.
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        DeclareLaunchArgument('input_topic', default_value='/rslidar_points'),
        DeclareLaunchArgument('output_topic', default_value='/converted_rslidar_points'),
        DeclareLaunchArgument('output_frame_id', default_value='rslidar'),
        # Set false to A/B the scan-end-stamp correction: with it off you should see
        # ~100 ms of LiDAR-vs-IMU offset and visibly smeared walls during turns.
        DeclareLaunchArgument('rewrite_stamp_to_scan_start', default_value='true'),
        # true for the live rslidar_sdk driver (BEST_EFFORT); false for bag replay.
        DeclareLaunchArgument('input_best_effort', default_value='true'),
        DeclareLaunchArgument('config_file', default_value=default_config_file),
        # 0 runs LIO-only, which isolates lidar-inertial problems from camera-extrinsic ones.
        DeclareLaunchArgument('img_en', default_value='1'),
    ]

    # A bare LaunchConfiguration is a string; wrap non-string types in ParameterValue or
    # ROS 2 throws InvalidParameterTypeException.
    use_sim_time = ParameterValue(LaunchConfiguration('use_sim_time'), value_type=bool)

    converter = Node(
        package='mapping_utils',
        executable='lidar_converter_node',
        name='lidar_converter',
        output='screen',
        parameters=[{
            'input_topic': LaunchConfiguration('input_topic'),
            'output_topic': LaunchConfiguration('output_topic'),
            'output_frame_id': LaunchConfiguration('output_frame_id'),
            'rewrite_stamp_to_scan_start': ParameterValue(
                LaunchConfiguration('rewrite_stamp_to_scan_start'), value_type=bool),
            'input_best_effort': ParameterValue(
                LaunchConfiguration('input_best_effort'), value_type=bool),
            'sort_by_time': True,
            'n_scans': 32,
            'min_range': 0.0,
            'use_sim_time': use_sim_time,
        }],
    )

    # Declared directly rather than including fast_livo's mapping_general.launch.py, which
    # hardcodes the NTU_VIRAL config and its rviz file.
    #
    # common.lid_topic is overridden from the same `output_topic` arg that configures the
    # converter, so the mapper's input can never drift from the converter's output.
    fast_livo = Node(
        package='fast_livo',
        executable='fastlivo_mapping',
        name='laserMapping',
        output='screen',
        parameters=[
            LaunchConfiguration('config_file'),
            {
                'use_sim_time': use_sim_time,
                'common.lid_topic': LaunchConfiguration('output_topic'),
                # Overrides the value in the yaml so LIO-only is a launch arg, not an edit.
                'common.img_en': ParameterValue(
                    LaunchConfiguration('img_en'), value_type=int),
            },
        ],
    )

    return LaunchDescription(args + [converter, fast_livo])
