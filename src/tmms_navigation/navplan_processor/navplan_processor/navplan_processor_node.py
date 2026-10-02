#!/usr/bin/env python3
"""Gatekeeper between an operator's navigation plan and the state machine that drives it.

The UI never calls tmms_yasmin directly. A plan arrives here on /navigation_plan, is checked
against what the robot is actually doing, and only then forwarded to yasmin's
/execute_navplan. Same shape as localization_manager, which gates /map_load and
/lichtblick_initialpose in front of nav2.

WHY A SEPARATE NODE. The checks are about the plan rather than about navigation: does its
map_name still match the map the robot is localized on, is the robot free to accept work at
all. Keeping them here leaves yasmin owning only goal dispatch, and gives later per-plan
behaviour (end actions, a plan store) somewhere to live that is not the FSM.

WHY THE CHECK IS DUPLICATED IN YASMIN. This reads quadruped_main_status, which is a 200 ms
mirror of /yasmin_state, so it can be one tick stale. yasmin re-checks its own state
authoritatively; this one exists to give the operator a good reason string, and to catch the
one case yasmin cannot see -- `paused` is overlaid by quadruped_controller and never appears
on /yasmin_state, so a plan sent while someone is hand-driving the robot would otherwise slip
straight through.

THIS NODE NEVER PUBLISHES /curr_navplan. quadruped_main_status mirrors that topic's last
message, so publishing a refused plan would overwrite the status of the plan that is actually
running. A refusal is answered on the service alone; yasmin is the topic's only writer, from
admission (`accepted`) onward.
"""

import threading

import rclpy
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from tmms_msgs.msg import QuadrupedMainStatus
from tmms_msgs.srv import NavigationPlanTrigger

# States in which the robot is free to take on a new plan. Everything else is either busy
# (navigating), not ready (unlocalized), handed to the operator (paused), or broken (error).
# The operator is expected to cancel and wait for `canceled` before sending the next plan.
ACCEPTING_STATES = frozenset({
    QuadrupedMainStatus.IDLE,
    QuadrupedMainStatus.CANCELED,
    QuadrupedMainStatus.NAVIGATION_FAILED,
})


class NavplanProcessorNode(Node):

    def __init__(self):
        super().__init__('navplan_processor')

        self.declare_parameter('service_timeout_sec', 10.0)

        self._lock = threading.Lock()
        self._status = None

        # /navigation_plan calls out to yasmin from inside its own callback. Mutually
        # exclusive for the inbound service so two plans can never interleave; reentrant for
        # the client and the status subscription so both stay deliverable while one is in
        # flight.
        self._srv_group = MutuallyExclusiveCallbackGroup()
        self._aux_group = ReentrantCallbackGroup()

        self.create_subscription(
            QuadrupedMainStatus, '/quadruped_main_status', self._status_cb, 10,
            callback_group=self._aux_group)

        self._execute_client = self.create_client(
            NavigationPlanTrigger, '/execute_navplan', callback_group=self._aux_group)

        self.create_service(
            NavigationPlanTrigger, '/navigation_plan', self._navigation_plan_cb,
            callback_group=self._srv_group)

        self.get_logger().info('navplan_processor ready on /navigation_plan')

    # -- helpers ---------------------------------------------------------------

    def _param(self, name):
        return self.get_parameter(name).value

    def _status_cb(self, msg):
        with self._lock:
            self._status = msg

    def _call_and_wait(self, client, request, what):
        """Returns (ok, result_or_message). The house idiom -- see localization_manager.

        Never spin_until_future_complete() here: this runs inside a callback, and the thread
        that would do the spinning is the one already blocked.
        """
        timeout = float(self._param('service_timeout_sec'))
        if not client.wait_for_service(timeout_sec=5.0):
            return False, f'{what} is not available'

        future = client.call_async(request)
        done = threading.Event()
        future.add_done_callback(lambda _f: done.set())
        if not done.wait(timeout):
            future.cancel()
            return False, f'{what} did not return within {timeout:.0f}s'

        result = future.result()
        if result is None:
            return False, f'{what} call failed'
        return True, result

    # -- validation ------------------------------------------------------------

    def _validate(self, plan):
        """Returns None if the plan may run, else the reason it may not."""
        if not plan.waypoints:
            return 'plan has no waypoints'

        with self._lock:
            status = self._status
        if status is None:
            return 'no quadruped_main_status yet; is quadruped_controller running?'

        if not status.current_map:
            return 'no map is loaded'
        if plan.map_name != status.current_map:
            return (f"plan was built on map '{plan.map_name}' but the robot is localized on "
                    f"'{status.current_map}'")

        if status.localization_status != QuadrupedMainStatus.LOCALIZED:
            return f"robot is not localized (localization_status '{status.localization_status}')"

        if status.navigation_state not in ACCEPTING_STATES:
            return (f"robot is '{status.navigation_state}'; cancel the current goal and wait "
                    f"for '{QuadrupedMainStatus.CANCELED}' first")

        return None

    # -- /navigation_plan ------------------------------------------------------

    def _navigation_plan_cb(self, request, response):
        plan = request.navigation_plan

        reason = self._validate(plan)
        if reason is not None:
            response.success = False
            response.message = reason
            self.get_logger().warn(f'navplan {plan.navplan_id} rejected: {reason}')
            return response

        ok, result = self._call_and_wait(
            self._execute_client, NavigationPlanTrigger.Request(navigation_plan=plan),
            '/execute_navplan')

        # yasmin re-checks its own state authoritatively, so it can still say no after our
        # checks passed -- our status snapshot is a 200ms mirror and can be a tick behind.
        if not ok:
            response.success = False
            response.message = result
            self.get_logger().error(f'navplan {plan.navplan_id} not dispatched: {result}')
            return response

        if not result.success:
            response.success = False
            response.message = result.message
            self.get_logger().warn(
                f'navplan {plan.navplan_id} refused by yasmin: {result.message}')
            return response

        response.success = True
        response.message = f'navplan {plan.navplan_id} accepted ({len(plan.waypoints)} waypoints)'
        self.get_logger().info(response.message)
        return response


def main():
    rclpy.init()
    node = NavplanProcessorNode()
    # 3 threads: the inbound service blocks on the /execute_navplan response, which needs the
    # client callback delivered underneath it, with /quadruped_main_status still flowing.
    executor = MultiThreadedExecutor(num_threads=3)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == '__main__':
    main()
