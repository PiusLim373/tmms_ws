#ifndef QUADRUPED_CONTROLLER__QUADRUPED_CONTROLLER_HPP_
#define QUADRUPED_CONTROLLER__QUADRUPED_CONTROLLER_HPP_

#include <mutex>
#include <string>

#include "rclcpp/rclcpp.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "unitree_api/msg/request.hpp"
#include "unitree_go/msg/sport_mode_state.hpp"
#include "unitree_go/msg/low_state.hpp"
#include "tmms_msgs/srv/string_trigger.hpp"
#include "tmms_msgs/msg/quadruped_main_status.hpp"

#include "ros2_b2_sport_client.h"

class QuadrupedController : public rclcpp::Node
{
public:
  QuadrupedController();
  ~QuadrupedController() = default;

private:
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void cmdVelUiCallback(const geometry_msgs::msg::Twist::SharedPtr msg);
  void sportStateCallback(const unitree_go::msg::SportModeState::SharedPtr msg);
  void lowStateCallback(const unitree_go::msg::LowState::SharedPtr msg);
  void moveTimerCallback();
  void mainStatusTimerCallback();
  void quadrupedCmdCallback(
    const tmms_msgs::srv::StringTrigger::Request::SharedPtr req,
    tmms_msgs::srv::StringTrigger::Response::SharedPtr res);

  bool executeCmd(const std::string & cmd, std::string & message);
  std::string modeToString(uint8_t mode) const;

  SportClient sport_req_;
  unitree_api::msg::Request req_;

  // All protected by vel_mutex_
  int sit_btn_{0};
  int standlock_btn_{0};
  int standmove_btn_{0};
  int prev_sit_btn_{0};
  int prev_standlock_btn_{0};
  int prev_standmove_btn_{0};
  geometry_msgs::msg::Twist joy_twist_;
  geometry_msgs::msg::Twist ui_twist_;
  rclcpp::Time last_joy_time_{0, 0, RCL_ROS_TIME};
  rclcpp::Time last_ui_time_{0, 0, RCL_ROS_TIME};
  std::mutex vel_mutex_;

  uint8_t mode_{0};
  uint8_t battery_soc_{0};
  geometry_msgs::msg::Pose pose_;

  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr quadruped_cmd_vel_ui_sub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr consolidated_pub_;
  rclcpp::Subscription<unitree_go::msg::SportModeState>::SharedPtr sport_state_sub_;
  rclcpp::Subscription<unitree_go::msg::LowState>::SharedPtr low_state_sub_;
  rclcpp::Publisher<tmms_msgs::msg::QuadrupedMainStatus>::SharedPtr main_status_pub_;
  rclcpp::Service<tmms_msgs::srv::StringTrigger>::SharedPtr quadruped_cmd_srv_;
  rclcpp::TimerBase::SharedPtr move_timer_;
  rclcpp::TimerBase::SharedPtr main_status_timer_;
};

#endif  // QUADRUPED_CONTROLLER__QUADRUPED_CONTROLLER_HPP_
