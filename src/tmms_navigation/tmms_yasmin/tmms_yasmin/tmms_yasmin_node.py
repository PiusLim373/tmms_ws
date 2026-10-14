#!/usr/bin/env python3
"""Navigation state machine for the TMMS B2.

localization_manager decides whether the robot knows where it is, nav2 can drive it, and
quadruped_controller arbitrates velocity -- this node is what sequences them, and the single
answer to "what is the robot allowed to do right now".

                  localization_status == localized
   UNLOCALIZED ------------------------------------> IDLE
        ^                                             |  /lichtblick_navgoal or a route
        |                                             |  accepted by nav2
        |  localization_lost (cancels any goal)       v
        +----------------------------------------- NAVIGATING <--+ /lichtblick_navgoal
        |                                          |    |    |    | (preempts in place)
        |              succeeded --> IDLE ---------+    |    |    |
        |              aborted   --> NAVIGATION_FAILED -+    |    |
        |              canceled  --> CANCELED ---------------+    |
        +-- (all three accept a new goal and go back to NAVIGATING)

   NAVIGATING --segment ends map_switching--> MAP_SWITCHING --relocalized--> NAVIGATING
   MAP_SWITCHING --failed--> NAVIGATION_FAILED if still localized, else UNLOCALIZED

   /system_error non-empty, from ANY of those states --> ERROR --(it goes empty)--> IDLE

ERROR is the sensor-fault path: error_monitoring raises it when a costmap's cloud buffer
goes stale, which cancels any active goal and refuses new ones until the flag clears. Unlike
localization_lost it clears itself, so the normal case needs no operator action. UNLOCALIZED
is exempt -- ERROR exits to IDLE, which is only safe past the localization gate.

Two ways in to NAVIGATING. A bare /lichtblick_navgoal is one pose and preempts whatever is
running. A route arrives on /execute_route from navplan_processor, already validated and cut
into one segment per map, and is REFUSED unless the FSM is already waiting -- so it never
preempts. Each segment is driven with goThroughPoses. One ending map_switching hands over to
MAP_SWITCHING, which relocalizes onto the next segment's first waypoint through
localization_manager's /relocalize and drives on from there. A failed switch ends the route;
it never resumes on its own.

Progress is reported on /curr_navplan as accepted / executing / completed / cancelled /
errored, with the route and the segment under way on /curr_route and /curr_route_segment.
This node is those topics' only writer, and only for plans it admitted: a refused plan is
answered on the service alone, so it can never overwrite a running plan in
quadruped_main_status's mirror.

/cancel_goal is a Trigger so it can say no: refused during MAP_SWITCHING, where the
relocalization cannot be interrupted, and "nothing to cancel" with nothing running. A goal
arriving during NAVIGATING preempts the running one without leaving the state. One
sequencing contract falls out of that: after /cancel_goal, the caller MUST wait for
/yasmin_state to read CANCELED before publishing the next goal. A goal that lands while the
cancel is still in flight is dropped -- NAVIGATING will not take it once cancelling has
started, and CANCELED clears it on entry.

IDLE, CANCELED and NAVIGATION_FAILED are three instances of one state class differing only
in the name they publish -- they are the same waiting behaviour, and keeping them separate is
what makes the viewer diagram show how the robot got there. All three drop to UNLOCALIZED
whenever localization_status is not localized, so a failed relocalize cannot leave the robot
waiting for goals without a fix.

THREADING. Two nodes are in play and they are spun completely differently:

  * YasminNode is a singleton that runs its own MultiThreadedExecutor in a background
    thread, so its subscription and service callbacks fire concurrently with FSM execution.
  * BasicNavigator is ITSELF a Node, and every one of its methods calls
    rclpy.spin_until_future_complete(self, ...) on itself. It must never be added to an
    executor, and only one thread may ever call into it.

Hence the rule this file is built around: callbacks set flags, and every BasicNavigator call
happens on the single FSM execution thread. Calling navigator.cancelTask() straight from the
/cancel_goal callback is the obvious implementation and it is a race against the
isTaskComplete() poll in NavigatingState. /relocalize is called from the FSM thread too, and
YasminNode's executor completes its future.
"""

import threading
import time

