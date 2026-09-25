"""Localization half of the nav2 stack for the B2: map_server + amcl.

FORKED from nav2_bringup/launch/localization_launch.py (ROS 2 Jazzy). It is a point-in-time
copy and will NOT track upstream. After a nav2 upgrade, diff it:

    diff <this file> /opt/ros/jazzy/share/nav2_bringup/launch/localization_launch.py

Differences from upstream, all deliberate:

  * No namespace support -- see the note in navigation.launch.py.
  * ParameterFile(params_file) instead of ParameterFile(RewrittenYaml(...)), same reasoning.
  * use_sim_time pinned False.
  * ONE map_server instead of two. Upstream declares the node twice, gated on
    EqualsSubstitution(map, ''), purely so a params-file yaml_filename can win when no map
    argument is given. Here `map` always carries a real path (see below), so the override
    always wins and a single node is identical in behaviour and half the code.
    NOTE: this is exactly why config/nav2_params.yaml must NOT carry a map_server block --
    parameters=[configured_params, {'yaml_filename': map_yaml_file}] puts the dict last, so
    anything set there is silently overridden and the file lies about what is loaded.

`map` defaults to config/startup_map.yaml, NOT ''. That is load-bearing, not convenience.
AMCL broadcasts map -> odom only from sendMapToOdomTransform, which is reachable solely from
laserReceived and gated on BOTH first_map_received_ and initial_pose_is_known_. The startup
map opens the first gate; amcl's set_initial_pose: true in nav2_params.yaml opens the second.
Without both, global_costmap's on_activate blocks on map -> base_footprint, gives up after
initial_transform_timeout (60s), and lifecycle_manager aborts the whole navigation half with
no retry -- see the comment above the bringup include in operation.launch.py.

The consequence to keep in mind: the pair no longer autostarts holding nothing, so "AMCL is
publishing TF" is NO LONGER the same thing as "the robot is localized". The startup map is a
throwaway and the seed pose is (0,0,0). Unlocalized is now a state only localization_manager
tracks; nothing downstream may infer it from AMCL liveness. The UI still drives
mapping_manager -> /map_server/load_map to load the real map, and AMCL picks up the swap
because first_map_only defaults to false.

Service names are inconsistent upstream and worth knowing: map_server prefixes its node name
(/map_server/load_map, /map_server/map) while AMCL's are root-relative
(/set_initial_pose, /reinitialize_global_localization, /request_nomotion_update) -- they are
NOT under /amcl.
"""

import os

from ament_index_python.packages import get_package_share_directory

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, GroupAction, SetEnvironmentVariable
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import LoadComposableNodes, Node, SetParameter
from launch_ros.descriptions import ComposableNode, ParameterFile


def generate_launch_description():
    master_share = get_package_share_directory('tmms_master')
    default_params_file = os.path.join(master_share, 'config', 'nav2_params.yaml')

    params_file = LaunchConfiguration('params_file')
    map_yaml_file = LaunchConfiguration('map')
    autostart = LaunchConfiguration('autostart')
    use_composition = LaunchConfiguration('use_composition')
    container_name = LaunchConfiguration('container_name')
    use_respawn = LaunchConfiguration('use_respawn')
    log_level = LaunchConfiguration('log_level')

    container_name_full = ('/', container_name)

    lifecycle_nodes = ['map_server', 'amcl']

    configured_params = ParameterFile(params_file, allow_substs=True)

    load_nodes = GroupAction(
        condition=IfCondition(PythonExpression(['not ', use_composition])),
        actions=[
            SetParameter('use_sim_time', False),
            Node(
                package='nav2_map_server',
                executable='map_server',
                name='map_server',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params, {'yaml_filename': map_yaml_file}],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_amcl',
                executable='amcl',
                name='amcl',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_lifecycle_manager',
                executable='lifecycle_manager',
                name='lifecycle_manager_localization',
                output='screen',
                arguments=['--ros-args', '--log-level', log_level],
                parameters=[{'autostart': autostart}, {'node_names': lifecycle_nodes}],
            ),
        ],
    )

    load_composable_nodes = GroupAction(
        condition=IfCondition(use_composition),
        actions=[
            SetParameter('use_sim_time', False),
            LoadComposableNodes(
                target_container=container_name_full,
                composable_node_descriptions=[
                    ComposableNode(
                        package='nav2_map_server',
                        plugin='nav2_map_server::MapServer',
                        name='map_server',
                        parameters=[configured_params,
                                    {'yaml_filename': map_yaml_file}],
                    ),
                    ComposableNode(
                        package='nav2_amcl',
                        plugin='nav2_amcl::AmclNode',
                        name='amcl',
                        parameters=[configured_params],
                    ),
                    ComposableNode(
                        package='nav2_lifecycle_manager',
                        plugin='nav2_lifecycle_manager::LifecycleManager',
                        name='lifecycle_manager_localization',
                        parameters=[
                            {'autostart': autostart, 'node_names': lifecycle_nodes}
                        ],
                    ),
                ],
            ),
        ],
    )

    return LaunchDescription([
        SetEnvironmentVariable('RCUTILS_LOGGING_BUFFERED_STREAM', '1'),

        DeclareLaunchArgument(
            'params_file', default_value=default_params_file,
            description='Nav2 parameters for the B2'),
        # Deliberately a throwaway map, not a real one. It exists so map_server holds
        # SOMETHING at boot, which sets AMCL's first_map_received_ and -- together with
        # set_initial_pose: true -- gets map -> odom broadcast before global_costmap's
        # on_activate times out waiting for it. The operator's real map replaces it at
        # runtime through /map_server/load_map; first_map_only defaults to false, so both
        # AMCL and global_costmap's static_layer pick up the swap.
        #
        # If you replace startup_map.yaml: keep free space in it (AMCL's
        # createFreeSpaceVector collects occ_state == -1 cells), keep it at 0.02 to match
        # what pcd2pgm produces so global_costmap is not resized on every load, keep (0,0)
        # inside its bounds so the (0,0,0) seed pose is valid, and keep the PNG fully
        # opaque -- map_io.cpp forces every pixel with alpha < 255 to UNKNOWN, which would
        # load the whole thing as unknown space.
        DeclareLaunchArgument(
            'map',
            default_value=os.path.join(master_share, 'config', 'startup_map.yaml'),
            description='Map yaml preloaded at startup. Defaults to the throwaway '
                        'startup_map that unblocks nav2 bringup; the real map is loaded '
                        'at runtime through /map_server/load_map.'),
        DeclareLaunchArgument(
            'autostart', default_value='true',
            description='Have the lifecycle manager configure+activate on startup'),
        DeclareLaunchArgument(
            'use_composition', default_value='True',
            description='Load into the shared component container'),
        DeclareLaunchArgument(
            'container_name', default_value='nav2_container',
            description='Container to load into when use_composition is True'),
        DeclareLaunchArgument(
            'use_respawn', default_value='False',
            description='Respawn on crash. Uncomposed only.'),
        DeclareLaunchArgument(
            'log_level', default_value='info', description='log level'),

        load_nodes,
        load_composable_nodes,
    ])
