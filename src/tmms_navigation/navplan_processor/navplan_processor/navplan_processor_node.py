#!/usr/bin/env python3
"""Gatekeeper between an operator's navigation plan and the state machine that drives it.

The UI never calls tmms_yasmin directly. A plan arrives here on /navigation_plan, is checked
against what the robot is actually doing, turned into a route, and only then forwarded to
yasmin's /execute_route. Same shape as localization_manager, which gates /map_load and
/lichtblick_initialpose in front of nav2.

ROUTES. A plan is a flat waypoint list that may cross maps. A map_switch waypoint (msw) whose
new_map_name differs from its map_name is where the robot relocalizes into the next map, so
the route is cut there: that segment ends on the msw with end_action map_switching, and the
next starts with the msw's copy in the new map (new_map_name, new_map_pose). An msw naming
its own map is a plain pass-through. The last segment ends idle.

WHY A SEPARATE NODE. The checks are about the plan rather than about navigation: does it
start on the map the robot is localized on, does every map change go through an msw, is the
robot free to accept work at all. Keeping them here leaves yasmin owning only goal
dispatch, and gives later per-plan behaviour (end actions, a plan store) somewhere to live
that is not the FSM.

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

import copy
import os
import re
import threading

import rclpy
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup, ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from tmms_msgs.msg import QuadrupedMainStatus, Route, RouteSegment, Waypoint
from tmms_msgs.srv import NavigationPlanTrigger, RouteTrigger

# States in which the robot is free to take on a new plan. Everything else is either busy
# (navigating), not ready (unlocalized), handed to the operator (paused), or broken (error).
# The operator is expected to cancel and wait for `canceled` before sending the next plan.
ACCEPTING_STATES = frozenset({
    QuadrupedMainStatus.IDLE,
    QuadrupedMainStatus.CANCELED,
    QuadrupedMainStatus.NAVIGATION_FAILED,
})

# Same rule as localization_manager's: map names become file paths, so no dot or slash.
MAP_NAME_RE = re.compile(r'^[A-Za-z0-9_]+$')


def pose_unset(pose):
    """True for a pose the sender left out.

    Omitted fields arrive as defaults and a ROS 2 quaternion defaults to identity, so an
    omitted pose reads as the origin facing +x; that exact pose counts as unset. An all-zero
    quaternion is no orientation at all.
    """
    p, q = pose.position, pose.orientation
    if q.x == 0.0 and q.y == 0.0 and q.z == 0.0 and q.w == 0.0:
        return True
    return (p.x == 0.0 and p.y == 0.0 and p.z == 0.0
            and q.x == 0.0 and q.y == 0.0 and q.z == 0.0 and q.w == 1.0)


def switches_map(wp):
    """An msw that changes map. One naming its own map is a plain pass-through."""
    return wp.type == Waypoint.MAP_SWITCH and wp.new_map_name != wp.map_name


def _check_map(name, map_exists):
    if not MAP_NAME_RE.match(name):
        return f"'{name}' is not a valid map name"
    if not map_exists(name):
        return f"map '{name}' does not exist"
    return None


def check_waypoints(waypoints, current_map, map_exists):
    """Returns None if the waypoints make a valid route from current_map, else the reason.

    Walks the list tracking the map the robot will be on. Only a switching msw changes it,
    so every waypoint must name that map.
    """
    cur = current_map
    for i, wp in enumerate(waypoints):
        where = f'waypoint {i} (id {wp.id})'
        reason = _check_map(wp.map_name, map_exists)
        if reason is not None:
            return f'{where}: {reason}'
        if i == 0 and wp.map_name != cur:
            return (f"plan starts on map '{wp.map_name}' but the robot is localized on "
                    f"'{cur}'")
        if wp.map_name != cur:
            return (f"{where} is on map '{wp.map_name}' but the robot will be on '{cur}'; "
                    f'a map change needs a map_switch waypoint before it')
        if wp.type != Waypoint.MAP_SWITCH:
            continue

        if not wp.new_map_name:
            return f'{where}: map_switch waypoint has no new_map_name'
        reason = _check_map(wp.new_map_name, map_exists)
        if reason is not None:
            return f'{where}: new_map_name {reason}'
        if pose_unset(wp.new_map_pose):
            return f'{where}: map_switch waypoint has no new_map_pose'
        if i + 1 < len(waypoints) and waypoints[i + 1].map_name != wp.new_map_name:
            return (f"{where} switches to '{wp.new_map_name}' but the next waypoint is on "
                    f"'{waypoints[i + 1].map_name}'")
        cur = wp.new_map_name
    return None


def build_route(waypoints):
    """One segment per map, cut at each switching msw. Assumes check_waypoints passed."""
    route = Route()
    segment = RouteSegment()
    for wp in waypoints:
        segment.waypoints.append(wp)
        if not switches_map(wp):
            continue
        segment.end_action = RouteSegment.MAP_SWITCHING
        route.route_segments.append(segment)
        # The same spot in the new map: yasmin relocalizes onto it, then drives on from it.
        arrival = copy.deepcopy(wp)
        arrival.map_name = wp.new_map_name
        arrival.pose = copy.deepcopy(wp.new_map_pose)
        segment = RouteSegment(waypoints=[arrival])
    segment.end_action = RouteSegment.IDLE
    route.route_segments.append(segment)
    return route


class NavplanProcessorNode(Node):

    def __init__(self):
        super().__init__('navplan_processor')

        self.declare_parameter('service_timeout_sec', 10.0)
        # Root of the map store, same convention as localization_manager: 2D maps in png/.
        self.declare_parameter('maps_dir', '~/.htxgrrt/maps')

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
            RouteTrigger, '/execute_route', callback_group=self._aux_group)

        self.create_service(
            NavigationPlanTrigger, '/navigation_plan', self._navigation_plan_cb,
            callback_group=self._srv_group)

        self.get_logger().info('navplan_processor ready on /navigation_plan')

    # -- helpers ---------------------------------------------------------------

    def _param(self, name):
        return self.get_parameter(name).value

    def _map_exists(self, name):
        maps_dir = os.path.expanduser(str(self._param('maps_dir')))
        return os.path.isfile(os.path.join(maps_dir, 'png', f'{name}.yaml'))

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

        if status.localization_status != QuadrupedMainStatus.LOCALIZED:
            return f"robot is not localized (localization_status '{status.localization_status}')"

        if status.navigation_state not in ACCEPTING_STATES:
            return (f"robot is '{status.navigation_state}'; cancel the current goal and wait "
                    f"for '{QuadrupedMainStatus.CANCELED}' first")

        return check_waypoints(plan.waypoints, status.current_map, self._map_exists)

    # -- /navigation_plan ------------------------------------------------------

    def _navigation_plan_cb(self, request, response):
        plan = request.navigation_plan

        reason = self._validate(plan)
        if reason is not None:
            response.success = False
            response.message = reason
            self.get_logger().warn(f'navplan {plan.navplan_id} rejected: {reason}')
            return response

        route = build_route(plan.waypoints)
        ok, result = self._call_and_wait(
            self._execute_client, RouteTrigger.Request(navigation_plan=plan, route=route),
            '/execute_route')

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
        response.message = (f'navplan {plan.navplan_id} accepted ({len(plan.waypoints)} '
                            f'waypoints, {len(route.route_segments)} segments)')
        self.get_logger().info(response.message)
        return response


def main():
    rclpy.init()
    node = NavplanProcessorNode()
    # 3 threads: the inbound service blocks on the /execute_route response, which needs the
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
