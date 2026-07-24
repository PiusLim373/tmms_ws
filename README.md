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

</details>

## Launching

With supervisor set up, the system starts itself on bootup. All 4 programs run under the `quadruped` supervisor group: `tmms_ws`, `tmms_ui`, `tmms_lichtblick`, and `tmms_cams` (an external camera pipeline from the separate `surround-view-system-introduction` repo, not part of this workspace).

Useful commands:

```bash
sudo supervisorctl status               # check status of all tasks
sudo supervisorctl stop quadruped:tmms_ws   # stop the main ros2 container
sudo supervisorctl start quadruped:tmms_ui  # start the webapp
```