import rclpy
import yasmin
from geometry_msgs.msg import PoseStamped
from nav2_simple_commander.robot_navigator import BasicNavigator, TaskResult
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile
from std_msgs.msg import String
from std_srvs.srv import Trigger
from tmms_msgs.msg import NavigationPlan, QuadrupedMainStatus, Route, RouteSegment
from tmms_msgs.srv import RelocalizeTrigger, RouteTrigger
from yasmin import Blackboard, State, StateMachine
from yasmin_ros import set_ros_loggers
from yasmin_ros.yasmin_node import YasminNode
from yasmin_viewer import YasminViewerPub

# How long a blocked state waits per tick before re-checking rclpy.ok() and its cancel flag.
# Short enough that Ctrl-C is not swallowed for a noticeable time.
TICK_SEC = 0.2

# Bounded wait for nav2's action server. BasicNavigator.goToPose() would otherwise sit in
# `while not wait_for_server(timeout_sec=1.0)` forever, hanging the FSM with no way out.
NAV_SERVER_WAIT_SEC = 3.0

# One /relocalize call covers the map load, the best-effort cloud load and AMCL convergence.
RELOCALIZE_TIMEOUT_SEC = 60.0

# localization_manager gates on quadruped_main_status, a 200 ms mirror of /yasmin_state. A
# /relocalize sent before the mirror catches up is refused as still navigating.
MIRROR_WAIT_SEC = 2.0

# /relocalize answers on the service and reports localized on a topic, in either order.
LOCALIZED_WAIT_SEC = 2.0

LATCHED = QoSProfile(depth=1,
                     durability=DurabilityPolicy.TRANSIENT_LOCAL,
                     history=HistoryPolicy.KEEP_LAST)

# States in which a route may be dispatched. Must agree with navplan_processor's own
# ACCEPTING_STATES; this one is authoritative because it reads the FSM directly rather than
# quadruped_controller's 200 ms mirror.
NAVPLAN_ACCEPTING_STATES = frozenset({
    QuadrupedMainStatus.IDLE,
    QuadrupedMainStatus.CANCELED,
    QuadrupedMainStatus.NAVIGATION_FAILED,
})


