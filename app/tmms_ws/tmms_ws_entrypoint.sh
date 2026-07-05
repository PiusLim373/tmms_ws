#!/bin/bash
set -e

# source
source /home/htxgrrt/.htxgrrt/bin/tmms_ws/custom.env

# Launch
echo "Launching system..."
exec ros2 launch tmms_master operation.launch.py