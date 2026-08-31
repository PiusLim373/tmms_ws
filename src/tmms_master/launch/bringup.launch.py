"""Full nav2 stack for the B2 -- starts the component container, then both halves.

This replaces nav2_bringup/launch/bringup_launch.py rather than wrapping it. It has to:
that file resolves its two sub-includes from its OWN share directory,

    bringup_dir = get_package_share_directory('nav2_bringup')
    launch_dir = os.path.join(bringup_dir, 'launch')

with no launch argument to redirect it. Delegating to it would silently keep loading nav2's
localization_launch.py and navigation_launch.py, leaving the local forks unused.

The forks live next door:
    localization.launch.py  -- map_server, amcl, lifecycle_manager_localization
    navigation.launch.py    -- the ten navigation nodes + lifecycle_manager_navigation

Three of upstream's arguments are gone rather than hardcoded, since none of them describe a
situation this robot is ever in:
    slam          -- mapping is FAST-LIO plus the UI's map editor, never slam_toolbox
    map           -- still available on localization.launch.py, but empty is the normal case
    use_sim_time  -- real robot

Standalone, for debugging -- per-node logs, per-node CPU, and working respawn:
    ros2 launch tmms_master bringup.launch.py use_composition:=False use_respawn:=True
"""

import os

from ament_index_python.packages import get_package_share_directory

from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument, IncludeLaunchDescription, SetEnvironmentVariable)
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.descriptions import ParameterFile


def generate_launch_description():
    master_share = get_package_share_directory('tmms_master')
    launch_dir = os.path.join(master_share, 'launch')
    default_params_file = os.path.join(master_share, 'config', 'nav2_params.yaml')

    params_file = LaunchConfiguration('params_file')
    use_composition = LaunchConfiguration('use_composition')
    use_respawn = LaunchConfiguration('use_respawn')
    autostart = LaunchConfiguration('autostart')
    log_level = LaunchConfiguration('log_level')

    configured_params = ParameterFile(params_file, allow_substs=True)

    common_args = {
        'params_file': params_file,
        'autostart': autostart,
        'use_composition': use_composition,
        'use_respawn': use_respawn,
        'log_level': log_level,
        'container_name': 'nav2_container',
    }

    return LaunchDescription([
        SetEnvironmentVariable('RCUTILS_LOGGING_BUFFERED_STREAM', '1'),

        DeclareLaunchArgument(
            'params_file', default_value=default_params_file,
            description='Nav2 parameters for the B2'),

        # True keeps all thirteen nodes in one process, which on the B2 means one DDS
        # participant instead of thirteen alongside FAST-LIO, the RS driver, both
        # controllers and rosbridge. It does NOT buy zero-copy: intra-process comms has to
        # be requested per node via extra_arguments={'use_intra_process_comms': True}, and
        # neither fork passes it, so messages still round-trip through the middleware.
        DeclareLaunchArgument(
            'use_composition', default_value='True',
            description='Load nav2 into a single component container'),

        DeclareLaunchArgument(
            'use_respawn', default_value='False',
            description='Respawn on crash. Uncomposed only -- one segfault takes down '
                        'every component in a shared process.'),

        DeclareLaunchArgument(
            'autostart', default_value='true',
            description='Have the lifecycle managers configure+activate on startup'),

        DeclareLaunchArgument(
            'log_level', default_value='info', description='log level'),

        # component_container_isolated, not plain component_container: isolated gives each
        # component its own executor, so a blocking callback in the controller server cannot
        # starve AMCL. Both forks load into this by name.
        Node(
            condition=IfCondition(use_composition),
            name='nav2_container',
            package='rclcpp_components',
            executable='component_container_isolated',
            parameters=[configured_params, {'autostart': autostart}],
            arguments=['--ros-args', '--log-level', log_level],
            output='screen'),

        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(launch_dir, 'localization.launch.py')),
            launch_arguments=common_args.items()),

        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(launch_dir, 'navigation.launch.py')),
            launch_arguments=common_args.items()),
    ])
