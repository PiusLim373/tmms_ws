#ifndef Z1_ROBOT_CONTROLLER__Z1_ROBOT_CONTROLLER_HPP_
#define Z1_ROBOT_CONTROLLER__Z1_ROBOT_CONTROLLER_HPP_

#include <atomic>
#include <mutex>

#include "rclcpp/rclcpp.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "std_msgs/msg/float32.hpp"
#include "tmms_msgs/srv/string_trigger.hpp"

#include "unitree_arm_sdk/control/unitreeArm.h"

class Z1RobotController : public rclcpp::Node
{
public:
  Z1RobotController();
  ~Z1RobotController();

private:
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void joyUiCallback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void armTimerCallback();
  void armPresetCallback(
    const tmms_msgs::srv::StringTrigger::Request::SharedPtr req,
    tmms_msgs::srv::StringTrigger::Response::SharedPtr res);
  void publishGripperTau();

  UNITREE_ARM::unitreeArm arm_;

  std::atomic<bool> pause_arm_{false};

  // All protected by joy_mutex_
  sensor_msgs::msg::Joy spacenav_joy_{};
  sensor_msgs::msg::Joy ui_joy_{};
  rclcpp::Time last_spacenav_time_{0, 0, RCL_ROS_TIME};
  double gripper_{0.0};
  double gripper_vel_{0.0};
  std::mutex joy_mutex_;

  rclcpp::Publisher<std_msgs::msg::Float32>::SharedPtr gripper_tau_pub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr consolidated_pub_;
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr spacenav_joy_sub_;
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr z1_joy_ui_sub_;
  rclcpp::Service<tmms_msgs::srv::StringTrigger>::SharedPtr arm_preset_srv_;
  rclcpp::TimerBase::SharedPtr gripper_tau_timer_;
  rclcpp::TimerBase::SharedPtr arm_timer_;
};

#endif  // Z1_ROBOT_CONTROLLER__Z1_ROBOT_CONTROLLER_HPP_