class NavContext:
    """Everything the states share: the ROS interfaces, the navigator, and the flags.

    Flags are only ever mutated from callbacks under _lock and acted on from the FSM thread.
    Route progress (route, segment) belongs to the FSM thread alone.
    """

    def __init__(self):
        self.node = YasminNode.get_instance()
        # Never add this to an executor -- it spins itself inside every method.
        self.navigator = BasicNavigator()

        self._lock = threading.Lock()
        self._pending_goal = None
        self._localized = False
        self._lost = False
        self._cancel_requested = False
        # Non-empty is the fault, and the string is the reason. Empty means healthy.
        self._system_error = ''
        # Routes get their own slot rather than sharing _pending_goal: a navgoal preempts a
        # running goal, a route is refused unless the robot is already waiting, so the two
        # are consumed in different places and must not overwrite each other.
        self._pending_route = None   # (NavigationPlan, Route)
        self._active_navplan = None
        # What publish_state last published. The FSM thread is the only writer.
        self._state = ''
        # quadruped_main_status.navigation_state, the mirror localization_manager gates on.
        self._mirrored_state = ''
        # Lets a blocked state wake immediately on a new goal instead of waiting out its tick.
        self._wake = threading.Event()

        self.route = None
        self.segment = 0

        self._state_pub = self.node.create_publisher(String, '/yasmin_state', LATCHED)

        # TRANSIENT_LOCAL to match localization_manager's latched publisher. A volatile
        # subscriber connects fine but never receives the latched sample, so this node
        # would sit in UNLOCALIZED forever if it started after localization succeeded.
        self.node.create_subscription(
            String, '/localization_status', self._localization_status_cb, LATCHED)
        self.node.create_subscription(
            PoseStamped, '/lichtblick_navgoal', self._navgoal_cb, 10)
        # error_monitoring publishes this latched, so the same durability argument applies:
        # starting after a fault was raised must not look like a healthy system.
        self.node.create_subscription(
            String, '/system_error', self._system_error_cb, LATCHED)
        self.node.create_subscription(
            QuadrupedMainStatus, '/quadruped_main_status', self._main_status_cb, 10)
        self.node.create_service(Trigger, '/cancel_goal', self._cancel_goal_cb)
        # Volatile, matching quadruped_controller's subscription.
        self._navplan_pub = self.node.create_publisher(NavigationPlan, '/curr_navplan', 10)
        # Latched so a viewer that connects mid-route still sees what is running.
        self._route_pub = self.node.create_publisher(Route, '/curr_route', LATCHED)
        self._segment_pub = self.node.create_publisher(
            RouteSegment, '/curr_route_segment', LATCHED)
        # navplan_processor forwards validated routes here.
        self.node.create_service(RouteTrigger, '/execute_route', self._execute_route_cb)
        self._relocalize_cli = self.node.create_client(RelocalizeTrigger, '/relocalize')

    # -- callbacks: flags only, never a navigator call -------------------------

    def _localization_status_cb(self, msg):
        with self._lock:
            self._localized = (msg.data == QuadrupedMainStatus.LOCALIZED)
            self._lost = (msg.data == QuadrupedMainStatus.LOCALIZATION_LOST)
        self._wake.set()

    def _navgoal_cb(self, msg):
        with self._lock:
            self._pending_goal = msg
        self._wake.set()

    def _system_error_cb(self, msg):
        with self._lock:
            self._system_error = msg.data
        self._wake.set()

    def _main_status_cb(self, msg):
        with self._lock:
            self._mirrored_state = msg.navigation_state

    def _cancel_goal_cb(self, request, response):
        dropped = None
        with self._lock:
            state = self._state
            if state == QuadrupedMainStatus.MAP_SWITCHING:
                reason = 'switching map; cancel once the next segment is under way'
            elif state == QuadrupedMainStatus.NAVIGATING or self._active_navplan is not None:
                # Also covers a route taken for dispatch whose NAVIGATING is not published yet.
                reason = None
                self._cancel_requested = True
            elif self._pending_route is not None:
                reason = None
                dropped, self._pending_route = self._pending_route[0], None
            else:
                reason = 'nothing to cancel'
        self._wake.set()

        if dropped is not None:
            dropped.status = NavigationPlan.CANCELLED
            self._navplan_pub.publish(dropped)

        response.success = reason is None
        if reason is None:
            response.message = 'cancel requested'
            yasmin.YASMIN_LOG_INFO('/cancel_goal requested')
        else:
            response.message = reason
            yasmin.YASMIN_LOG_WARN(f'/cancel_goal refused: {reason}')
        return response

    def _execute_route_cb(self, request, response):
        """Admission control only -- stash and return; the FSM thread does the driving.

        Rejecting rather than holding is deliberate. A route parked until the state came good
        would fire on its own once localization returned, which is the behaviour
        clear_pending_goal() exists to prevent.
        """
        plan, route = request.navigation_plan, request.route
        with self._lock:
            state = self._state
            if not route.route_segments or not route.route_segments[0].waypoints:
                reason = 'route has no waypoints'
            elif state not in NAVPLAN_ACCEPTING_STATES:
                reason = f"robot is '{state}'; cancel the current goal first"
            elif self._pending_route is not None:
                # The slot holds one. Dispatch normally empties it within a tick, but it
                # blocks for NAV_SERVER_WAIT_SEC when nav2 is down -- long enough for a
                # second plan to land and silently replace the first.
                reason = (f'navplan {self._pending_route[0].navplan_id} is still waiting to '
                          f'be dispatched')
            elif self._active_navplan is not None:
                # Taken from the slot but the FSM has not published `navigating` yet, so the
                # state check above still passes.
                reason = f'navplan {self._active_navplan.navplan_id} is already in progress'
            else:
                reason = None
                # Published before the slot is filled, so the FSM cannot dispatch it and
                # publish `executing` ahead of this.
                plan.status = NavigationPlan.ACCEPTED
                self._navplan_pub.publish(plan)
                self._pending_route = (plan, route)
        self._wake.set()

        response.success = reason is None
        if reason is None:
            response.message = f'navplan {plan.navplan_id} queued for dispatch'
            yasmin.YASMIN_LOG_INFO(response.message)
        else:
            response.message = reason
            yasmin.YASMIN_LOG_WARN(f'navplan {plan.navplan_id} refused: {reason}')
        return response

    # -- FSM-thread helpers ----------------------------------------------------

    def publish_state(self, name):
        # Cached so /execute_route and /cancel_goal can gate on it. Single writer, this thread.
        with self._lock:
            self._state = name
        self._state_pub.publish(String(data=name))
        yasmin.YASMIN_LOG_INFO(f'yasmin_state -> {name}')

    def wait_tick(self):
        """Block up to TICK_SEC, returning early if a callback fired."""
        self._wake.wait(TICK_SEC)
        self._wake.clear()

    def is_localized(self):
        with self._lock:
            return self._localized

    def localization_lost(self):
        with self._lock:
            return self._lost

    def system_error(self):
        """The current fault reason, or '' when healthy."""
        with self._lock:
            return self._system_error

    def take_goal(self):
        """Pop the pending goal, if any. Take-once: a goal is consumed, not re-read."""
        with self._lock:
            goal, self._pending_goal = self._pending_goal, None
            return goal

    def clear_pending_goal(self):
        with self._lock:
            self._pending_goal = None
            pending, self._pending_route = self._pending_route, None
        if pending is not None:
            # Already published as accepted; dropping it silently would leave that standing.
            plan = pending[0]
            plan.status = NavigationPlan.ERRORED
            self._navplan_pub.publish(plan)
            yasmin.YASMIN_LOG_WARN(f'navplan {plan.navplan_id} dropped before dispatch -> errored')

    def take_route(self):
        """Pop the pending (plan, route), if any, and mark the plan active. Take-once.

        Active from here rather than from dispatch, so /execute_route refuses a second plan
        while this one is still being handed to nav2.
        """
        with self._lock:
            pending, self._pending_route = self._pending_route, None
            if pending is not None:
                self._active_navplan = pending[0]
            return pending

    def publish_navplan_status(self, status):
        """Republish the active plan under a new status. No-op when none is active."""
        with self._lock:
            plan = self._active_navplan
            if plan is None:
                return
            plan.status = status
            if status not in (NavigationPlan.EXECUTING,):
                self._active_navplan = None
        self._navplan_pub.publish(plan)
        yasmin.YASMIN_LOG_INFO(f'navplan {plan.navplan_id} -> {status}')

    def start_route(self, route):
        self.route = route
        self.segment = 0
        self._route_pub.publish(route)

    def end_route(self, status):
        """Report the plan's final status and forget the route. No-op without a route."""
        self.publish_navplan_status(status)
        self.route = None
        self.segment = 0

    def route_continues(self):
        """True when the segment just finished hands over to a map switch."""
        return (self.route is not None
                and self.route.route_segments[self.segment].end_action
                == RouteSegment.MAP_SWITCHING
                and self.segment + 1 < len(self.route.route_segments))

    def dispatch_segment(self, index):
        """Send route segment `index` to nav2: 'ok', 'empty', 'unavailable' or 'rejected'.

        Always goThroughPoses, even for one waypoint, so there is a single path to reason
        about. Waypoint poses carry no frame of their own and the whole system works in map.
        """
        segment = self.route.route_segments[index]
        self.segment = index
        self._segment_pub.publish(segment)
        # After a switch the robot stands on waypoints[0]; it was the relocalize pose.
        waypoints = segment.waypoints[1:] if index > 0 else segment.waypoints
        if not waypoints:
            return 'empty'

        if not self.nav_server_ready(self.navigator.nav_through_poses_client):
            yasmin.YASMIN_LOG_ERROR('NavigateThroughPoses action server unavailable')
            return 'unavailable'

        stamp = self.node.get_clock().now().to_msg()
        poses = []
        for wp in waypoints:
            ps = PoseStamped()
            ps.header.frame_id = 'map'
            ps.header.stamp = stamp
            ps.pose = wp.pose
            poses.append(ps)

        # Same trap as goToPose: goal_handle is overwritten before `accepted` is checked, so
        # a rejection must put the old one back or a later cancel stops the wrong handle.
        prev_handle = self.navigator.goal_handle
        if not self.navigator.goThroughPoses(poses):
            self.navigator.goal_handle = prev_handle
            yasmin.YASMIN_LOG_WARN(f'nav2 rejected route segment {index}')
            return 'rejected'
        yasmin.YASMIN_LOG_INFO(
            f"route segment {index} on '{segment.waypoints[0].map_name}': "
            f'{len(poses)} waypoints')
        return 'ok'

    def relocalize(self, map_name, pose):
        """Load map_name and seed pose on it through localization_manager. (ok, message)."""
        if not self._relocalize_cli.wait_for_service(timeout_sec=NAV_SERVER_WAIT_SEC):
            return False, '/relocalize is not available'

        request = RelocalizeTrigger.Request()
        request.map_name = map_name
        request.initial_pose.header.frame_id = 'map'
        request.initial_pose.header.stamp = self.node.get_clock().now().to_msg()
        # Zero covariance: localization_manager substitutes its default particle spread.
        request.initial_pose.pose.pose = pose

        future = self._relocalize_cli.call_async(request)
        done = threading.Event()
        future.add_done_callback(lambda _f: done.set())
        deadline = time.monotonic() + RELOCALIZE_TIMEOUT_SEC
        while not done.wait(TICK_SEC):
            if not rclpy.ok() or time.monotonic() > deadline:
                future.cancel()
                return False, (f'/relocalize did not return within '
                               f'{RELOCALIZE_TIMEOUT_SEC:.0f}s')

        result = future.result()
        if result is None:
            return False, '/relocalize call failed'
        return result.success, result.message

    def wait_not_navigating(self):
        """Wait, bounded, for the mirror to move off `navigating` (`paused` counts)."""
        deadline = time.monotonic() + MIRROR_WAIT_SEC
        while rclpy.ok() and time.monotonic() < deadline:
            with self._lock:
                if self._mirrored_state != QuadrupedMainStatus.NAVIGATING:
                    return
            time.sleep(0.05)

    def wait_localized(self):
        deadline = time.monotonic() + LOCALIZED_WAIT_SEC
        while rclpy.ok() and time.monotonic() < deadline and not self.is_localized():
            time.sleep(0.05)

    def cancel_requested(self):
        with self._lock:
            return self._cancel_requested

    def clear_cancel(self):
        with self._lock:
            self._cancel_requested = False

    def nav_server_ready(self, client):
        return client.wait_for_server(timeout_sec=NAV_SERVER_WAIT_SEC)


