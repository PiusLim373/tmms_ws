FROM ros:jazzy

USER root

# Install dependencies
RUN apt-get update && \
    apt-get install -y \
    git \
    build-essential \
    python3-colcon-common-extensions \
    python3-rosdep \
    python3-pip \
    libyaml-cpp-dev \
    libboost-dev \
    libeigen3-dev \
    ros-jazzy-rmw-cyclonedds-cpp \
    ros-jazzy-rosidl-generator-dds-idl \
    nano \
    openssh-server \
    net-tools \
    wireless-tools \
    usbutils \
    pciutils \
    htop \
    ros-jazzy-spacenav \
    iputils-ping \
    iproute2 \
    lsof \
    ros-jazzy-rosbridge-suite \
    ros-jazzy-rtabmap-ros \
    ros-jazzy-librealsense2* \
    ros-jazzy-realsense2-* \
    ros-jazzy-navigation2 \
    ros-jazzy-nav2-bringup

RUN apt-get install -y \
    libpcl-dev \
    libeigen3-dev

# Setup ROS environment
SHELL ["/bin/bash", "-c"]
RUN rosdep update

# Rename existing UID-1000 'ubuntu' user to 'htxgrrt' instead of creating a new one
RUN usermod -l htxgrrt -d /home/htxgrrt -m ubuntu \
    && groupmod -n htxgrrt ubuntu

# Grant sudo privileges to 'htxgrrt' without password
RUN echo "htxgrrt ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Switch to user 'htxgrrt'
USER htxgrrt
WORKDIR /home/htxgrrt

# Create folders
RUN mkdir -p /home/htxgrrt/.htxgrrt/bin/tmms_ws
WORKDIR /home/htxgrrt/.htxgrrt/bin/tmms_ws

# Setup ROS environment for the user
RUN echo "source /opt/ros/jazzy/setup.bash" >> /home/htxgrrt/.bashrc
RUN echo "export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp" >> /home/htxgrrt/.bashrc
RUN echo "source /home/htxgrrt/.htxgrrt/bin/tmms_ws/custom.env" >> /home/htxgrrt/.bashrc
RUN echo "PS1='\\[\\033[1;38;2;85;52;128m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[00;31m\\]\\w\\[\\033[00m\\]\\$ '" >> /home/htxgrrt/.bashrc

# Some shortcuts aliases for convenience
# check disk usage of directories
RUN echo "alias dir_du='du -h --max-depth=1 | sort -hr'" >> /home/htxgrrt/.bashrc
# build in Release mode
RUN echo "alias build_all='colcon build --cmake-args -DCMAKE_BUILD_TYPE=Release'" >> /home/htxgrrt/.bashrc
# tar the install folder
RUN echo "alias tar_install='tar -cvzf install.tar.gz install/'" >> /home/htxgrrt/.bashrc

# temp folder for building and installing dependencies
RUN mkdir -p /home/htxgrrt/.htxgrrt/tmp

# build and install LivoxSDK2, required to build fastlio, runtime not needed
RUN cd /home/htxgrrt/.htxgrrt/tmp && \
    git clone https://github.com/Livox-SDK/Livox-SDK2.git && \
    cd Livox-SDK2 && \
    mkdir build && cd build && \
    cmake .. && \
    make -j$(nproc) && \
    sudo make install
    
# build and install sophus, requered to build fastlivo
RUN cd /home/htxgrrt/.htxgrrt/tmp && \
    git clone --depth=1 https://github.com/strasdat/Sophus.git -b 1.22.10 && \
    cd Sophus && \
    mkdir build && cd build && \
    cmake -DBUILD_SOPHUS_TESTS=OFF -DBUILD_SOPHUS_EXAMPLES=OFF -DCMAKE_BUILD_TYPE=Release .. && \
    make -j$(nproc) && \
    sudo make install

# clean up
RUN rm -rf /home/htxgrrt/.htxgrrt/tmp


# Default entrypoint
ENTRYPOINT ["/bin/bash"]