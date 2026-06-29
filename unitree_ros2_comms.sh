#!/bin/bash
echo "Setup unitree ros2 communications environment with custom built cyclonedds"
source /opt/ros/jazzy/setup.bash
source /home/piuslim373/all_ws/b2_project_ws/tmms_ws/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI='<CycloneDDS><Domain><General><Interfaces>
                            <NetworkInterface name="enx207bd26e0121" priority="default" multicast="default" />
                        </Interfaces></General></Domain></CycloneDDS>'