class UnlocalizedState(State):
    """Waits for localization_manager to report a successful fix."""

    def __init__(self, ctx):
        super().__init__(['localized'])
        self.ctx = ctx
        self.set_description(
            'Holds until /localization_status reports localized. Entered at startup and '
            'again whenever localization is lost.')

    def execute(self, blackboard: Blackboard) -> str:
        # A route admitted just before localization was lost will never run; report it now
        # rather than on the next IDLE entry.
        self.ctx.clear_pending_goal()
        self.ctx.publish_state(QuadrupedMainStatus.UNLOCALIZED)
        while rclpy.ok() and not self.is_canceled():
            if self.ctx.is_localized():
                return 'localized'
            self.ctx.wait_tick()
        return 'localized'


class WaitForGoalState(State):
    """The idle behaviour, instantiated three times under different names.

    IDLE, CANCELED and NAVIGATION_FAILED differ only in what they publish -- what the robot
    is doing (waiting for a goal) is identical.
    """

    def __init__(self, ctx, state_name):
        super().__init__(['goal_accepted', 'localization_lost', 'system_error'])
        self.ctx = ctx
        self.state_name = state_name
        self.set_description(
            f'Publishes "{state_name}" and waits for /lichtblick_navgoal or a route. Forwards '
            'it to nav2; falls back to UNLOCALIZED when not localized, or to ERROR on '
            '/system_error.')

    def execute(self, blackboard: Blackboard) -> str:
        # NAVIGATING now consumes goals itself, so what is left here arrived during
        # cancellation or while UNLOCALIZED. Both are stale; dropping them is what keeps
        # the robot from silently starting a second navigation on entry.
        # Cleared BEFORE the state is published: every state entering here refuses routes,
        # so none can be admitted until then, and none admitted after it gets wiped here.
        self.ctx.clear_pending_goal()
        # A cancel that raced the previous goal's finish must not cancel the next one.
        self.ctx.clear_cancel()
        self.ctx.publish_state(self.state_name)

        while rclpy.ok() and not self.is_canceled():
            # Any status but localized, not just localization_lost: a failed relocalize
            # reports `failed`, and goals must not be taken without a fix.
            if not self.ctx.is_localized():
                yasmin.YASMIN_LOG_WARN('Not localized while waiting for a goal')
                return 'localization_lost'

            # Checked here too, not just in NAVIGATING: a sensor feed that has died must
            # stop a NEW goal being dispatched into a costmap with nothing in it.
            reason = self.ctx.system_error()
            if reason:
                yasmin.YASMIN_LOG_ERROR(f'System error while waiting for a goal: {reason}')
                return 'system_error'

            # Routes are only ever started from here -- /execute_route refuses one unless
            # the FSM is already in a waiting state, so NAVIGATING never sees one arrive.
            pending = self.ctx.take_route()
            if pending is not None and self._start_route(pending[1]):
                return 'goal_accepted'

            goal = self.ctx.take_goal()
            if goal is None:
                self.ctx.wait_tick()
                continue

            if not self.ctx.nav_server_ready(self.ctx.navigator.nav_to_pose_client):
                # Staying put rather than hanging: goToPose() would block forever here.
                yasmin.YASMIN_LOG_ERROR(
                    'NavigateToPose action server unavailable -- is nav2 running? '
                    'Dropping this goal.')
                continue

            if self.ctx.navigator.goToPose(goal):
                return 'goal_accepted'
            # Rejected goals loop rather than self-transitioning, so the state name is not
            # republished for a non-event.
            yasmin.YASMIN_LOG_WARN('nav2 rejected the goal; still waiting')

        return 'localization_lost'

    def _start_route(self, route):
        """Dispatch the route's first segment. Returns True if nav2 accepted it."""
        self.ctx.start_route(route)
        result = self.ctx.dispatch_segment(0)
        if result == 'ok':
            self.ctx.publish_navplan_status(NavigationPlan.EXECUTING)
            return True
        if result == 'rejected':
            yasmin.YASMIN_LOG_WARN('nav2 rejected the route; still waiting')
            self.ctx.end_route(NavigationPlan.REJECTED)
        else:
            yasmin.YASMIN_LOG_ERROR('Route not dispatched; dropping it')
            self.ctx.end_route(NavigationPlan.ERRORED)
        return False


