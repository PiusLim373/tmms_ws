cmake_minimum_required(VERSION 3.8)
project(mapping_utils)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# PCL 1.14 headers on Jazzy require C++17 (same reason FAST_LIO forces C++17).
# Upstream's `-std=c++11` will not compile here.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  # No -Wpedantic: PCL_ADD_POINT4D uses an anonymous struct inside a union, a GNU
  # extension, which would spam warnings from our own translation unit.
  add_compile_options(-Wall -Wextra)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(pcl_conversions REQUIRED)
# `io` not needed: no PCD read/write here. `filters` is for map_downsampler_node's VoxelGrid.
find_package(PCL REQUIRED COMPONENTS common filters)

add_executable(lidar_converter_node src/lidar_converter_node.cpp)
ament_target_dependencies(lidar_converter_node rclcpp sensor_msgs pcl_conversions)
target_include_directories(lidar_converter_node PRIVATE ${PCL_INCLUDE_DIRS})
target_link_libraries(lidar_converter_node ${PCL_LIBRARIES})
# Deliberately NOT add_definitions(${PCL_DEFINITIONS}) -- on some systems PCL injects
# -march=native there, which ABI-mismatches against the distro-built libpcl.

add_executable(map_downsampler_node src/map_downsampler_node.cpp)
ament_target_dependencies(map_downsampler_node rclcpp sensor_msgs pcl_conversions)
target_include_directories(map_downsampler_node PRIVATE ${PCL_INCLUDE_DIRS})
target_link_libraries(map_downsampler_node ${PCL_LIBRARIES})

install(TARGETS lidar_converter_node map_downsampler_node
  DESTINATION lib/${PROJECT_NAME})

# mapping_manager_node is Python -- it is process orchestration (spawn/signal/reap a
# `ros2 launch` child), not a hot loop, and subprocess + os.killpg is a fraction of the
# fork/execvp/waitpid it would take in C++. A plain install(PROGRAMS) is enough: it is a
# single self-contained script, so the package stays ament_cmake with no Python package
# layout to maintain. Invoked as `mapping_manager_node.py`, extension included.
install(PROGRAMS scripts/mapping_manager_node.py
  DESTINATION lib/${PROJECT_NAME})

# No launch/ here: fast_lio.launch.py and fast_livo.launch.py live in tmms_master, so the
# dependency runs one way only (tmms_master -> mapping_utils).

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  set(ament_cmake_copyright_FOUND TRUE)
  set(ament_cmake_cpplint_FOUND TRUE)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
