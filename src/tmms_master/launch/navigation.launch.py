"""Navigation half of the nav2 stack for the B2.

FORKED from nav2_bringup/launch/navigation_launch.py (ROS 2 Jazzy). It is a point-in-time
copy and will NOT track upstream. After a nav2 upgrade, diff it:

    diff <this file> /opt/ros/jazzy/share/nav2_bringup/launch/navigation_launch.py

Forked so the node list and remappings are visible and tunable here rather than buried in
/opt/ros/jazzy. Differences from upstream, all deliberate:

  * No namespace support. `namespace`, `use_namespace`, PushROSNamespace and the
    remappings=[('/tf','tf'), ('/tf_static','tf_static')] list are gone -- that remap list
    exists only so tf gets namespaced, and with no namespace '/tf' -> 'tf' resolves straight
    back to '/tf'. The cmd_vel remaps below are NOT in that category; they are functional.
  * ParameterFile(params_file) instead of ParameterFile(RewrittenYaml(...)). RewrittenYaml's
    two jobs here were root_key=namespace (gone) and param_rewrites={'autostart': ...},
    which is a no-op because config/nav2_params.yaml has no 'autostart' key to rewrite.
  * use_sim_time is pinned False rather than being an argument. This is a real robot.

All ten lifecycle nodes are retained for now. smoother_server, route_server,
waypoint_follower and docking_server are never reached by the default
navigate_to_pose_w_replanning_and_recovery.xml tree (its action nodes are ComputePathToPose,
FollowPath, Spin, BackUp, Wait, ClearEntireCostmap), so they configure, activate and then
block on an action goal that never arrives. Trim them here once the robot is navigating.

Velocity chain, which the cmd_vel_nav remaps below create:
    controller/behavior -> cmd_vel_nav -> velocity_smoother -> cmd_vel_smoothed
                        -> collision_monitor -> cmd_vel
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
    autostart = LaunchConfiguration('autostart')
    use_composition = LaunchConfiguration('use_composition')
    container_name = LaunchConfiguration('container_name')
    use_respawn = LaunchConfiguration('use_respawn')
    log_level = LaunchConfiguration('log_level')

    container_name_full = ('/', container_name)

    lifecycle_nodes = [
        'controller_server',
        'smoother_server',
        'planner_server',
        'route_server',
        'behavior_server',
        'velocity_smoother',
        'collision_monitor',
        'bt_navigator',
        'waypoint_follower',
        'docking_server',
    ]

    configured_params = ParameterFile(params_file, allow_substs=True)

    # One process per node. Only reachable with use_composition:=False, which is the
    # debugging mode -- per-node logs, per-node CPU in top, and respawn actually works.
    load_nodes = GroupAction(
        condition=IfCondition(PythonExpression(['not ', use_composition])),
        actions=[
            SetParameter('use_sim_time', False),
            # Upstream gives this node no name= argument, unlike every other node in the
            # file. Kept as-is: adding one would be a behaviour change.
            Node(
                package='nav2_controller',
                executable='controller_server',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
                remappings=[('cmd_vel', 'cmd_vel_nav')],
            ),
            Node(
                package='nav2_smoother',
                executable='smoother_server',
                name='smoother_server',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_planner',
                executable='planner_server',
                name='planner_server',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_route',
                executable='route_server',
                name='route_server',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_behaviors',
                executable='behavior_server',
                name='behavior_server',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
                remappings=[('cmd_vel', 'cmd_vel_nav')],
            ),
            Node(
                package='nav2_bt_navigator',
                executable='bt_navigator',
                name='bt_navigator',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_waypoint_follower',
                executable='waypoint_follower',
                name='waypoint_follower',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_velocity_smoother',
                executable='velocity_smoother',
                name='velocity_smoother',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
                remappings=[('cmd_vel', 'cmd_vel_nav')],
            ),
            # Last link to /cmd_vel. Its observation source must exist: a source that has
            # never published makes process() take action_type = STOP with req_vel zeroed
            # ("Robot to stop due to invalid source."), silently zeroing every command nav2
            # produces. config/nav2_params.yaml points it at /rslidar_scan.
            Node(
                package='nav2_collision_monitor',
                executable='collision_monitor',
                name='collision_monitor',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            # package, executable and name all differ here.
            Node(
                package='opennav_docking',
                executable='opennav_docking',
                name='docking_server',
                output='screen',
                respawn=use_respawn,
                respawn_delay=2.0,
                parameters=[configured_params],
                arguments=['--ros-args', '--log-level', log_level],
            ),
            Node(
                package='nav2_lifecycle_manager',
                executable='lifecycle_manager',
                name='lifecycle_manager_navigation',
                output='screen',
                arguments=['--ros-args', '--log-level', log_level],
                parameters=[{'autostart': autostart}, {'node_names': lifecycle_nodes}],
            ),
        ],
    )

    # Everything into the single nav2_container started by bringup.launch.py. This is the
    # deployment path: one DDS participant on the B2 instead of eleven.
    load_composable_nodes = GroupAction(
        condition=IfCondition(use_composition),
        actions=[
            SetParameter('use_sim_time', False),
            LoadComposableNodes(
                target_container=container_name_full,
                composable_node_descriptions=[
                    ComposableNode(
                        package='nav2_controller',
                        plugin='nav2_controller::ControllerServer',
                        name='controller_server',
                        parameters=[configured_params],
                        remappings=[('cmd_vel', 'cmd_vel_nav')],
                    ),
                    ComposableNode(
                        package='nav2_smoother',
                        plugin='nav2_smoother::SmootherServer',
                        name='smoother_server',
                        parameters=[configured_params],
                    ),
                    ComposableNode(
                        package='nav2_planner',
                        plugin='nav2_planner::PlannerServer',
                        name='planner_server',
                        parameters=[configured_params],
                    ),
                    ComposableNode(
                        package='nav2_route',
                        plugin='nav2_route::RouteServer',
                        name='route_server',
                        parameters=[configured_params],
                    ),
                    # Note the plugin namespace: behavior_server::, not nav2_behaviors::.
                    ComposableNode(
                        package='nav2_behaviors',
                        plugin='behavior_server::BehaviorServer',
                        name='behavior_server',
                        parameters=[configured_params],
                        remappings=[('cmd_vel', 'cmd_vel_nav')],
                    ),
                    ComposableNode(
                        package='nav2_bt_navigator',
                        plugin='nav2_bt_navigator::BtNavigator',
                        name='bt_navigator',
                        parameters=[configured_params],
                    ),
                    ComposableNode(
                        package='nav2_waypoint_follower',
                        plugin='nav2_waypoint_follower::WaypointFollower',
                        name='waypoint_follower',
                        parameters=[configured_params],
                    ),
                    ComposableNode(
                        package='nav2_velocity_smoother',
                        plugin='nav2_velocity_smoother::VelocitySmoother',
                        name='velocity_smoother',
                        parameters=[configured_params],
                        remappings=[('cmd_vel', 'cmd_vel_nav')],
                    ),
                    ComposableNode(
                        package='nav2_collision_monitor',
                        plugin='nav2_collision_monitor::CollisionMonitor',
                        name='collision_monitor',
                        parameters=[configured_params],
                    ),
                    ComposableNode(
                        package='opennav_docking',
                        plugin='opennav_docking::DockingServer',
                        name='docking_server',
                        parameters=[configured_params],
                    ),
                    ComposableNode(
                        package='nav2_lifecycle_manager',
                        plugin='nav2_lifecycle_manager::LifecycleManager',
                        name='lifecycle_manager_navigation',
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
            description='Respawn on crash. Uncomposed only -- you cannot respawn one '
                        'component out of a shared process.'),
        DeclareLaunchArgument(
            'log_level', default_value='info', description='log level'),

        load_nodes,
        load_composable_nodes,
    ])
