cmake_minimum_required(VERSION 3.8)
project(z1_robot_controller)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(tmms_msgs REQUIRED)
find_package(Eigen3 REQUIRED)

add_executable(z1_robot_controller_node
  src/z1_robot_controller_node.cpp
  src/z1_robot_controller.cpp)
target_include_directories(z1_robot_controller_node PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>
  ${EIGEN3_INCLUDE_DIRS})
target_compile_features(z1_robot_controller_node PUBLIC c_std_99 cxx_std_17)
ament_target_dependencies(z1_robot_controller_node
  rclcpp geometry_msgs sensor_msgs std_msgs tmms_msgs)

if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
  set(Z1_SDK_ARCH "aarch64")
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|amd64")
  set(Z1_SDK_ARCH "x86_64")
else()
  message(FATAL_ERROR "z1_robot_controller: no Z1 SDK build for CMAKE_SYSTEM_PROCESSOR '${CMAKE_SYSTEM_PROCESSOR}'")
endif()

target_link_libraries(z1_robot_controller_node
  ${CMAKE_CURRENT_SOURCE_DIR}/lib/libZ1_SDK_${Z1_SDK_ARCH}.so)
set_target_properties(z1_robot_controller_node PROPERTIES
  # BUILD_WITH_INSTALL_RPATH TRUE
  # INSTALL_RPATH "${CMAKE_CURRENT_SOURCE_DIR}/lib")
  INSTALL_RPATH "$ORIGIN/../../share/${PROJECT_NAME}/lib"
  INSTALL_RPATH_USE_LINK_PATH TRUE)

install(TARGETS z1_robot_controller_node
  DESTINATION lib/${PROJECT_NAME})

install(DIRECTORY launch config bin lib
  DESTINATION share/${PROJECT_NAME}
  USE_SOURCE_PERMISSIONS)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  # the following line skips the linter which checks for copyrights
  # comment the line when a copyright and license is added to all source files
  set(ament_cmake_copyright_FOUND TRUE)
  # the following line skips cpplint (only works in a git repo)
  # comment the line when this package is in a git repo and when
  # a copyright and license is added to all source files
  set(ament_cmake_cpplint_FOUND TRUE)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
