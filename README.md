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
└── tmms_ui/              # React + Vite web UI
```

## Build

### 1. Clone with submodules

```bash
git clone --recurse-submodules <repo-url>
```

### 2. Build the workspace

```bash
colcon build --symlink-install
```

### 3. Configure the CycloneDDS network interface

Edit `unitree_ros2_comms.sh` and change the `NetworkInterface name` to the network interface connected to your Unitree B2 robot:

```xml
<NetworkInterface name="YOUR_INTERFACE" priority="default" multicast="default" />
```

Also update the `source` path on line 4 to match your actual workspace install folder path.

### 4. Source on startup

Add the script to `~/.bashrc` so it is sourced automatically (it also sources the workspace install folder):

```bash
echo "source /path/to/tmms_ws/unitree_ros2_comms.sh" >> ~/.bashrc
source ~/.bashrc
```

### 5. Restart the ROS2 daemon

Required for ROS2 to pick up the custom CycloneDDS 0.10.x build:

```bash
ros2 daemon stop && ros2 daemon start
```

## Run

```bash
ros2 launch tmms_master operation.launch.py
```

This starts:
- `z1_ctrl` — Z1 arm UDP service
- `z1_robot_controller` — Z1 arm ROS2 controller
- `quadruped_controller` — B2 quadruped controller
- `spacenav` — SpaceNavigator driver
- `joy` — Gamepad/flight controller driver
- `rosbridge_server` — WebSocket bridge for the UI

## Web UI

```bash
cd app/tmms_ui
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

> Auto-serve via nginx — coming soon.

## Docker

Coming soon.
