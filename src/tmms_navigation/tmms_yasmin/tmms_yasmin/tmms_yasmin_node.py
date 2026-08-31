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
        +----------------------------------------- NAVIGATING
        |                                          |    |    |
        |              succeeded --> IDLE ---------+    |    |
        |              aborted   --> NAVIGATION_FAILED -+    |
        |              canceled  --> CANCELED ---------------+
        +-- (all three accept a new goal and go back to NAVIGATING)

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
        super().__init__(['goal_accepted', 'localization_lost'])
        self.ctx = ctx
        self.state_name = state_name
        self.set_description(
            f'Publishes "{state_name}" and waits for /lichtblick_navgoal. Forwards an '
            'accepted goal to nav2; falls back to UNLOCALIZED if localization is lost.')

    def execute(self, blackboard: Blackboard) -> str:
        self.ctx.publish_state(self.state_name)
        # Anything that arrived while the FSM was elsewhere -- notably a goal published
        # during NAVIGATING -- is stale. Without this the robot would silently start a
        # second navigation the instant the first one finished.
        self.ctx.clear_pending_goal()

        while rclpy.ok() and not self.is_canceled():
            if self.ctx.localization_lost():
                yasmin.YASMIN_LOG_WARN('Localization lost while waiting for a goal')
                return 'localization_lost'

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


class NavigatingState(State):
    """Drives one nav2 goal to completion, or cancels it."""

    def __init__(self, ctx):
        super().__init__(['succeeded', 'aborted', 'canceled', 'localization_lost'])
        self.ctx = ctx
        self.set_description(
            'Polls the active nav2 goal. Cancels it on /cancel_goal or on lost '
            'localization, and reports which of the two caused the cancellation.')

    def execute(self, blackboard: Blackboard) -> str:
        self.ctx.publish_state(QuadrupedMainStatus.NAVIGATING)
        self.ctx.clear_cancel()

        # Why we cancelled decides the outcome: a cancel caused by lost localization must
        # land in UNLOCALIZED, not CANCELED, even though nav2 reports both as CANCELED.
        cancel_reason = None

        while rclpy.ok():
            if cancel_reason is None:
                if self.ctx.localization_lost():
                    cancel_reason = 'localization_lost'
                elif self.ctx.cancel_requested() or self.is_canceled():
                    cancel_reason = 'canceled'
                if cancel_reason is not None:
                    yasmin.YASMIN_LOG_INFO(f'Cancelling nav2 goal ({cancel_reason})')
                    self.ctx.navigator.cancelTask()

            # Spins internally with timeout_sec=0.10, so this call IS the loop pace.
            if self.ctx.navigator.isTaskComplete():
                break

        result = self.ctx.navigator.getResult()

        if cancel_reason == 'localization_lost':
            yasmin.YASMIN_LOG_WARN('Localization lost mid-goal; goal cancelled')
            return 'localization_lost'
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
    sm.add_state('NAVIGATING', NavigatingState(ctx),
                 transitions={
                     'succeeded': 'IDLE',
                     'aborted': 'NAVIGATION_FAILED',
                     'canceled': 'CANCELED',
                     'localization_lost': 'UNLOCALIZED',
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
