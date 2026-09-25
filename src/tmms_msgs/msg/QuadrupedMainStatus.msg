geometry_msgs/Pose pose
int32 battery_percentage
string robot_mode
string navigation_state
bool is_paused
string localization_status
string current_map

# Enum navigation_state
string IDLE=idle
string NAVIGATING=navigating
string ERROR=error
string UNLOCALIZED=unlocalized
string CANCELED=canceled
string PAUSED=paused
# Distinct from ERROR: a goal that could not be reached, not a broken system.
string NAVIGATION_FAILED=navigation_failed

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

# Enum localization_status
string NOT_STARTED=not_started
string PENDING=pending
string LOCALIZED=localized
string LOCALIZATION_LOST=localization_lost
string FAILED=failed