class SystemErrorState(State):
    """Holds while /system_error is raised, refusing goals until it clears.

    Unlike UNLOCALIZED this clears itself: error_monitoring lifts the flag once the fault
    stops reporting, so no operator action is needed in the normal case.
    """

    def __init__(self, ctx):
        super().__init__(['recovered', 'localization_lost'])
        self.ctx = ctx
        self.set_description(
            'Publishes "error" and holds until /system_error goes empty. Any goal that '
            'arrives meanwhile is dropped.')

    def execute(self, blackboard: Blackboard) -> str:
        self.ctx.publish_state(QuadrupedMainStatus.ERROR)
        # Same rule as WaitForGoalState: a goal that arrived during the fault is stale.
        self.ctx.clear_pending_goal()

        while rclpy.ok() and not self.is_canceled():
            if self.ctx.localization_lost():
                return 'localization_lost'
            if not self.ctx.system_error():
                yasmin.YASMIN_LOG_INFO('System error cleared')
                return 'recovered'
            self.ctx.wait_tick()

        return 'recovered'


class NavigatingState(State):
    """Drives one nav2 goal or route segment to completion, or cancels it."""

    def __init__(self, ctx):
        super().__init__(
            ['succeeded', 'map_switch', 'aborted', 'canceled', 'localization_lost',
             'system_error'])
        self.ctx = ctx
        self.set_description(
            'Polls the active nav2 goal. Swaps in a new /lichtblick_navgoal by preemption. '
            'Cancels on /cancel_goal, lost localization or /system_error, and reports the '
            'reason. A route segment ending map_switching hands over to MAP_SWITCHING.')

    def execute(self, blackboard: Blackboard) -> str:
        self.ctx.publish_state(QuadrupedMainStatus.NAVIGATING)

        # Why we cancelled decides the outcome: a cancel caused by lost localization must
        # land in UNLOCALIZED, not CANCELED, even though nav2 reports both as CANCELED.
        cancel_reason = None
        # Captured when the fault is seen, not read back afterwards -- the flag can clear
        # while nav2 is still winding the goal down, which would log an empty reason.
        error_text = ''

        while rclpy.ok():
            if cancel_reason is None:
                if self.ctx.localization_lost():
                    cancel_reason = 'localization_lost'
                # Ahead of the cancel check so a concurrent operator cancel does not mask
                # the fault -- the robot stops either way, but the reason is what the
                # operator needs to see.
                elif self.ctx.system_error():
                    cancel_reason = 'system_error'
                    error_text = self.ctx.system_error()
                elif self.ctx.cancel_requested() or self.is_canceled():
                    cancel_reason = 'canceled'
                if cancel_reason is not None:
                    yasmin.YASMIN_LOG_INFO(f'Cancelling nav2 goal ({cancel_reason})')
                    self.ctx.navigator.cancelTask()

            # A new goal replaces the running one in place. nav2 preempts server-side and
            # the tree's GlobalUpdatedGoal fires a replan; the state stays NAVIGATING.
            # Skipped once cancelling has started -- a cancel in flight always wins.
            if cancel_reason is None:
                new_goal = self.ctx.take_goal()
                if new_goal is not None:
                    if not self.ctx.nav_server_ready(self.ctx.navigator.nav_to_pose_client):
                        # goToPose() would block forever waiting for the server.
                        yasmin.YASMIN_LOG_ERROR(
                            'NavigateToPose action server unavailable; abandoning goal')
                        self.ctx.end_route(NavigationPlan.ERRORED)
                        return 'aborted'
                    # goToPose() overwrites goal_handle before checking `accepted`, so a
                    # rejection must restore it or cancelTask() stops the rejected handle
                    # and nav2 keeps driving the old goal.
                    prev_handle = self.ctx.navigator.goal_handle
                    if self.ctx.navigator.goToPose(new_goal):
                        yasmin.YASMIN_LOG_INFO('New goal preempted the active one')
                        # A bare navgoal that preempts a route abandons it. Report that now,
                        # or the plan would sit at "executing" forever, and forget the route
                        # so the navgoal's success cannot resume it.
                        self.ctx.end_route(NavigationPlan.CANCELLED)
                    else:
                        self.ctx.navigator.goal_handle = prev_handle
                        yasmin.YASMIN_LOG_WARN(
                            'nav2 rejected the new goal; cancelling the active one')
                        cancel_reason = 'goal_rejected'
                        self.ctx.navigator.cancelTask()

            # Spins internally with timeout_sec=0.10, so this call IS the loop pace.
            if self.ctx.navigator.isTaskComplete():
                break

        result = self.ctx.navigator.getResult()

        if cancel_reason == 'localization_lost':
            yasmin.YASMIN_LOG_WARN('Localization lost mid-goal; goal cancelled')
            self.ctx.end_route(NavigationPlan.ERRORED)
            return 'localization_lost'
        if cancel_reason == 'system_error':
            yasmin.YASMIN_LOG_ERROR(f'System error mid-goal; goal cancelled: {error_text}')
            self.ctx.end_route(NavigationPlan.ERRORED)
            return 'system_error'
        if cancel_reason == 'goal_rejected':
            self.ctx.end_route(NavigationPlan.ERRORED)
            return 'aborted'
        if result == TaskResult.SUCCEEDED:
            if self.ctx.route_continues():
                yasmin.YASMIN_LOG_INFO(f'Route segment {self.ctx.segment} reached')
                return 'map_switch'
            yasmin.YASMIN_LOG_INFO('Goal reached')
            self.ctx.end_route(NavigationPlan.COMPLETED)
            return 'succeeded'
        if result == TaskResult.CANCELED:
            yasmin.YASMIN_LOG_INFO('Goal canceled')
            self.ctx.end_route(NavigationPlan.CANCELLED)
            return 'canceled'
        # FAILED and UNKNOWN both mean "did not get there and was not cancelled".
        yasmin.YASMIN_LOG_WARN(f'Goal did not complete: {result}')
        self.ctx.end_route(NavigationPlan.ERRORED)
        return 'aborted'


