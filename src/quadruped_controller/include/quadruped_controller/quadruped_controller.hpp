#ifndef QUADRUPED_CONTROLLER__QUADRUPED_CONTROLLER_HPP_
#define QUADRUPED_CONTROLLER__QUADRUPED_CONTROLLER_HPP_

#include <memory>
#include <mutex>
#include <string>

#include "rclcpp/rclcpp.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "geometry_msgs/msg/transform_stamped.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "sensor_msgs/msg/joint_state.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "std_msgs/msg/string.hpp"
#include "std_srvs/srv/set_bool.hpp"
#include "unitree_api/msg/request.hpp"
#include "unitree_go/msg/sport_mode_state.hpp"
#include "unitree_go/msg/low_state.hpp"
#include "tmms_msgs/srv/string_trigger.hpp"
#include "tmms_msgs/srv/pose_trigger.hpp"
#include "tmms_msgs/srv/float_trigger.hpp"
#include "tmms_msgs/msg/quadruped_main_status.hpp"
#include "tf2_ros/transform_broadcaster.h"

#include "ros2_sport_client.h"
#include "b2/b2_motion_switch_client.hpp"

class QuadrupedController : public rclcpp::Node
{
public:
  QuadrupedController();
  ~QuadrupedController() = default;

private:
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void cmdVelUiCallback(const geometry_msgs::msg::Twist::SharedPtr msg);
  void cmdVelNavCallback(const geometry_msgs::msg::Twist::SharedPtr msg);
  void yasminStateCallback(const std_msgs::msg::String::SharedPtr msg);
  void localizationStatusCallback(const std_msgs::msg::String::SharedPtr msg);
  void currentMapCallback(const std_msgs::msg::String::SharedPtr msg);
  void sportStateCallback(const unitree_go::msg::SportModeState::SharedPtr msg);
  void lowStateCallback(const unitree_go::msg::LowState::SharedPtr msg);
  void dogOdomCallback(const nav_msgs::msg::Odometry::SharedPtr msg);
  void moveTimerCallback();
  void poseTimerCallback();
  void mainStatusTimerCallback();
  void quadrupedCmdCallback(
    const tmms_msgs::srv::StringTrigger::Request::SharedPtr req,
    tmms_msgs::srv::StringTrigger::Response::SharedPtr res);
  void quadrupedPoseCallback(
    const tmms_msgs::srv::PoseTrigger::Request::SharedPtr req,
    tmms_msgs::srv::PoseTrigger::Response::SharedPtr res);
  void quadrupedHeightCallback(
    const tmms_msgs::srv::FloatTrigger::Request::SharedPtr req,
    tmms_msgs::srv::FloatTrigger::Response::SharedPtr res);
  void quadrupedPauseCallback(
    const std_srvs::srv::SetBool::Request::SharedPtr req,
    std_srvs::srv::SetBool::Response::SharedPtr res);

  bool executeCmd(const std::string & cmd, std::string & message);
  // True while the operator owns the robot. Every teleop surface is refused when
  // unpaused, so callers can bail out early with a consistent message.
  bool isPaused();
  bool rejectUnlessPaused(std::string & message);
  // Zeroes the three input timestamps so no cached command survives a mode switch.
  // Caller must hold vel_mutex_.
  void staleAllInputsLocked();
  std::string modeToString(uint8_t mode) const;
  void publishBodyHeight(float height);
  void deactivatePose();
  bool isJoyInputZero(const sensor_msgs::msg::Joy::SharedPtr & msg) const;

  SportClient sport_req_;

  enum class ControlMode { kMove, kPose };

  // All protected by vel_mutex_
  int sit_btn_{0};
  int standlock_btn_{0};
  int standmove_btn_{0};
  int prev_sit_btn_{0};
  int prev_standlock_btn_{0};
  int prev_standmove_btn_{0};
  geometry_msgs::msg::Twist joy_twist_;
  geometry_msgs::msg::Twist ui_twist_;
  geometry_msgs::msg::Twist nav_twist_;
  rclcpp::Time last_joy_time_{0, 0, RCL_ROS_TIME};
  rclcpp::Time last_ui_time_{0, 0, RCL_ROS_TIME};
  rclcpp::Time last_nav_time_{0, 0, RCL_ROS_TIME};
  // Starts paused: the nav stack is not wired up yet, so the robot has to be
  // teleoperable the moment it boots.
  bool paused_{true};
  // Last value seen on /yasmin_state. Nothing publishes it yet, so this stays at
  // UNLOCALIZED and that is what navigation_state falls back to on unpause.
  std::string yasmin_state_{tmms_msgs::msg::QuadrupedMainStatus::UNLOCALIZED};
  // Mirrored straight from localization_manager's /localization_status. Unlike
  // yasmin_state_ this is NOT overlaid by paused_ -- pause and localization are
  // independent, and the UI wants to show "paused AND localized".
  std::string localization_status_{tmms_msgs::msg::QuadrupedMainStatus::NOT_STARTED};
  // Empty until localization_manager reports a successfully loaded map.
  std::string current_map_;
  ControlMode control_mode_{ControlMode::kMove};
  bool input_was_fresh_{false};
  bool prev_joy_zero_{true};
  std::string last_cmd_;
  float pose_roll_{0.0f};
  float pose_pitch_{0.0f};
  float pose_yaw_{0.0f};
  std::mutex vel_mutex_;

  uint8_t mode_{0};
  uint8_t battery_soc_{0};
  geometry_msgs::msg::Pose pose_;

  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr quadruped_cmd_vel_ui_sub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_nav_sub_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr yasmin_state_sub_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr localization_status_sub_;
  rclcpp::Subscription<std_msgs::msg::String>::SharedPtr current_map_sub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr consolidated_pub_;
  rclcpp::Subscription<unitree_go::msg::SportModeState>::SharedPtr sport_state_sub_;
  rclcpp::Subscription<unitree_go::msg::LowState>::SharedPtr low_state_sub_;
  rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr dog_odom_sub_;
  rclcpp::Publisher<sensor_msgs::msg::JointState>::SharedPtr joint_state_pub_;
  rclcpp::Publisher<tmms_msgs::msg::QuadrupedMainStatus>::SharedPtr main_status_pub_;
  rclcpp::Service<tmms_msgs::srv::StringTrigger>::SharedPtr quadruped_cmd_srv_;
  rclcpp::Service<tmms_msgs::srv::PoseTrigger>::SharedPtr quadruped_pose_srv_;
  rclcpp::Service<tmms_msgs::srv::FloatTrigger>::SharedPtr quadruped_height_srv_;
  rclcpp::Service<std_srvs::srv::SetBool>::SharedPtr quadruped_pause_srv_;
  rclcpp::Publisher<unitree_api::msg::Request>::SharedPtr motion_switcher_pub_;
  rclcpp::Publisher<unitree_api::msg::Request>::SharedPtr sport_request_raw_pub_;
  rclcpp::TimerBase::SharedPtr move_timer_;
  rclcpp::TimerBase::SharedPtr pose_timer_;
  rclcpp::TimerBase::SharedPtr main_status_timer_;

  std::unique_ptr<tf2_ros::TransformBroadcaster> tf_broadcaster_;
};

#endif  // QUADRUPED_CONTROLLER__QUADRUPED_CONTROLLER_HPP_
