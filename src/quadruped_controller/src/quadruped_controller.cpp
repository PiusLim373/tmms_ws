#include "quadruped_controller/quadruped_controller.hpp"

using namespace std::chrono_literals;

QuadrupedController::QuadrupedController()
: Node("quadruped_controller"),
  sport_req_(this)
{
  joy_sub_ = create_subscription<sensor_msgs::msg::Joy>(
    "/joy", 10,
    std::bind(&QuadrupedController::joyCallback, this, std::placeholders::_1));

  quadruped_cmd_vel_ui_sub_ = create_subscription<geometry_msgs::msg::Twist>(
    "/quadruped_cmd_vel_ui", 10,
    std::bind(&QuadrupedController::cmdVelUiCallback, this, std::placeholders::_1));

  consolidated_pub_ = create_publisher<geometry_msgs::msg::Twist>(
    "/consolidated_quadruped_cmd_vel", 10);

  sport_state_sub_ = create_subscription<unitree_go::msg::SportModeState>(
    "lf/sportmodestate", 10,
    std::bind(&QuadrupedController::sportStateCallback, this, std::placeholders::_1));

  quadruped_cmd_srv_ = create_service<tmms_msgs::srv::StringTrigger>(
    "~/quadruped_cmd",
    std::bind(&QuadrupedController::quadrupedCmdCallback, this,
      std::placeholders::_1, std::placeholders::_2));

  move_timer_ = create_wall_timer(
    2ms, std::bind(&QuadrupedController::moveTimerCallback, this));

  RCLCPP_INFO(get_logger(), "Quadruped Controller node started");
}

void QuadrupedController::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg)
{
  std::lock_guard<std::mutex> lock(vel_mutex_);
  joy_twist_.linear.x  =  msg->axes[1];
  joy_twist_.linear.y  =  msg->axes[0];
  joy_twist_.angular.z = -msg->axes[5];
  last_joy_time_ = this->now();
  sit_btn_ = msg->buttons[27];
  standlock_btn_ = msg->buttons[26];
  standmove_btn_ = msg->buttons[28];
}

void QuadrupedController::cmdVelUiCallback(const geometry_msgs::msg::Twist::SharedPtr msg)
{
  std::lock_guard<std::mutex> lock(vel_mutex_);
  ui_twist_ = *msg;
}

void QuadrupedController::sportStateCallback(
  const unitree_go::msg::SportModeState::SharedPtr msg)
{
  mode_ = msg->mode;
}

void QuadrupedController::moveTimerCallback()
{
  float lx, ly, az;
  int sit, standlock, standmove;
  int prev_sit, prev_standlock, prev_standmove;

  {
    std::lock_guard<std::mutex> lock(vel_mutex_);
    bool joy_active = (this->now() - last_joy_time_).seconds() < 0.5;
    const auto & chosen = joy_active ? joy_twist_ : ui_twist_;
    lx = static_cast<float>(chosen.linear.x);
    ly = static_cast<float>(chosen.linear.y);
    az = static_cast<float>(chosen.angular.z);
    sit = sit_btn_;
    standlock = standlock_btn_;
    standmove = standmove_btn_;
    prev_sit = prev_sit_btn_;
    prev_standlock = prev_standlock_btn_;
    prev_standmove = prev_standmove_btn_;
    prev_sit_btn_ = sit_btn_;
    prev_standlock_btn_ = standlock_btn_;
    prev_standmove_btn_ = standmove_btn_;
  }

  sport_req_.Move(req_, lx, ly, az);

  geometry_msgs::msg::Twist consolidated;
  consolidated.linear.x  = lx;
  consolidated.linear.y  = ly;
  consolidated.angular.z = az;
  consolidated_pub_->publish(consolidated);

  std::string msg_out;
  if (sit == 1 && prev_sit == 0) {
    executeCmd("stand_down", msg_out);
  } else if (standlock == 1 && prev_standlock == 0) {
    executeCmd("stand_up", msg_out);
  } else if (standmove == 1 && prev_standmove == 0) {
    executeCmd("balance_stand", msg_out);
  }
}

bool QuadrupedController::executeCmd(const std::string & cmd, std::string & message)
{
  if (cmd == "stand_down") {
    sport_req_.StandDown(req_);
    message = "Standing down";
    RCLCPP_INFO(get_logger(), "Stand down");
  } else if (cmd == "stand_up") {
    sport_req_.StandUp(req_);
    message = "Standing up (joint lock)";
    RCLCPP_INFO(get_logger(), "Stand up");
  } else if (cmd == "balance_stand") {
    sport_req_.BalanceStand(req_);
    message = "Balance stand (locomotion)";
    RCLCPP_INFO(get_logger(), "Balance stand");
  } else if (cmd == "damp") {
    sport_req_.Damp(req_);
    message = "Damp";
    RCLCPP_INFO(get_logger(), "Damp");
  } else if (cmd == "recovery_stand") {
    sport_req_.RecoveryStand(req_);
    message = "Recovery stand";
    RCLCPP_INFO(get_logger(), "Recovery stand");
  } else {
    message = "Unknown command: " + cmd;
    RCLCPP_WARN(get_logger(), "Unknown quadruped command: %s", cmd.c_str());
    return false;
  }
  return true;
}

void QuadrupedController::quadrupedCmdCallback(
  const tmms_msgs::srv::StringTrigger::Request::SharedPtr req,
  tmms_msgs::srv::StringTrigger::Response::SharedPtr res)
{
  res->success = executeCmd(req->data, res->message);
}
