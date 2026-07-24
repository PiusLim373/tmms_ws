cmake_minimum_required(VERSION 3.8)
project(quadruped_controller)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(unitree_api REQUIRED)
find_package(unitree_go REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(tmms_msgs REQUIRED)

add_executable(quadruped_controller_node
  src/quadruped_controller_node.cpp
  src/quadruped_controller.cpp
  src/common/ros2_sport_client.cpp
  src/common/motor_crc.cpp)

target_include_directories(quadruped_controller_node PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include/common>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)

target_compile_features(quadruped_controller_node PUBLIC c_std_99 cxx_std_17)

ament_target_dependencies(quadruped_controller_node
  rclcpp geometry_msgs sensor_msgs unitree_api unitree_go tmms_msgs)

install(TARGETS quadruped_controller_node
  DESTINATION lib/${PROJECT_NAME})

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  set(ament_cmake_copyright_FOUND TRUE)
  set(ament_cmake_cpplint_FOUND TRUE)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