class MapSwitchingState(State):
    """Relocalizes onto the next route segment's map, then drives that segment."""

    def __init__(self, ctx):
        super().__init__(
            ['switched', 'completed', 'canceled', 'failed', 'localization_lost',
             'system_error'])
        self.ctx = ctx
        self.set_description(
            'Stopped at a map-switch waypoint: /relocalize onto the next map, then dispatch '
            'the next segment. A failure ends the route. /cancel_goal is refused here.')

    def execute(self, blackboard: Blackboard) -> str:
        # A cancel accepted while the segment was finishing still ends the route here.
        if self.ctx.cancel_requested():
            yasmin.YASMIN_LOG_INFO('Route cancelled at a map switch')
            self.ctx.end_route(NavigationPlan.CANCELLED)
            return 'canceled'

        self.ctx.publish_state(QuadrupedMainStatus.MAP_SWITCHING)
        # Navgoals are not taken here; one left pending would preempt the next segment.
        self.ctx.clear_pending_goal()

        target = self.ctx.route.route_segments[self.ctx.segment + 1].waypoints[0]
        self.ctx.wait_not_navigating()
        yasmin.YASMIN_LOG_INFO(f"Switching to map '{target.map_name}'")
        ok, message = self.ctx.relocalize(target.map_name, target.pose)

        reason = self.ctx.system_error()
        if reason:
            yasmin.YASMIN_LOG_ERROR(f'System error during the map switch: {reason}')
            self.ctx.end_route(NavigationPlan.ERRORED)
            return 'system_error'
        if not ok:
            yasmin.YASMIN_LOG_ERROR(f'Map switch failed: {message}')
            self.ctx.end_route(NavigationPlan.ERRORED)
            # A refused or failed map load changes nothing; a failed convergence leaves the
            # new map loaded without a fix.
            return 'failed' if self.ctx.is_localized() else 'localization_lost'

        yasmin.YASMIN_LOG_INFO(message)
        self.ctx.wait_localized()
        self.ctx.clear_pending_goal()
        result = self.ctx.dispatch_segment(self.ctx.segment + 1)
        if result == 'ok':
            return 'switched'
        if result == 'empty':
            # The route ended on the map-switch waypoint itself.
            yasmin.YASMIN_LOG_INFO('Route completed on the new map')
            self.ctx.end_route(NavigationPlan.COMPLETED)
            return 'completed'
        self.ctx.end_route(NavigationPlan.ERRORED)
        return 'failed'


