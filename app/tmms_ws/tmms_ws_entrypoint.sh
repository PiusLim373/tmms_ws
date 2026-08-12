#!/bin/bash
set -e

# source
source /home/htxgrrt/.htxgrrt/bin/tmms_ws/custom.env
source /home/htxgrrt/.htxgrrt/etc/tmms_env.env

# Launch
echo "Launching system..."
exec ros2 launch tmms_master operation.launch.py