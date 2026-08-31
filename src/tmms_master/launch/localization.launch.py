"""Localization half of the nav2 stack for the B2: map_server + amcl.

FORKED from nav2_bringup/launch/localization_launch.py (ROS 2 Jazzy). It is a point-in-time
copy and will NOT track upstream. After a nav2 upgrade, diff it:

    diff <this file> /opt/ros/jazzy/share/nav2_bringup/launch/localization_launch.py

Differences from upstream, all deliberate:

  * No namespace support -- see the note in navigation.launch.py.
  * ParameterFile(params_file) instead of ParameterFile(RewrittenYaml(...)), same reasoning.
  * use_sim_time pinned False.
  * ONE map_server instead of two. Upstream declares the node twice, gated on
    EqualsSubstitution(map, ''), purely so the params-file yaml_filename wins when no map
    argument is given. config/nav2_params.yaml keeps its map_server block commented out, so
    a single node that always receives {'yaml_filename': map} is identical in behaviour and
    half the code.

`map` defaults to '' and normally stays that way. map_server's on_configure treats an empty
yaml_filename as valid -- it logs "yaml-filename parameter is empty, set map through
'<service>'-service" and still returns SUCCESS -- and AMCL's on_activate does not wait for a
map either, it only warns "Waiting for map...." from laserReceived until one arrives. So the
pair autostarts holding nothing, which IS the Unlocalized state, and the UI drives
mapping_manager -> /map_server/load_map to leave it.

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
        DeclareLaunchArgument(
            'map', default_value='',
            description='Optional map yaml to preload. Normally left empty -- maps are '
                        'loaded at runtime through /map_server/load_map.'),
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
