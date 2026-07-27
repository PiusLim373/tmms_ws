#include "quadruped_controller/quadruped_controller.hpp"

#include <array>
#include <cmath>

#include "tf2/LinearMath/Matrix3x3.h"
#include "tf2/LinearMath/Quaternion.h"

using namespace std::chrono_literals;

namespace
{
// Unitree's standard motor_state ordering for the first 12 (leg) actuators,
// matching tmms_description.urdf's joint names.
const std::array<std::string, 12> kJointNames = {
  "FR_hip_joint", "FR_thigh_joint", "FR_calf_joint",
  "FL_hip_joint", "FL_thigh_joint", "FL_calf_joint",
  "RR_hip_joint", "RR_thigh_joint", "RR_calf_joint",
  "RL_hip_joint", "RL_thigh_joint", "RL_calf_joint",
};
}  // namespace

QuadrupedController::QuadrupedController()
: Node("quadruped_controller"),
  sport_req_(this)
{
  tf_broadcaster_ = std::make_unique<tf2_ros::TransformBroadcaster>(*this);

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

  low_state_sub_ = create_subscription<unitree_go::msg::LowState>(
    "lf/lowstate", 10,
    std::bind(&QuadrupedController::lowStateCallback, this, std::placeholders::_1));

  dog_odom_sub_ = create_subscription<nav_msgs::msg::Odometry>(
    "/dog_odom", 10,
    std::bind(&QuadrupedController::dogOdomCallback, this, std::placeholders::_1));

  joint_state_pub_ = create_publisher<sensor_msgs::msg::JointState>(
    "/joint_states", 10);

  main_status_pub_ = create_publisher<tmms_msgs::msg::QuadrupedMainStatus>(
    "quadruped_main_status", 10);

  quadruped_cmd_srv_ = create_service<tmms_msgs::srv::StringTrigger>(
    "~/quadruped_cmd",
    std::bind(&QuadrupedController::quadrupedCmdCallback, this,
      std::placeholders::_1, std::placeholders::_2));

  quadruped_pose_srv_ = create_service<tmms_msgs::srv::PoseTrigger>(
    "~/quadruped_pose",
    std::bind(&QuadrupedController::quadrupedPoseCallback, this,
      std::placeholders::_1, std::placeholders::_2));

  quadruped_height_srv_ = create_service<tmms_msgs::srv::FloatTrigger>(
    "~/quadruped_height",
    std::bind(&QuadrupedController::quadrupedHeightCallback, this,
      std::placeholders::_1, std::placeholders::_2));

  motion_switcher_pub_ = create_publisher<unitree_api::msg::Request>(
    "/api/motion_switcher/request", rclcpp::QoS(10));

  sport_request_raw_pub_ = create_publisher<unitree_api::msg::Request>(
    "/api/sport/request", rclcpp::QoS(10));

  move_timer_ = create_wall_timer(
    2ms, std::bind(&QuadrupedController::moveTimerCallback, this));

  // Euler needs to be refreshed at >=2Hz on hardware to hold the commanded
  // attitude, or the robot reverts to default; 10Hz gives comfortable margin.
  pose_timer_ = create_wall_timer(
    250ms, std::bind(&QuadrupedController::poseTimerCallback, this));

  main_status_timer_ = create_wall_timer(
    200ms, std::bind(&QuadrupedController::mainStatusTimerCallback, this));

  RCLCPP_INFO(get_logger(), "Quadruped Controller node started");
}

bool QuadrupedController::isJoyInputZero(const sensor_msgs::msg::Joy::SharedPtr & msg) const
{
  constexpr float kEpsilon = 0.01f;
  bool axes_zero = std::abs(msg->axes[0]) < kEpsilon &&
                    std::abs(msg->axes[1]) < kEpsilon &&
                    std::abs(msg->axes[5]) < kEpsilon;
  bool buttons_zero = msg->buttons[26] == 0 &&
                       msg->buttons[27] == 0 &&
                       msg->buttons[28] == 0;
  return axes_zero && buttons_zero;
}

void QuadrupedController::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg)
{
  std::lock_guard<std::mutex> lock(vel_mutex_);
  bool is_zero = isJoyInputZero(msg);
  if (is_zero && prev_joy_zero_) {
    // Idle joy still publishing zero at a high rate (browser gamepad driver) —
    // skip so last_joy_time_ ages out and moveTimerCallback stops re-sending
    // Move(0,0,0), instead of stomping in place indefinitely.
    return;
  }
  prev_joy_zero_ = is_zero;

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
  last_ui_time_ = this->now();
}