def main():
    rclpy.init()
    set_ros_loggers()

    ctx = NavContext()

    sm = StateMachine(outcomes=['shutdown'], handle_sigint=True)
    sm.set_description('TMMS navigation state machine: localization gate, goal and route '
                       'dispatch, map switching, and nav2 outcome routing.')

    idle_transitions = {
        'goal_accepted': 'NAVIGATING',
        'localization_lost': 'UNLOCALIZED',
        'system_error': 'ERROR',
    }

    sm.add_state('UNLOCALIZED', UnlocalizedState(ctx),
                 transitions={'localized': 'IDLE'})
    sm.add_state('IDLE', WaitForGoalState(ctx, QuadrupedMainStatus.IDLE),
                 transitions=idle_transitions)
    sm.add_state('CANCELED', WaitForGoalState(ctx, QuadrupedMainStatus.CANCELED),
                 transitions=idle_transitions)
    sm.add_state('NAVIGATION_FAILED',
                 WaitForGoalState(ctx, QuadrupedMainStatus.NAVIGATION_FAILED),
                 transitions=idle_transitions)
    # Back to IDLE, not to wherever we came from: ERROR is only reachable from states that
    # are already past the localization gate, so IDLE is always a safe landing.
    sm.add_state('ERROR', SystemErrorState(ctx),
                 transitions={
                     'recovered': 'IDLE',
                     'localization_lost': 'UNLOCALIZED',
                 })
    sm.add_state('NAVIGATING', NavigatingState(ctx),
                 transitions={
                     'succeeded': 'IDLE',
                     'map_switch': 'MAP_SWITCHING',
                     'aborted': 'NAVIGATION_FAILED',
                     'canceled': 'CANCELED',
                     'localization_lost': 'UNLOCALIZED',
                     'system_error': 'ERROR',
                 })
    sm.add_state('MAP_SWITCHING', MapSwitchingState(ctx),
                 transitions={
                     'switched': 'NAVIGATING',
                     'completed': 'IDLE',
                     'canceled': 'CANCELED',
                     'failed': 'NAVIGATION_FAILED',
                     'localization_lost': 'UNLOCALIZED',
                     'system_error': 'ERROR',
                 })
    sm.set_start_state('UNLOCALIZED')

    YasminViewerPub(sm, 'TMMS_NAV')

    try:
        yasmin.YASMIN_LOG_INFO(sm())
    except Exception as e:  # noqa: BLE001 -- report and shut down cleanly
        yasmin.YASMIN_LOG_WARN(str(e))

    if rclpy.ok():
        rclpy.shutdown()


if __name__ == '__main__':
    main()
