int64 navplan_id
string timestamp
string status
tmms_msgs/Waypoint[] waypoints


# Enum status
string CREATED=created
string ACCEPTED=accepted
string REJECTED=rejected
string EXECUTING=executing
string COMPLETED=completed
string CANCELLED=cancelled
string ERRORED=errored