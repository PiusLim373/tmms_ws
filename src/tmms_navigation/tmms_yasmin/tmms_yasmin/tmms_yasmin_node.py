#!/usr/bin/env python3
"""Navigation state machine for the TMMS B2.

localization_manager decides whether the robot knows where it is, nav2 can drive it, and
quadruped_controller arbitrates velocity -- this node is what sequences them, and the single
answer to "what is the robot allowed to do right now".

                  localization_status == localized
   UNLOCALIZED ------------------------------------> IDLE
        ^                                             |  /lichtblick_navgoal
        |                                             |  accepted by nav2
        |  localization_lost (cancels any goal)       v
        +----------------------------------------- NAVIGATING <--+ /lichtblick_navgoal
        |                                          |    |    |    | (preempts in place)
        |              succeeded --> IDLE ---------+    |    |    |
        |              aborted   --> NAVIGATION_FAILED -+    |    |
        |              canceled  --> CANCELED ---------------+    |
        +-- (all three accept a new goal and go back to NAVIGATING)

   /system_error non-empty, from ANY of those four --> ERROR --(it goes empty)--> IDLE

ERROR is the sensor-fault path: error_monitoring raises it when a costmap's cloud buffer
goes stale, which cancels any active goal and refuses new ones until the flag clears. Unlike
localization_lost it clears itself, so the normal case needs no operator action. UNLOCALIZED
is exempt -- ERROR exits to IDLE, which is only safe past the localization gate.

A goal arriving during NAVIGATING preempts the running one without leaving the state. One
sequencing contract falls out of that: after /cancel_goal, the caller MUST wait for
/yasmin_state to read CANCELED before publishing the next goal. A goal that lands while the
cancel is still in flight is dropped -- NAVIGATING will not take it once cancelling has
started, and CANCELED clears it on entry.

IDLE, CANCELED and NAVIGATION_FAILED are three instances of one state class differing only
in the name they publish -- they are the same waiting behaviour, and keeping them separate is
what makes the viewer diagram show how the robot got there.

THREADING. Two nodes are in play and they are spun completely differently:

  * YasminNode is a singleton that runs its own MultiThreadedExecutor in a background
    thread, so its subscription and service callbacks fire concurrently with FSM execution.
  * BasicNavigator is ITSELF a Node, and every one of its methods calls
    rclpy.spin_until_future_complete(self, ...) on itself. It must never be added to an
    executor, and only one thread may ever call into it.

Hence the rule this file is built around: callbacks set flags, and every BasicNavigator call
happens on the single FSM execution thread. Calling navigator.cancelTask() straight from the
/cancel_goal callback is the obvious implementation and it is a race against the
isTaskComplete() poll in NavigatingState.
"""

import threading

import rclpy
import yasmin
from geometry_msgs.msg import PoseStamped
from nav2_simple_commander.robot_navigator import BasicNavigator, TaskResult
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile
from std_msgs.msg import String
from std_srvs.srv import Empty
from tmms_msgs.msg import QuadrupedMainStatus
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

LATCHED = QoSProfile(depth=1,
                     durability=DurabilityPolicy.TRANSIENT_LOCAL,
                     history=HistoryPolicy.KEEP_LAST)


