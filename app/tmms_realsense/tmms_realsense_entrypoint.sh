#!/bin/bash
set -e

# source
source /home/htxgrrt/.htxgrrt/bin/tmms_ws/custom.env
source /home/htxgrrt/.htxgrrt/etc/tmms_env.env

# Launch
echo "Launching system..."
exec ros2 launch realsense2_camera rs_launch.py \
    serial_no:="${FRONT_REALSENSE_SERIAL_NUMBER}" \
    camera_name:=camera_front \
    rgb_camera.color_profile:=848x480x30 \
    enable_depth:=true \
    depth_module.depth_profile:=848x480x30 \
    align_depth.enable:=true \
    enable_sync:=true
