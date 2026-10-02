# HTX Teleoperated Mobile Manipulator System (TMMS)

ROS2 Jazzy workspace for the HTX Teleoperated Mobile Manipulator System — a Unitree B2 quadruped with a Unitree Z1 arm, controlled via SpaceNavigator, gamepad, or the web UI.

## Repository Structure

```
src/
├── tmms_master/          # Master launch file
├── tmms_msgs/            # Custom ROS2 message definitions
├── tmms_mock/            # Simulation/mock nodes
├── z1_robot_controller/  # Unitree Z1 arm controller
├── quadruped_controller/ # Unitree B2 quadruped controller
├── arduino_controller/   # Arduino peripheral controller
└── utils/
    └── cyclonedds_ws/    # Custom CycloneDDS 0.10.x build (submodules)
app/
├── tmms_ui/              # React + Vite web UI + Express backend (docker container)
├── tmms_ws/               # Runtime deploy config for the core ROS2 container: compose, entrypoint, supervisor conf, rosbag rotation cron
└── tmms_lichtblick/       # Lichtblick mcap/rosbag viewer container config
devops/
├── tmms_ws.Dockerfile           # Build/runtime image for the core ROS2 workspace
├── tmms_ui.Dockerfile           # Build/serve image for the web UI
├── tmms_ws-devops-compose.yaml  # Dev-machine build container (colcon build inside)
└── certs/                       # TLS cert/key for rosbridge + UI SSL
```


## Setup

Clone the repository and pull in its submodules:

```bash
git clone git@github.com:PiusLim373/tmms_ws.git
cd tmms_ws
git submodule update --init --recursive
```

The submodules cover CycloneDDS/`rmw_cyclonedds`, FAST_LIO, FAST-LIVO2-ROS2 and the `tmms` branch of navigation2 — the workspace will not build without them.

Then export `TMMS_WS_PATH` pointing at your checkout of this workspace:

```bash
export TMMS_WS_PATH=/abs/path/to/tmms_ws
```

Add it to your `~/.bashrc` to make it permanent.

This is required — `devops/tmms_ws-devops-compose.yaml` reads it to decide what to bind-mount into the build container, and `docker compose` will refuse to start without it. It also lets you use `$TMMS_WS_PATH` in place of `<PATH TO TMMS_WS>` in every command below.

## Build

There are two ways to build this workspace: quick iteration on a dev machine, or an official build for the actual robot.

<details>
<summary><b>Build And Test Locally With Dev Machine</b></summary>

```bash
source <PATH TO TMMS_WS>/tmms_ws/unitree_ros2_comms.sh
colcon build --symlink-install
ros2 launch tmms_master operation.launch.py
```

`operation.launch.py` starts:
- `z1_ctrl` — Z1 arm UDP service (arch-specific binary, arm64/x86 picked automatically)
- `z1_robot_controller` — Z1 arm ROS2 controller
- `quadruped_controller` — B2 quadruped controller (started 5s after the above, to avoid breaking the Z1 gripper connection)
- `rosbridge_server` — WebSocket bridge for the UI

For the UI, in a separate terminal:

Install [Node.js 24](https://nodejs.org/en/download), then:

```bash
cd <PATH TO TMMS_WS>/app/tmms_ui
npm install
npm run build
NODE_ENV=production npm run backend
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

</details>

<details>
<summary><b>Prod Build (Official Build, For Actual Prod Run)</b></summary>

Each folder in `app/` is a separate docker project. The prod machine (Unitree B2 PC5) is **arm64**, so images must be cross-built.

#### tmms_ws (Core ROS2 Program)

Docker image: `tmms_image:<VERSION>`, e.g. `tmms_image:0.1.1`. Used both to compile this repo and as the running environment on the robot, so both sides share the same env. Built from `devops/tmms_ws.Dockerfile`.

```bash
# register QEMU emulators for cross-arch builds
# (run occasionally if you hit: exec /bin/bash: exec format error)
docker run --privileged --rm tonistiigi/binfmt --install arm64

# create a builder that supports it (skip if you already have one)
docker buildx rm xbuilder
docker buildx create --name xbuilder --use
docker buildx inspect --bootstrap

# build (run from the tmms_ws/ repo root)
docker buildx build --platform linux/arm64 \
  -f <PATH TO TMMS_WS>/devops/tmms_ws.Dockerfile \
  -t tmms_image:<VERSION> \
  --load .
```

This generates `tmms_image:<VERSION>` under `docker images`.

Docker pull: *coming soon* — pull this image on both the robot and the dev laptop.

Once you have the image, compile the source code:

```bash
docker compose -f <PATH TO TMMS_WS>/devops/tmms_ws-devops-compose.yaml up -d
docker exec -it tmms_build /bin/bash
# (if you hit "exec /bin/bash: exec format error" here, run the binfmt install command above)
colcon build --cmake-args -DCMAKE_BUILD_TYPE=Release
```

This produces the `install/` folder. Build successful — proceed to the [Deploy](#deploy) section below.

#### tmms_ui (The UI)

Docker image: `tmms_ui_image:<VERSION>`, e.g. `tmms_ui_image:0.1.1`. Used to both build the React web app and serve it on the robot. Built from `devops/tmms_ui.Dockerfile`.

```bash
# same cross-arch setup as above (skip if already done)
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx rm xbuilder
docker buildx create --name xbuilder --use
docker buildx inspect --bootstrap

# build (run from the tmms_ws/ repo root, since app/tmms_ui/ paths are relative to the build context)
docker buildx build --platform linux/arm64 \
  -f <PATH TO TMMS_WS>/devops/tmms_ui.Dockerfile \
  -t tmms_ui_image:<VERSION> \
  --load .
```

This generates `tmms_ui_image:<VERSION>` under `docker images`.

Docker pull: *coming soon* — pull this image on both the robot and the dev laptop.

Once you have the image, compile the webapp from source:

```bash
cd app/tmms_ui
npm install
npm run build
```

This produces the `dist/` folder. Build successful — proceed to the [Deploy](#deploy) section below.

#### tmms_lichtblick (MCAP / Rosbag Player)

Docker image: `lichtblick:1.27.1-arm64`. The official Lichtblick image is only published for x86, so this version is built from source for arm64 by checking out the latest release branch:

```bash
git clone git@github.com:lichtblick-suite/lichtblick.git -b v1.27.1
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx build --platform linux/arm64 \
  -f <PATH TO LICHTBLICK>/Dockerfile \
  -t lichtblick:1.27.1-arm64 \
  --load .
```

No further compilation is required — it's a plug-and-play mcap/rosbag player.

</details>

## Deploy

Robot: Unitree B2 quadruped, PC5 (arm64), `unitree@192.168.123.165` — username `unitree`, password `Unitree0408`.

<details>
<summary><b>First Deployment (Fresh Robot — No images or no `~/.htxgrrt/` yet)</b></summary>

Transfer and load the 3 built images onto the robot:

```bash
# tmms_ws
docker save tmms_image:<VERSION> -o tmms_image_<VERSION>.tar
scp tmms_image_<VERSION>.tar unitree@192.168.123.165:~/

# tmms_ui
docker save tmms_ui_image:<VERSION> -o tmms_ui_image_<VERSION>.tar
scp tmms_ui_image_<VERSION>.tar unitree@192.168.123.165:~/

# tmms_lichtblick
docker save lichtblick:1.27.1-arm64 -o tmms_lichtblick_1.27.1-arm64.tar
scp tmms_lichtblick_1.27.1-arm64.tar unitree@192.168.123.165:~/

# on the robot, load the images
docker load -i tmms_image_<VERSION>.tar
docker load -i tmms_ui_image_<VERSION>.tar
docker load -i tmms_lichtblick_1.27.1-arm64.tar
```

Populate `~/.htxgrrt/bin/` (copy of this repo's `app/` folder, renamed to `bin/`):

```bash
ssh unitree@192.168.123.165 mkdir -p /home/unitree/.htxgrrt/
scp -r <PATH TO TMMS_WS>/app unitree@192.168.123.165:/home/unitree/.htxgrrt/
ssh unitree@192.168.123.165 mv /home/unitree/.htxgrrt/app /home/unitree/.htxgrrt/bin
```

Populate `~/.htxgrrt/certs/`:

```bash
ssh unitree@192.168.123.165 mkdir -p /home/unitree/.htxgrrt/
scp -r <PATH TO TMMS_WS>/devops/certs unitree@192.168.123.165:/home/unitree/.htxgrrt/
```

Populate `~/.htxgrrt/bags/`:

```bash
ssh unitree@192.168.123.165 mkdir -p /home/unitree/.htxgrrt/bags/ongoing_rosbags
ssh unitree@192.168.123.165 mkdir -p /home/unitree/.htxgrrt/bags/rosbags
```

Install Flask, which `reboot_manager.py` needs. It runs on the host under supervisor with the
system `python3` (not in a venv and not in a container), and Ubuntu marks that interpreter
externally-managed, so use the distro package rather than `pip`:

```bash
# inside robot PC5
sudo apt install -y python3-flask
```

Set up supervisor (auto-launches/manages the containers on bootup and during runtime):

```bash
# inside robot PC5
ln -s /home/unitree/.htxgrrt/bin/tmms_ws/tmms_supervisor.conf /etc/supervisor/conf.d/tmms_supervisor.conf
sudo supervisorctl reread
sudo supervisorctl reload
```

With the folder structure and supervisor config in place, the software binaries can now be deployed into these folders — see [Incremental Updates](#incremental-updates) below.

</details>

<details>
<summary><b>Incremental Updates</b></summary>

**tmms_ws (Core ROS2 Program)** — after `install/` is built on the dev machine, rsync it to PC5:

```bash
rsync -avz --delete <PATH TO TMMS_WS>/install/ unitree@192.168.123.165:/home/unitree/.htxgrrt/bin/tmms_ws/install/
```

**tmms_ui (the UI)** — after `dist/` is built on the dev machine, rsync it to PC5:

```bash
rsync -avz --delete app/tmms_ui/dist app/tmms_ui/ui_backend.js app/tmms_ui/scripts unitree@192.168.123.165:/home/unitree/.htxgrrt/bin/tmms_ui/
```

**tmms_reboot_manager** — the two rsyncs above only cover `install/` and the UI, so the host-side
reboot manager has to be copied on its own whenever it changes:

```bash
scp app/tmms_ws/reboot_manager.py unitree@192.168.123.165:/home/unitree/.htxgrrt/bin/tmms_ws/
ssh unitree@192.168.123.165 'sudo supervisorctl restart quadruped:tmms_reboot_manager'
```

</details>

## Launching

With supervisor set up, the system starts itself on bootup. All 4 programs run under the `quadruped` supervisor group: `tmms_ws`, `tmms_ui`, `tmms_lichtblick`, and `tmms_cams` (an external camera pipeline from the separate `surround-view-system-introduction` repo, not part of this workspace).

Useful commands:

```bash
sudo supervisorctl status               # check status of all tasks
sudo supervisorctl stop quadruped:tmms_ws   # stop the main ros2 container
sudo supervisorctl start quadruped:tmms_ui  # start the webapp
```

## C2 Integration

How a C2 (fleet manager) drives the robot's navigation:

1. [Load a map](#1-load-a-map)
2. [Relocalize](#2-relocalize) the robot on it
3. [Send a navplan](#3-send-a-navplan): a list of waypoints the robot drives through in order
4. [Cancel or replace](#4-cancel-or-replace-a-navplan) it if needed

Everything goes through rosbridge. Each step shows the `ros2` CLI form, for testing on the robot, and the rosbridge message C2 sends. Every outcome is read from one topic, [`/quadruped_main_status`](#robot-status).

For service calls, rosbridge answers with `result: false` only when the call itself failed (e.g. the service is not running, or it timed out). A request the robot refuses comes back as `result: true` with `values.success: false` and the reason in `values.message`.

rosbridge gives up on a service call after **5 s** unless the request carries a `timeout` (seconds). `/map_load` and `/navigation_plan` can take longer, so their samples set one. A call that times out returns `result: false` even though the robot may still complete it, so check `/quadruped_main_status` afterwards.

### Robot status

**Topic** `/quadruped_main_status` (`tmms_msgs/msg/QuadrupedMainStatus`), published at 5 Hz. This is the only topic C2 needs to watch.

```bash
ros2 topic echo /quadruped_main_status
```

```json
{"op": "subscribe", "topic": "/quadruped_main_status", "type": "tmms_msgs/msg/QuadrupedMainStatus"}
```

Each message arrives as:

```json
{
  "op": "publish",
  "topic": "/quadruped_main_status",
  "msg": {
    "pose": {"position": {"x": 1.02, "y": 1.98, "z": 0.0}, "orientation": {"x": 0.0, "y": 0.0, "z": 0.7071, "w": 0.7071}},
    "battery_percentage": 87,
    "robot_mode": "locomotion",
    "navigation_state": "navigating",
    "is_paused": false,
    "localization_status": "localized",
    "current_map": "my_map",
    "current_navplan_id": 1790925740000,
    "current_navplan_status": "executing"
  }
}
```

| Field | Meaning |
|---|---|
| `pose` | Robot pose in the `map` frame. Reads as the map origin until the robot is first localized. |
| `battery_percentage` | 0–100. |
| `robot_mode` | The B2's motion mode (`balance_stand`, `locomotion`, `damping`, …). |
| `navigation_state` | What navigation is doing; see below. |
| `is_paused` | `true` while an operator has manual control. |
| `localization_status` | `not_started` → `pending` → `localized` or `failed`. A localized robot can later drop to `localization_lost`. |
| `current_map` | Name of the loaded map; empty until one is loaded. |
| `current_navplan_id` | The latest navplan the robot accepted; `0` before the first one. |
| `current_navplan_status` | Its status; see [step 3](#3-send-a-navplan). |

`navigation_state`:

| Value | Meaning | Navplan | Map load / relocalize |
|---|---|---|---|
| `unlocalized` | Not localized yet, or localization was lost | refused | allowed |
| `idle` | Ready | allowed | allowed |
| `navigating` | A navplan is running | refused | refused |
| `canceled` | The last navplan was cancelled; ready | allowed | allowed |
| `navigation_failed` | The last navplan could not be completed; ready | allowed | allowed |
| `paused` | An operator has manual control | refused | allowed |
| `error` | System fault, e.g. a stale sensor feed. Clears itself back to `idle` | refused | allowed |

Values are sampled at 5 Hz, so a state that lasts only milliseconds (such as a navplan's `accepted`) may never appear. If the robot's controller restarts, the two navplan fields read `0` / empty until the next navplan status change.

### 1. Load a map

**Service** `/map_load` (`tmms_msgs/srv/StringTrigger`: `string data` → `bool success`, `string message`)

`data` is the bare map name, letters, digits and `_` only. The robot loads `~/.htxgrrt/maps/png/<name>.yaml` with its `.png`, then the 3D cloud named in the yaml's `pcd_file`, if any. The response comes after both, usually within a few seconds, up to about 30 s at worst.

```bash
ros2 service call /map_load tmms_msgs/srv/StringTrigger "{data: 'my_map'}"
```

```json
{"op": "call_service", "id": "map_load_1", "service": "/map_load", "type": "tmms_msgs/srv/StringTrigger", "args": {"data": "my_map"}, "timeout": 30}
```

Success:

```json
{"op": "service_response", "id": "map_load_1", "service": "/map_load", "result": true, "values": {"success": true, "message": "Map loaded: my_map"}}
```

`current_map` becomes `my_map` and `localization_status` resets to `not_started`: the old pose means nothing on the new map, so [relocalize](#2-relocalize) next.

On failure `success` is `false`, nothing changes on the robot, and `message` is one of:

| `message` | Cause |
|---|---|
| `Map load rejected: robot is '<state>'; allowed: canceled, error, idle, navigation_failed, paused, unlocalized` | The robot is navigating. Cancel first. |
| `Map load rejected: '<name>' is not a valid map name (letters, digits and underscore only)` | Bad name. |
| `Map load rejected: <path> does not exist` | No such map on the robot. |
| `Map load rejected: no /quadruped_main_status received yet -- is quadruped_controller up?` | The robot's software is still starting. |
| `Map load failed: /map_server/load_map is not available`, `... did not return within 10s`, `... call failed` | The navigation stack is not running or not responding. |
| `Map load failed: map file does not exist`, `invalid map data (is the .png readable?)`, `invalid map metadata (check the .yaml)`, `undefined failure in map_server`, `unknown result code <n>` | The map files are broken. |

### 2. Relocalize

**Topic** `/lichtblick_initialpose` (`geometry_msgs/msg/PoseWithCovarianceStamped`)

Publish roughly where the robot is on the map; the robot refines it.

- `header.frame_id` must be `map`.
- Heading is a quaternion: for a yaw of θ radians, `z = sin(θ/2)` and `w = cos(θ/2)`.
- Leave the covariance out (all zeros); the robot fills in its own default spread.
- Don't publish to `/initialpose` directly. It skips the checks and the status reporting below.

```bash
ros2 topic pub --once /lichtblick_initialpose geometry_msgs/msg/PoseWithCovarianceStamped \
  "{header: {frame_id: map}, pose: {pose: {position: {x: 1.0, y: 2.0, z: 0.0}, orientation: {z: 0.7071, w: 0.7071}}}}"
```

```json
{"op": "advertise", "topic": "/lichtblick_initialpose", "type": "geometry_msgs/msg/PoseWithCovarianceStamped"}
{"op": "publish", "topic": "/lichtblick_initialpose", "msg": {"header": {"frame_id": "map"}, "pose": {"pose": {"position": {"x": 1.0, "y": 2.0, "z": 0.0}, "orientation": {"x": 0.0, "y": 0.0, "z": 0.7071, "w": 0.7071}}}}}
```

This is a topic, so there is no response. Watch `localization_status` instead: it goes `pending` for about 6 s, then `localized` or `failed`. Once `localized`, `navigation_state` moves from `unlocalized` to `idle`.

`failed` carries no reason; that is only in the robot's log. The causes are:

| Cause | Fix |
|---|---|
| The robot is `navigating` | Cancel first. |
| No map loaded | [Load a map](#1-load-a-map) first. |
| `header.frame_id` is not `map` | Fix the message. |
| The estimate is too far off for the lidar to match the map | Send a closer estimate. |
| The navigation stack is not running | Restart it. |

A pose sent while one is already `pending` is ignored completely, with no status change. Wait for `localized` or `failed` before sending another.

If the robot later loses its position, `localization_status` becomes `localization_lost` and `navigation_state` becomes `unlocalized`, stopping any running navplan. Relocalize again.

### 3. Send a navplan

**Service** `/navigation_plan` (`tmms_msgs/srv/NavigationPlanTrigger`: `NavigationPlan navigation_plan` → `bool success`, `string message`)

`tmms_msgs/msg/NavigationPlan`:

| Field | Type | Notes |
|---|---|---|
| `navplan_id` | `int64` | Unique and non-zero. Epoch milliseconds works. |
| `map_name` | `string` | Must equal `current_map`. |
| `timestamp` | `string` | Free text, e.g. ISO 8601. Not checked. |
| `status` | `string` | Send `created`. Not checked. |
| `waypoints` | `geometry_msgs/Pose[]` | In the `map` frame, at least one, driven through in order. Orientation as in [step 2](#2-relocalize). |

```bash
ros2 service call /navigation_plan tmms_msgs/srv/NavigationPlanTrigger "{navigation_plan: {
  navplan_id: 1790925740000, map_name: 'my_map', timestamp: '2026-10-02T10:00:00Z', status: 'created',
  waypoints: [
    {position: {x: 1.0, y: 0.5, z: 0.0}, orientation: {z: 0.0, w: 1.0}},
    {position: {x: 2.0, y: 1.5, z: 0.0}, orientation: {z: 0.7071, w: 0.7071}}]}}"
