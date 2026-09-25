"""FAST-LIO2 mapping on the B2's RoboSense RS32: mapping_utils' lidar_converter +
fastlio_mapping.

Normally you do NOT launch this by hand. mapping_utils' mapping_manager_node owns it:

    ros2 service call /mapping_manager/start_mapping tmms_msgs/srv/StringTrigger "{data: my_map}"
    ros2 service call /mapping_manager/stop_mapping  std_srvs/srv/Trigger

which is also what the UI's Mapping Tool widget calls. It is kept out of operation.launch.py
on purpose: mapping is occasional, and running a full LIO stack the rest of the time is real
CPU to burn.

Headless by design -- no RViz. Monitor the run in Lichtblick on /converted_rslidar_points,
/Odometry, /path and /cloud_registered.

For the accumulated map, subscribe to /downsampled_fastlio_map, NOT /Laser_map. /Laser_map is
the whole map re-serialised every second with no deduplication at 48 B/pt -- 41 MB per message
at 855k points and still growing, which rosbridge cannot sustain (the view freezes a minute or
two in). map_downsampler voxelises it to /downsampled_fastlio_map, whose point count saturates
once an area has been covered. Leaving /Laser_map subscribed in Lichtblick defeats this
entirely, so remove it from the panel.

map_downsampler_node itself runs from operation.launch.py, not from here -- its ~/load_pcd
service also serves saved .pcd files during navigation, when this launch is not running. So
/downsampled_fastlio_map appears as soon as this launch starts producing /Laser_map, with no
argument to enable it.

Standalone, if you do need it (defaults are correct for the live system):

    ros2 launch tmms_master fast_lio.launch.py \\
        map_file_path:=/home/htxgrrt/.htxgrrt/maps/pcd/foo.pcd

TF: this launch publishes NOTHING but FAST-LIO's own dynamic camera_init -> body. The tree is
rooted at odom and looks like this:

    odom -(quadruped_controller)-> base_footprint -> base_link -> rslidar, dog_imu_link, ...
      +--(mapping_manager, static)-> camera_init -(FAST-LIO)-> body

quadruped_controller's TF must therefore be RUNNING, not stood down -- mapping_manager reads
odom -> dog_imu_link at session start and latches exactly that as odom -> camera_init.
dog_imu_link IS FAST-LIO's `body` frame (extrinsic_T in the yaml is lidar-w.r.t.-IMU, i.e.
base_link->rslidar minus base_link->dog_imu_link), so that lookup is the true pose of
camera_init and the map lands registered against the live robot model.

Launching standalone skips that anchoring, so camera_init/body is an island with nothing tying
it to the robot. Publish one by hand if you need the connection:

    ros2 run tf2_ros static_transform_publisher --frame-id odom --child-frame-id camera_init ...

This used to publish identity map -> camera_init and map -> odom instead, which was only ever
correct with odom at zero; from any other starting pose the map and the robot were displaced
by exactly the robot's odom pose. Nothing publishes `map` here any more -- Lichtblick's
mapping layout follows odom.

Offline against a bag (bag in another terminal):

    ros2 launch tmms_master fast_lio.launch.py use_sim_time:=true input_best_effort:=false

    ros2 bag play bags/tmms_2026_08_07-16_53_28.mcap -s mcap --clock 500 \\
        --topics /rslidar_points /dog_imu_raw

use_sim_time:=true REQUIRES `--clock` on the bag, otherwise every node's clock stays at 0,
FAST-LIO's 100 Hz timer never fires and it looks hung. input_best_effort:=false because
`ros2 bag play` reproduces the recorded offered QoS, and these bags record /rslidar_points
as RELIABLE.

Saving the map -- you must still call this explicitly, the per-scan save block in
laserMapping.cpp is commented out upstream so pcd_save_en alone writes nothing:

    ros2 service call /map_save std_srvs/srv/Trigger

It writes to the `map_file_path` argument below, which overrides the yaml's value. This has
to be an argument rather than a `ros2 param set`: laserMapping.cpp reads map_file_path into a
global once in its constructor and never re-reads it, so setting the parameter on a running
node silently does nothing. save_to_pcd() does NOT create the directory -- mapping_manager
does that before spawning.

The call blocks until the file is on disk, and the response reports the point count and how
long the write took. It is safe to call at any point in a run, including as a mid-session
checkpoint: the service runs on its own callback group under a MultiThreadedExecutor, so it no
longer freezes the mapping loop. (Before that change a multi-second write starved the IMU
queue, and the EKF then propagated across the gap and diverged -- the camera_init->body TF
would jump ~100 m and the rest of the run was garbage.)

Two things follow from how it works. The file is a snapshot taken when the call is made, so
scans registered during the write land in the live map but not in that file. And Ctrl-C during
a save waits for the write to finish rather than truncating it, so a Ctrl-C that appears to
hang for a few seconds is doing the right thing -- let it finish.

This launch file lives in tmms_master rather than in fast_lio or mapping_utils so the
dependency runs one way only (tmms_master -> {mapping_utils, fast_lio}).
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def generate_launch_description():
    share = get_package_share_directory('tmms_master')
    default_config_file = os.path.join(share, 'config', 'fast_lio_converted_rslidar.yaml')

    args = [
        # False for the real system. The B2 and the lidar share the wall clock.
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
        # Where /map_save writes. Overrides the yaml's value; mapping_manager passes a
        # per-session <maps_dir>/pcd/<map_name>.pcd here. Must be absolute, and the directory
        # must already exist -- save_to_pcd() will not create it.
        DeclareLaunchArgument('map_file_path',
                              default_value='/home/htxgrrt/.htxgrrt/maps/pcd/rslidar_map.pcd'),
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

    # Declared directly rather than including fast_lio's mapping.launch.py, which hardcodes
    # an RViz node and resolves config_file inside fast_lio's own share dir -- our config
    # lives in tmms_master so it survives an upstream pull of the vendored clone.
    #
    # common.lid_topic is overridden from the same `output_topic` arg that configures the
    # converter, so the mapper's input can never drift from the converter's output.
    #
    # map_file_path has no dotted prefix: it is a top-level key in the yaml, matching
    # declare_parameter<string>("map_file_path", "") in laserMapping.cpp.
    fast_lio = Node(
        package='fast_lio',
        executable='fastlio_mapping',
        name='laser_mapping',
        output='screen',
        parameters=[
            LaunchConfiguration('config_file'),
            {
                'use_sim_time': use_sim_time,
                'common.lid_topic': LaunchConfiguration('output_topic'),
                'map_file_path': LaunchConfiguration('map_file_path'),
            },
        ],
    )

    # No static transforms here by design -- mapping_manager_node latches the one that
    # matters (odom -> camera_init) from a live odom -> dog_imu_link lookup at session start.
    # See the TF section of the docstring above.
    #
    # map_downsampler_node is NOT here either: it moved to operation.launch.py, because its
    # ~/load_pcd service has to be reachable during navigation, when this launch is not
    # running. It is a pure subscriber, so it costs nothing while /Laser_map does not exist.

    return LaunchDescription(args + [converter, fast_lio])