void QuadrupedController::sportStateCallback(
  const unitree_go::msg::SportModeState::SharedPtr msg)
{
  mode_ = msg->mode;

  pose_.position.x = msg->position[0];
  pose_.position.y = msg->position[1];
  pose_.position.z = msg->position[2];

  // Unitree packs imu_state.quaternion as [w, x, y, z]; geometry_msgs/Quaternion
  // fields are named x, y, z, w, so map explicitly rather than by array order.
  pose_.orientation.w = msg->imu_state.quaternion[0];
  pose_.orientation.x = msg->imu_state.quaternion[1];
  pose_.orientation.y = msg->imu_state.quaternion[2];
  pose_.orientation.z = msg->imu_state.quaternion[3];

  // base_footprint -> base_link carries only the body's height/tilt above the
  // flat ground plane; base_footprint's own planar pose comes from /dog_odom
  // (see dogOdomCallback), so yaw is intentionally dropped here.
  tf2::Quaternion body_q(
    msg->imu_state.quaternion[1], msg->imu_state.quaternion[2],
    msg->imu_state.quaternion[3], msg->imu_state.quaternion[0]);
  double roll, pitch, yaw;
  tf2::Matrix3x3(body_q).getRPY(roll, pitch, yaw);

  tf2::Quaternion tilt_q;
  tilt_q.setRPY(roll, pitch, 0.0);

  geometry_msgs::msg::TransformStamped t;
  t.header.stamp = this->now();
  t.header.frame_id = "base_footprint";
  t.child_frame_id = "base_link";
  t.transform.translation.x = 0.0;
  t.transform.translation.y = 0.0;
  t.transform.translation.z = msg->body_height;
  t.transform.rotation.x = tilt_q.x();
  t.transform.rotation.y = tilt_q.y();
  t.transform.rotation.z = tilt_q.z();
  t.transform.rotation.w = tilt_q.w();
  tf_broadcaster_->sendTransform(t);
}

void QuadrupedController::lowStateCallback(
  const unitree_go::msg::LowState::SharedPtr msg)
{
  battery_soc_ = msg->bms_state.soc;

  sensor_msgs::msg::JointState joint_state;
  joint_state.header.stamp = this->now();
  joint_state.name.assign(kJointNames.begin(), kJointNames.end());
  joint_state.position.resize(kJointNames.size());
  joint_state.velocity.resize(kJointNames.size());
  joint_state.effort.resize(kJointNames.size());
  for (size_t i = 0; i < kJointNames.size(); ++i) {
    joint_state.position[i] = msg->motor_state[i].q;
    joint_state.velocity[i] = msg->motor_state[i].dq;
    joint_state.effort[i] = msg->motor_state[i].tau_est;
  }
  joint_state_pub_->publish(joint_state);
}

void QuadrupedController::dogOdomCallback(
  const nav_msgs::msg::Odometry::SharedPtr msg)
{
  // odom -> base_footprint carries only the planar (x, y, yaw) pose; height
  // and tilt are applied separately in base_footprint -> base_link (see
  // sportStateCallback), keeping base_footprint flat for Nav2/RTAB-Map.
  tf2::Quaternion odom_q(
    msg->pose.pose.orientation.x, msg->pose.pose.orientation.y,
    msg->pose.pose.orientation.z, msg->pose.pose.orientation.w);
  double roll, pitch, yaw;
  tf2::Matrix3x3(odom_q).getRPY(roll, pitch, yaw);

  tf2::Quaternion yaw_q;
  yaw_q.setRPY(0.0, 0.0, yaw);

  geometry_msgs::msg::TransformStamped t;
  t.header.stamp = msg->header.stamp;
  t.header.frame_id = "odom";
  t.child_frame_id = "base_footprint";
  t.transform.translation.x = msg->pose.pose.position.x;
  t.transform.translation.y = msg->pose.pose.position.y;
  t.transform.translation.z = 0.0;
  t.transform.rotation.x = yaw_q.x();
  t.transform.rotation.y = yaw_q.y();
  t.transform.rotation.z = yaw_q.z();
  t.transform.rotation.w = yaw_q.w();
  tf_broadcaster_->sendTransform(t);
}

void QuadrupedController::mainStatusTimerCallback()
{
  tmms_msgs::msg::QuadrupedMainStatus status;
  status.pose = pose_;
  status.battery_percentage = battery_soc_;
  status.robot_mode = modeToString(mode_);
  main_status_pub_->publish(status);
}

