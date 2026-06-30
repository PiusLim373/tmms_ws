#include "z1_robot_controller/z1_robot_controller.hpp"

using namespace std::chrono_literals;

Z1RobotController::Z1RobotController()
: Node("z1_robot_controller"),
  arm_(true)
{
  arm_.sendRecvThread->start();
  arm_.startTrack(UNITREE_ARM::ArmFSMState::CARTESIAN);

  gripper_tau_pub_ = create_publisher<std_msgs::msg::Float32>("/haptic/palm", 10);

  consolidated_pub_ = create_publisher<geometry_msgs::msg::Twist>(
    "/consolidated_z1_cmd_vel", 10);

  spacenav_joy_sub_ = create_subscription<sensor_msgs::msg::Joy>(
    "/spacenav/joy", 10,
    std::bind(&Z1RobotController::joyCallback, this, std::placeholders::_1));

  z1_joy_ui_sub_ = create_subscription<sensor_msgs::msg::Joy>(
    "/z1_joy_ui", 10,
    std::bind(&Z1RobotController::joyUiCallback, this, std::placeholders::_1));

  arm_preset_srv_ = create_service<tmms_msgs::srv::StringTrigger>(
    "~/arm_preset",
    std::bind(&Z1RobotController::armPresetCallback, this,
      std::placeholders::_1, std::placeholders::_2));

  gripper_tau_timer_ = create_wall_timer(
    100ms, std::bind(&Z1RobotController::publishGripperTau, this));

  arm_timer_ = create_wall_timer(
    10ms, std::bind(&Z1RobotController::armTimerCallback, this));

  RCLCPP_INFO(get_logger(), "Z1 Robot Controller node started");
}

Z1RobotController::~Z1RobotController()
{
  arm_.sendRecvThread->shutdown();
}

void Z1RobotController::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg)
{
  std::lock_guard<std::mutex> lock(joy_mutex_);
  spacenav_joy_ = *msg;
  bool has_activity = false;
  for (auto v : msg->axes)    if (std::abs(v) > 0.001) { has_activity = true; break; }
  if (!has_activity)
    for (auto b : msg->buttons) if (b) { has_activity = true; break; }
  if (has_activity) last_spacenav_time_ = this->now();
}

void Z1RobotController::joyUiCallback(const sensor_msgs::msg::Joy::SharedPtr msg)
{
  std::lock_guard<std::mutex> lock(joy_mutex_);
  ui_joy_ = *msg;
}

void Z1RobotController::armTimerCallback()
{
  geometry_msgs::msg::Twist twist;
  double gripper_local, gripper_vel_local;

  {
    std::lock_guard<std::mutex> lock(joy_mutex_);
    bool spacenav_active = (this->now() - last_spacenav_time_).seconds() < 2.0;
    const auto & joy = spacenav_active ? spacenav_joy_ : ui_joy_;

    if (joy.axes.size() >= 6) {
      twist.linear.x  = joy.axes[0];
      twist.linear.y  = joy.axes[1];
      twist.linear.z  = joy.axes[2];
      twist.angular.x = joy.axes[3];
      twist.angular.y = joy.axes[4];
      twist.angular.z = joy.axes[5];
    }

    bool btn0 = joy.buttons.size() > 0 && joy.buttons[0] == 1;
    bool btn1 = joy.buttons.size() > 1 && joy.buttons[1] == 1;
    if (btn0 && !btn1 && gripper_ < 0.0) {
      gripper_ += 0.01;    // btn0 alone → close (toward 0.0)
      gripper_vel_ = 0.1;
    } else if (!btn0 && btn1 && gripper_ > -1.0) {
      gripper_ -= 0.01;    // btn1 alone → open (toward -1.0)
      gripper_vel_ = 0.1;
    } else {
      gripper_vel_ = 0.0;  // both, neither → stop
    }
    gripper_local = gripper_;
    gripper_vel_local = gripper_vel_;
  }

  if (pause_arm_) {
    consolidated_pub_->publish(geometry_msgs::msg::Twist{});
    return;
  }

  Vec7 directions;
  directions << twist.angular.x, twist.angular.y, twist.angular.z,
                twist.linear.x,  twist.linear.y,  twist.linear.z, 0.0;
  arm_.cartesianCtrlCmd(directions, 1.2, 1.2);
  arm_.setGripperCmd(gripper_local, gripper_vel_local, 0);

  consolidated_pub_->publish(twist);
}

void Z1RobotController::armPresetCallback(
  const tmms_msgs::srv::StringTrigger::Request::SharedPtr req,
  tmms_msgs::srv::StringTrigger::Response::SharedPtr res)
{
  const std::string & label = req->data;

  pause_arm_ = true;

  if (label == "home") {
    arm_.labelRun("startFlat");
    arm_.startTrack(UNITREE_ARM::ArmFSMState::CARTESIAN);
    RCLCPP_INFO(get_logger(), "Going to home");
  } else if (label == "forward") {
    arm_.labelRun("forward");
    arm_.startTrack(UNITREE_ARM::ArmFSMState::CARTESIAN);
    RCLCPP_INFO(get_logger(), "Going to forward position");
  } else if (label == "back") {
    arm_.labelRun("back");
    arm_.startTrack(UNITREE_ARM::ArmFSMState::CARTESIAN);
    RCLCPP_INFO(get_logger(), "Going to back position");
  } else if (label == "discharge") {
    arm_.labelRun("forward");
    arm_.labelRun("back");
    arm_.labelRun("discharge");
    arm_.startTrack(UNITREE_ARM::ArmFSMState::CARTESIAN);
    RCLCPP_INFO(get_logger(), "Going to discharge position");
  } else if (label == "down") {
    arm_.labelRun("back");
    arm_.labelRun("forward");
    arm_.labelRun("down");
    arm_.startTrack(UNITREE_ARM::ArmFSMState::CARTESIAN);
    RCLCPP_INFO(get_logger(), "Going to down position");
  } else if (label == "test") {
    arm_.labelRun("test");
    arm_.startTrack(UNITREE_ARM::ArmFSMState::CARTESIAN);
    RCLCPP_INFO(get_logger(), "Going to test position");
  } else {
    pause_arm_ = false;
    res->success = false;
    res->message = "Unknown preset: " + label;
    RCLCPP_WARN(get_logger(), "Unknown arm preset requested: %s", label.c_str());
    return;
  }

  pause_arm_ = false;
  res->success = true;
  res->message = "Moved to preset: " + label;
}

void Z1RobotController::publishGripperTau()
{
  std_msgs::msg::Float32 msg;
  msg.data = static_cast<float>(arm_.lowstate->getGripperTau());
  gripper_tau_pub_->publish(msg);
}