```

```json
{"op": "call_service", "id": "navplan_1", "service": "/navigation_plan", "type": "tmms_msgs/srv/NavigationPlanTrigger",
 "args": {"navigation_plan": {
   "navplan_id": 1790925740000, "map_name": "my_map", "timestamp": "2026-10-02T10:00:00Z", "status": "created",
   "waypoints": [
     {"position": {"x": 1.0, "y": 0.5, "z": 0.0}, "orientation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}},
     {"position": {"x": 2.0, "y": 1.5, "z": 0.0}, "orientation": {"x": 0.0, "y": 0.0, "z": 0.7071, "w": 0.7071}}]}},
 "timeout": 20}
```

Success:

```json
{"op": "service_response", "id": "navplan_1", "service": "/navigation_plan", "result": true, "values": {"success": true, "message": "navplan 1790925740000 accepted (2 waypoints)"}}
```

A navplan is accepted only when a map is loaded, `localization_status` is `localized`, and `navigation_state` is `idle`, `canceled` or `navigation_failed`. Otherwise `success` is `false` and `message` is one of:

| `message` | Cause |
|---|---|
| `plan has no waypoints` | Empty `waypoints`. |
| `no map is loaded` | Load a map first. |
| `plan was built on map '<a>' but the robot is localized on '<b>'` | `map_name` ≠ `current_map`. |
| `robot is not localized (localization_status '<s>')` | Relocalize first. |
| `robot is '<state>'; cancel the current goal and wait for 'canceled' first` | `navigation_state` doesn't accept navplans (e.g. `navigating`, `paused`, `error`). |
| `robot is '<state>'; cancel the current goal first` | Same, caught a moment later. |
| `navplan <id> is still waiting to be dispatched`, `navplan <id> is already in progress` | Another navplan was accepted moments ago. |
| `no quadruped_main_status yet; is quadruped_controller running?` | The robot's software is still starting. |
| `/execute_navplan is not available`, `... did not return within 10s`, `... call failed` | The navigation state machine is not running. |

**A refused navplan changes nothing in `/quadruped_main_status`.** The response is the only place it shows, and a running navplan keeps being reported.

Once accepted, `current_navplan_id` becomes the plan's id and `current_navplan_status` moves through:

```
accepted → executing → completed | cancelled | errored
accepted → rejected | errored                (could not be started)
```

| Final status | Meaning | `navigation_state` after |
|---|---|---|
| `completed` | Reached the last waypoint | `idle` |
| `cancelled` | Cancelled with [`/cancel_goal`](#4-cancel-or-replace-a-navplan) | `canceled` |
| `errored` | Navigation gave up, e.g. no path or the robot is stuck | `navigation_failed` |
| `errored` | Localization was lost | `unlocalized` |
| `errored` | A system fault | `error`, then `idle` once it clears |
| `rejected` or `errored` | Could not be started: the navigation stack refused it or is not running | unchanged |

### 4. Cancel or replace a navplan

**Service** `/cancel_goal` (`std_srvs/srv/Empty`)

```bash
ros2 service call /cancel_goal std_srvs/srv/Empty
```

```json
{"op": "call_service", "id": "cancel_1", "service": "/cancel_goal", "type": "std_srvs/srv/Empty", "args": {}}
```

The response is empty and the call never fails. It does nothing if no navplan is running. Otherwise the robot stops, `current_navplan_status` becomes `cancelled` and `navigation_state` becomes `canceled`.

A new navplan never replaces a running one; it is refused. To replace one:

1. Call `/cancel_goal`.
2. Wait until `navigation_state` is `idle`, `canceled` or `navigation_failed`. Don't wait for `canceled` alone: the plan may finish or fail at the same moment and land in `idle` or `navigation_failed` instead. If it lands in `unlocalized` or `error`, deal with that first.
3. Send the new navplan.
