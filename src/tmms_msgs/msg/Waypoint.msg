int32 id
string name
string map_name
string type
geometry_msgs/Pose pose

# specific for mapswitch waypoint
string new_map_name
geometry_msgs/Pose new_map_pose

# Enum type
string SIMPLE=simple
string HOME=home
string POI=poi
string MAP_SWITCH=map_switch
string CHARGER=charger