std::string QuadrupedController::modeToString(uint8_t mode) const
{
  using Status = tmms_msgs::msg::QuadrupedMainStatus;
  switch (mode) {
    case 0: return Status::ROBOT_IDLE;
    case 1: return Status::BALANCE_STAND;
    case 2: return Status::POSE;
    case 3: return Status::LOCOMOTION;
    case 5: return Status::LIE_DOWN;
    case 6: return Status::JOINT_LOCK;
    case 7: return Status::DAMPING;
    case 8: return Status::RECOVERY_STAND;
    case 10: return Status::SIT;
    case 11: return Status::FRONT_FLIP;
    case 12: return Status::FRONT_JUMP;
    case 13: return Status::FRONT_POUNCE;
    default: return "";
  }
}

void QuadrupedController::moveTimerCallback()
{
  float lx, ly, az;
  int sit, standlock, standmove;
  int prev_sit, prev_standlock, prev_standmove;
  ControlMode mode;
  bool publish_move;

  {
    std::lock_guard<std::mutex> lock(vel_mutex_);
    auto now = this->now();
    bool joy_fresh = (now - last_joy_time_).seconds() < 0.5;
    bool ui_fresh = (now - last_ui_time_).seconds() < 1.0;
    bool input_fresh = joy_fresh || ui_fresh;
    static const geometry_msgs::msg::Twist kZeroTwist{};
    const auto & chosen = joy_fresh ? joy_twist_ : (ui_fresh ? ui_twist_ : kZeroTwist);
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
    mode = control_mode_;
    // Publish while input is fresh, plus exactly one more tick on the falling
    // edge (to send a final Move(0,0,0)) — then stay silent instead of
    // spamming Move(0,0,0) at 500Hz indefinitely once input goes stale.
    publish_move = input_fresh || input_was_fresh_;
    input_was_fresh_ = input_fresh;
  }

  if (mode == ControlMode::kMove && publish_move) {
    unitree_api::msg::Request req;
    sport_req_.Move(req, lx, ly, az);

    geometry_msgs::msg::Twist consolidated;
    consolidated.linear.x  = lx;
    consolidated.linear.y  = ly;
    consolidated.angular.z = az;
    consolidated_pub_->publish(consolidated);
  }

  std::string msg_out;
  if (sit == 1 && prev_sit == 0) {
    executeCmd("stand_down", msg_out);
  } else if (standlock == 1 && prev_standlock == 0) {
    executeCmd("stand_up", msg_out);
  } else if (standmove == 1 && prev_standmove == 0) {
    executeCmd("balance_stand", msg_out);
  }
}

void QuadrupedController::poseTimerCallback()
{
  ControlMode mode;
  float roll, pitch, yaw;

  {
    std::lock_guard<std::mutex> lock(vel_mutex_);
    mode = control_mode_;
    roll = pose_roll_;
    pitch = pose_pitch_;
    yaw = pose_yaw_;
  }

  if (mode == ControlMode::kPose) {
    unitree_api::msg::Request req;
    sport_req_.Euler(req, roll, pitch, yaw);
  }
}

void QuadrupedController::publishBodyHeight(float height)
{
  // ROBOT_SPORT_API_ID_BODYHEIGHT: B2-only, not defined in ros2_sport_client.h.
  constexpr int32_t kBodyHeightApiId = 1013;
  unitree_api::msg::Request req;
  req.header.identity.api_id = kBodyHeightApiId;
  req.parameter = nlohmann::json{{"data", height}}.dump();
  sport_request_raw_pub_->publish(req);
}

void QuadrupedController::deactivatePose()
{
  unitree_api::msg::Request req;
  sport_req_.Euler(req, 0.0f, 0.0f, 0.0f);
  std::lock_guard<std::mutex> lock(vel_mutex_);
  control_mode_ = ControlMode::kMove;
}