class NavContext:
    """Everything the states share: the ROS interfaces, the navigator, and the flags.

    Only ever mutated from callbacks under _lock; only ever acted on from the FSM thread.
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
        # Lets a blocked state wake immediately on a new goal instead of waiting out its tick.
        self._wake = threading.Event()

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
        self.node.create_service(Empty, '/cancel_goal', self._cancel_goal_cb)

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

    def _cancel_goal_cb(self, request, response):
        with self._lock:
            self._cancel_requested = True
        self._wake.set()
        yasmin.YASMIN_LOG_INFO('/cancel_goal requested')
        return response

    # -- FSM-thread helpers ----------------------------------------------------

    def publish_state(self, name):
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

    def cancel_requested(self):
        with self._lock:
            return self._cancel_requested

    def clear_cancel(self):
        with self._lock:
            self._cancel_requested = False

    def nav_server_ready(self):
        return self.navigator.nav_to_pose_client.wait_for_server(
            timeout_sec=NAV_SERVER_WAIT_SEC)


class UnlocalizedState(State):
    """Waits for localization_manager to report a successful fix."""

    def __init__(self, ctx):
        super().__init__(['localized'])
        self.ctx = ctx
        self.set_description(
            'Holds until /localization_status reports localized. Entered at startup and '
            'again whenever localization is lost.')

    def execute(self, blackboard: Blackboard) -> str:
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
            f'Publishes "{state_name}" and waits for /lichtblick_navgoal. Forwards an '
            'accepted goal to nav2; falls back to UNLOCALIZED if localization is lost, or '
            'to ERROR on /system_error.')

    def execute(self, blackboard: Blackboard) -> str:
        self.ctx.publish_state(self.state_name)
        # NAVIGATING now consumes goals itself, so what is left here arrived during
        # cancellation or while UNLOCALIZED. Both are stale; dropping them is what keeps
        # the robot from silently starting a second navigation on entry.
        self.ctx.clear_pending_goal()

        while rclpy.ok() and not self.is_canceled():
            if self.ctx.localization_lost():
                yasmin.YASMIN_LOG_WARN('Localization lost while waiting for a goal')
                return 'localization_lost'

            # Checked here too, not just in NAVIGATING: a sensor feed that has died must
            # stop a NEW goal being dispatched into a costmap with nothing in it.
            reason = self.ctx.system_error()
            if reason:
                yasmin.YASMIN_LOG_ERROR(f'System error while waiting for a goal: {reason}')
                return 'system_error'

            goal = self.ctx.take_goal()
            if goal is None:
                self.ctx.wait_tick()
                continue

            if not self.ctx.nav_server_ready():
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
    """Drives one nav2 goal to completion, or cancels it."""

    def __init__(self, ctx):
        super().__init__(
            ['succeeded', 'aborted', 'canceled', 'localization_lost', 'system_error'])
        self.ctx = ctx
        self.set_description(
            'Polls the active nav2 goal. Swaps in a new /lichtblick_navgoal by preemption. '
            'Cancels on /cancel_goal, lost localization or /system_error, and reports the '
            'reason.')

    def execute(self, blackboard: Blackboard) -> str:
        self.ctx.publish_state(QuadrupedMainStatus.NAVIGATING)
        self.ctx.clear_cancel()

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
                    if not self.ctx.nav_server_ready():
                        # goToPose() would block forever waiting for the server.
                        yasmin.YASMIN_LOG_ERROR(
                            'NavigateToPose action server unavailable; abandoning goal')
                        return 'aborted'
                    # goToPose() overwrites goal_handle before checking `accepted`, so a
                    # rejection must restore it or cancelTask() stops the rejected handle
                    # and nav2 keeps driving the old goal.
                    prev_handle = self.ctx.navigator.goal_handle
                    if self.ctx.navigator.goToPose(new_goal):
                        yasmin.YASMIN_LOG_INFO('New goal preempted the active one')
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
            return 'localization_lost'
        if cancel_reason == 'system_error':
            yasmin.YASMIN_LOG_ERROR(f'System error mid-goal; goal cancelled: {error_text}')
            return 'system_error'
        if cancel_reason == 'goal_rejected':
            return 'aborted'
        if result == TaskResult.SUCCEEDED:
            yasmin.YASMIN_LOG_INFO('Goal reached')
            return 'succeeded'
        if result == TaskResult.CANCELED:
            yasmin.YASMIN_LOG_INFO('Goal canceled')
            return 'canceled'
        # FAILED and UNKNOWN both mean "did not get there and was not cancelled".
        yasmin.YASMIN_LOG_WARN(f'Goal did not complete: {result}')
        return 'aborted'


def main():
    rclpy.init()
    set_ros_loggers()

    ctx = NavContext()

    sm = StateMachine(outcomes=['shutdown'], handle_sigint=True)
    sm.set_description('TMMS navigation state machine: localization gate, goal dispatch, '
                       'and nav2 outcome routing.')

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
                     'aborted': 'NAVIGATION_FAILED',
                     'canceled': 'CANCELED',
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
