int64 navplan_id
string map_name
string timestamp
string status
geometry_msgs/Pose[] waypoints


# Enum status
string CREATED=created
string ACCEPTED=accepted
string REJECTED=rejected
string EXECUTING=executing
string COMPLETED=completed
string CANCELLED=cancelled
string ERRORED=errored