bool QuadrupedController::executeCmd(const std::string & cmd, std::string & message)
{
  unitree_api::msg::Request req;
  if (cmd == "stand_down") {
    sport_req_.StandDown(req);
    publishBodyHeight(0.0f);
    deactivatePose();
    message = "Standing down";
    RCLCPP_INFO(get_logger(), "Stand down");
  } else if (cmd == "stand_up") {
    sport_req_.StandUp(req);
    publishBodyHeight(0.0f);
    deactivatePose();
    message = "Standing up (joint lock)";
    RCLCPP_INFO(get_logger(), "Stand up");
  } else if (cmd == "balance_stand") {
    bool skip_motion_switcher_call;
    {
      std::lock_guard<std::mutex> lock(vel_mutex_);
      skip_motion_switcher_call =
        (control_mode_ == ControlMode::kPose) || (last_cmd_ == "balance_stand");
    }

    publishBodyHeight(0.0f);
    deactivatePose();

    if (skip_motion_switcher_call) {
      // Either resuming from bend_down (which never left "normal"/BalanceStand
      // motion-switcher mode, it just overlaid an Euler pose on top of it) or
      // already in balance_stand (e.g. a redundant click after a UI refresh) —
      // re-selecting "normal" + BalanceStand here re-triggers ~10s of internal
      // recovery checks that block cmd_vel the whole time, so skip it.
      message = "Balance stand (already active or resumed from bend down)";
      RCLCPP_INFO(
        get_logger(),
        "Balance stand, skipped mode re-select (already balance_stand or resumed from bend down)");
    } else {
      unitree_api::msg::Request select_mode_req;
      select_mode_req.header.identity.api_id =
        unitree::robot::b2::MOTION_SWITCHER_API_ID_SELECT_MODE;
      select_mode_req.parameter = nlohmann::json{{"name", "normal"}}.dump();
      motion_switcher_pub_->publish(select_mode_req);
      sport_req_.BalanceStand(req);
      message = "Balance stand (locomotion), motion switched to normal mode";
      RCLCPP_INFO(get_logger(), "Balance stand, motion switched to normal mode");
    }
  } else if (cmd == "damp") {
    sport_req_.Damp(req);
    publishBodyHeight(0.0f);
    deactivatePose();
    message = "Damp";
    RCLCPP_INFO(get_logger(), "Damp");
  } else if (cmd == "recovery_stand") {
    sport_req_.RecoveryStand(req);
    publishBodyHeight(0.0f);
    deactivatePose();
    message = "Recovery stand";
    RCLCPP_INFO(get_logger(), "Recovery stand");
  } else if (cmd == "bend_down") {
    publishBodyHeight(-0.15f);
    {
      std::lock_guard<std::mutex> lock(vel_mutex_);
      pose_roll_ = 0.0f;
      pose_pitch_ = 0.35f;
      pose_yaw_ = 0.0f;
      control_mode_ = ControlMode::kPose;
    }
    message = "Bend down (pitch 0.35 rad, height -0.15 m)";
    RCLCPP_INFO(get_logger(), "Bend down (pitch 0.35 rad, height -0.15 m)");
  } else {
    message = "Unknown command: " + cmd;
    RCLCPP_WARN(get_logger(), "Unknown quadruped command: %s", cmd.c_str());
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(vel_mutex_);
    last_cmd_ = cmd;
  }
  return true;
}

void QuadrupedController::quadrupedCmdCallback(
  const tmms_msgs::srv::StringTrigger::Request::SharedPtr req,
  tmms_msgs::srv::StringTrigger::Response::SharedPtr res)
{
  res->success = executeCmd(req->data, res->message);
}

void QuadrupedController::quadrupedPoseCallback(
  const tmms_msgs::srv::PoseTrigger::Request::SharedPtr req,
  tmms_msgs::srv::PoseTrigger::Response::SharedPtr res)
{
  if (req->activate) {
    {
      std::lock_guard<std::mutex> lock(vel_mutex_);
      pose_roll_ = static_cast<float>(req->roll);
      pose_pitch_ = static_cast<float>(req->pitch);
      pose_yaw_ = static_cast<float>(req->yaw);
      control_mode_ = ControlMode::kPose;
    }
    res->message = "Pose activated";
    RCLCPP_INFO(
      get_logger(), "Pose activated: roll=%.3f pitch=%.3f yaw=%.3f",
      req->roll, req->pitch, req->yaw);
  } else {
    deactivatePose();
    res->message = "Pose deactivated, returning to neutral";
    RCLCPP_INFO(get_logger(), "Pose deactivated, returning to neutral");
  }
  res->success = true;
}

void QuadrupedController::quadrupedHeightCallback(
  const tmms_msgs::srv::FloatTrigger::Request::SharedPtr req,
  tmms_msgs::srv::FloatTrigger::Response::SharedPtr res)
{
  publishBodyHeight(static_cast<float>(req->data));
  res->success = true;
  res->message = "Body height set to " + std::to_string(req->data) + " m";
  RCLCPP_INFO(get_logger(), "Body height set to %.3f m", req->data);
}
