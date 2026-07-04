geometry_msgs/Pose pose
int32 battery_percentage
string robot_mode
string navigation_mode

# Enum navigation_mode
string IDLE=idle
string NAVIGATING=navigating
string CHARGING=charging
string ERROR=error

# Enum robot_mode
string ROBOT_IDLE=idle
string BALANCE_STAND=balance_stand
string POSE=pose
string LOCOMOTION=locomotion
string LIE_DOWN=lie_down
string JOINT_LOCK=joint_lock
string DAMPING=damping
string RECOVERY_STAND=recovery_stand
string SIT=sit
string FRONT_FLIP=front_flip
string FRONT_JUMP=front_jump
string FRONT_POUNCE=front_pounce