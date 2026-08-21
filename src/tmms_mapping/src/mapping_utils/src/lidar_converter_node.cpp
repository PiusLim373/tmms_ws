// Converts a RoboSense (rslidar_sdk) XYZIRT PointCloud2 into the Velodyne XYZIRT layout
// that FAST-LIO's VELO16 path (preprocess.cpp:velodyne_handler) consumes. FAST-LIVO2 uses
// the same layout for lidar_type 2, so one converter feeds both mappers.
//
// Input  /rslidar_points           (RoboSense layout, scan-END header stamp)
// Output /converted_rslidar_points (Velodyne layout, scan-START header stamp)
//
// Beyond renaming fields, two things have to be fixed for this sensor:
//   1. RoboSense `timestamp` is an ABSOLUTE epoch double; Velodyne `time` is a float32
//      offset relative to the start of the scan.
//   2. RoboSense stamps the message header with the scan END time, but FAST-LIO treats
//      header.stamp as lidar_beg_time (laserMapping.cpp:406 computes
//      lidar_end_time = header + points.back().curvature/1000). Left alone this is a
//      systematic ~100 ms LiDAR-vs-IMU offset. We rewrite header.stamp to the first
//      point's absolute time instead.
//
// Derived from the ROS 2 port of HViktorTsoi/rs_to_velodyne. The upstream XYZI input mode
// and the XYZIR/XYZI output modes are dropped: rsHandler_XYZI branches on height==16/128 to
// pick a ring remap table, but this sensor publishes height=1800, so neither branch fires
// and `ring` was never assigned. FAST-LIO needs both `time` and `ring`, so those modes are
// dead and wrong here.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <utility>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>

#include <pcl/point_cloud.h>
#include <pcl/point_types.h>
#include <pcl/common/point_tests.h>  // pcl::isFinite -- pcl_isnan was removed in PCL 1.11
#include <pcl_conversions/pcl_conversions.h>

namespace lidar_converter
{

// RoboSense RS-32 / rslidar_sdk output, verified against the tmms bags:
//   x f32@0  y f32@4  z f32@8  intensity FLOAT32@12  ring UINT16@16  timestamp FLOAT64@18
//
// NOTE: upstream declares `uint8_t intensity`. pcl::detail::FieldMatches compares name AND
// datatype AND count; a mismatch is NOT an error -- PCL only warns and leaves the member
// zero. With uint8_t you silently get an all-zero intensity channel.
struct EIGEN_ALIGN16 RsPointXYZIRT
{
  PCL_ADD_POINT4D;
  float intensity;
  std::uint16_t ring;
  double timestamp;
  EIGEN_MAKE_ALIGNED_OPERATOR_NEW
};

// Byte-identical to velodyne_ros::Point in FAST_LIO/src/preprocess.h:70-84
// (point_step 32; x@0 y@4 z@8 intensity@16 time@20 ring@24).
struct EIGEN_ALIGN16 VelodynePointXYZIRT
{
  PCL_ADD_POINT4D;
  float intensity;
  float time;
  std::uint16_t ring;
  EIGEN_MAKE_ALIGNED_OPERATOR_NEW
};

}  // namespace lidar_converter

POINT_CLOUD_REGISTER_POINT_STRUCT(lidar_converter::RsPointXYZIRT,
                                  (float, x, x)(float, y, y)(float, z, z)
                                  (float, intensity, intensity)
                                  (std::uint16_t, ring, ring)
                                  (double, timestamp, timestamp))

POINT_CLOUD_REGISTER_POINT_STRUCT(lidar_converter::VelodynePointXYZIRT,
                                  (float, x, x)(float, y, y)(float, z, z)
                                  (float, intensity, intensity)
                                  (float, time, time)
                                  (std::uint16_t, ring, ring))

namespace lidar_converter
{

class LidarConverterNode : public rclcpp::Node
{
public:
  LidarConverterNode()
  : rclcpp::Node("lidar_converter")
  {
    input_topic_ = declare_parameter<std::string>("input_topic", "/rslidar_points");
    output_topic_ = declare_parameter<std::string>("output_topic", "/converted_rslidar_points");
    // The real URDF link (tmms_description.urdf.xacro:22), so the converted cloud renders
    // against the live TF tree in Lichtblick. Neither mapper reads the input frame_id.
    output_frame_ = declare_parameter<std::string>("output_frame_id", "rslidar");
    rewrite_stamp_ = declare_parameter<bool>("rewrite_stamp_to_scan_start", true);
    sort_by_time_ = declare_parameter<bool>("sort_by_time", true);
    n_scans_ = declare_parameter<int>("n_scans", 32);
    min_range_ = declare_parameter<double>("min_range", 0.0);
    input_best_effort_ = declare_parameter<bool>("input_best_effort", true);

    // Publish RELIABLE: it satisfies both FAST-LIO's requested BEST_EFFORT
    // (laserMapping.cpp:926 uses SensorDataQoS) and FAST-LIVO2's default RELIABLE
    // (LIVMapper.cpp:309 passes a bare depth). Publishing BEST_EFFORT would leave
    // FAST-LIVO2 with no data at all.
    const auto pub_qos = rclcpp::QoS(rclcpp::KeepLast(10)).reliable().durability_volatile();
    // Subscribe BEST_EFFORT by default: that is what the live rslidar_sdk driver offers, and
    // a BEST_EFFORT publisher cannot feed a RELIABLE subscriber at all. For `ros2 bag play`,
    // which reproduces the recorded offered QoS (these bags record /rslidar_points as
    // reliable), set input_best_effort:=false so no scans are dropped on replay.
    const rclcpp::QoS sub_qos = input_best_effort_
      ? rclcpp::QoS(rclcpp::SensorDataQoS())
      : rclcpp::QoS(rclcpp::KeepLast(10)).reliable().durability_volatile();

    pub_ = create_publisher<sensor_msgs::msg::PointCloud2>(output_topic_, pub_qos);
    sub_ = create_subscription<sensor_msgs::msg::PointCloud2>(
      input_topic_, sub_qos,
      std::bind(&LidarConverterNode::callback, this, std::placeholders::_1));

    RCLCPP_INFO(get_logger(),
                "lidar_converter: %s -> %s (frame '%s', rewrite_stamp=%s, sort=%s, n_scans=%d, "
                "input_qos=%s)",
                input_topic_.c_str(), output_topic_.c_str(), output_frame_.c_str(),
                rewrite_stamp_ ? "true" : "false", sort_by_time_ ? "true" : "false", n_scans_,
                input_best_effort_ ? "best_effort" : "reliable");
  }

private:
  static builtin_interfaces::msg::Time toRosTime(double t)
  {
    const double s = std::floor(t);
    builtin_interfaces::msg::Time out;
    out.sec = static_cast<std::int32_t>(s);
    out.nanosec = static_cast<std::uint32_t>(std::lround((t - s) * 1e9));
    if (out.nanosec >= 1000000000u) {  // lround can carry to exactly 1e9
      out.nanosec -= 1000000000u;
      out.sec += 1;
    }
    return out;
  }

  // PCL's "field didn't match, here's a zero" failure is silent. Make it loud.
  void validateFieldsOnce(const sensor_msgs::msg::PointCloud2 & msg)
  {
    if (fields_checked_) {
      return;
    }
    fields_checked_ = true;

    const std::pair<const char *, std::uint8_t> expect[] = {
      {"x", sensor_msgs::msg::PointField::FLOAT32},
      {"y", sensor_msgs::msg::PointField::FLOAT32},
      {"z", sensor_msgs::msg::PointField::FLOAT32},
      {"intensity", sensor_msgs::msg::PointField::FLOAT32},
      {"ring", sensor_msgs::msg::PointField::UINT16},
      {"timestamp", sensor_msgs::msg::PointField::FLOAT64},
    };
    for (const auto & [name, dt] : expect) {
      const auto it = std::find_if(msg.fields.begin(), msg.fields.end(),
                                   [&](const auto & f) { return f.name == name; });
      if (it == msg.fields.end()) {
        RCLCPP_ERROR(get_logger(), "input has no field '%s' -> it will be silently zero", name);
      } else if (it->datatype != dt || it->count != 1) {
        RCLCPP_ERROR(get_logger(),
                     "field '%s' is datatype %u count %u, expected datatype %u count 1 -> PCL "
                     "will NOT map it and the value will be zero. Fix RsPointXYZIRT.",
                     name, it->datatype, it->count, dt);
      }
    }
    RCLCPP_INFO(get_logger(), "input: %ux%u point_step=%u is_dense=%d",
                msg.width, msg.height, msg.point_step, static_cast<int>(msg.is_dense));
  }

  void callback(const sensor_msgs::msg::PointCloud2::ConstSharedPtr msg)
  {
    validateFieldsOnce(*msg);

    pcl::PointCloud<RsPointXYZIRT> in;
    pcl::fromROSMsg(*msg, in);
    const std::size_t n_in = in.size();
    if (n_in == 0) {
      return;
    }

    // --- pass 1: find the scan start, from valid points only ---------------------------
    // NaN points (~43% of this sensor's output) can carry garbage in every field, so their
    // timestamps must not influence t0/t1.
    double t0 = std::numeric_limits<double>::max();
    double t1 = -std::numeric_limits<double>::max();
    std::size_t n_valid = 0;
    for (const auto & p : in) {
      if (!pcl::isFinite(p)) {
        continue;
      }
      ++n_valid;
      if (std::isfinite(p.timestamp) && p.timestamp > 0.0) {
        t0 = std::min(t0, p.timestamp);
        t1 = std::max(t1, p.timestamp);
      }
    }
    const bool have_time = (t0 <= t1);
    const double stamp_in = rclcpp::Time(msg->header.stamp).seconds();
    if (!have_time) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000,
                           "no usable per-point timestamps; emitting time=0 and keeping the "
                           "original stamp (FAST-LIO will fall back to azimuth-estimated timing)");
      t0 = t1 = stamp_in;
    }

    // --- pass 2: convert ---------------------------------------------------------------
    pcl::PointCloud<VelodynePointXYZIRT> out;
    out.points.reserve(n_valid);
    const float min_r2 = static_cast<float>(min_range_ * min_range_);
    for (const auto & p : in) {
      if (!pcl::isFinite(p)) {
        continue;
      }
      // Guards FAST-LIO's unchecked is_first[layer] write at preprocess.cpp:434.
      if (p.ring >= static_cast<std::uint16_t>(n_scans_)) {
        continue;
      }
      if (min_r2 > 0.0f && (p.x * p.x + p.y * p.y + p.z * p.z) <= min_r2) {
        continue;
      }
      VelodynePointXYZIRT q{};  // value-init so alignment padding isn't published as garbage
      q.x = p.x;
      q.y = p.y;
      q.z = p.z;
      q.data[3] = 1.0f;
      q.intensity = p.intensity;
      q.ring = p.ring;
      q.time = have_time ? static_cast<float>(p.timestamp - t0) : 0.0f;
      out.points.push_back(q);
    }
    if (out.points.empty()) {
      return;
    }

    // This sensor's timestamps are not globally monotonic. FAST-LIO sorts internally
    // (IMU_Processing.hpp:225) but sync_packages reads points.back() BEFORE that sort, so
    // sorting here keeps lidar_end_time exact and guarantees back().time > 0 -- otherwise
    // preprocess.cpp:317 can silently switch the whole scan to azimuth-estimated timing.
    if (sort_by_time_ && have_time) {
      std::stable_sort(out.points.begin(), out.points.end(),
                       [](const VelodynePointXYZIRT & a, const VelodynePointXYZIRT & b) {
                         return a.time < b.time;
                       });
    }

    out.width = static_cast<std::uint32_t>(out.points.size());
    out.height = 1;
    out.is_dense = true;

    sensor_msgs::msg::PointCloud2 out_msg;
    pcl::toROSMsg(out, out_msg);
    out_msg.header.frame_id = output_frame_;
    out_msg.header.stamp = (rewrite_stamp_ && have_time) ? toRosTime(t0) : msg->header.stamp;
    pub_->publish(out_msg);

    // `in.stamp - t_first` is the measurement of the scan-end-stamp bug, and
    // `out.stamp + t_last` should reproduce the original header stamp. Printed for the
    // first few scans so the fix is visible on every run.
    const double span = t1 - t0;
    const double shift = stamp_in - t0;
    const double out_stamp = rclcpp::Time(out_msg.header.stamp).seconds();
    if (n_logged_ < 3) {
      ++n_logged_;
      RCLCPP_INFO(get_logger(),
                  "scan %ld: %zu/%zu kept | span %.4f s | in.stamp - t_first = %+.4f s | "
                  "out.stamp %.9f | out.stamp + t_last = %.9f",
                  n_logged_, out.points.size(), n_in, span, shift, out_stamp,
                  out_stamp + static_cast<double>(out.points.back().time));
    } else {
      RCLCPP_INFO_THROTTLE(get_logger(), *get_clock(), 5000,
                           "%zu/%zu kept | span %.4f s | in.stamp - t_first = %+.4f s",
                           out.points.size(), n_in, span, shift);
    }
  }

  std::string input_topic_;
  std::string output_topic_;
  std::string output_frame_;
  bool rewrite_stamp_{true};
  bool sort_by_time_{true};
  bool input_best_effort_{true};
  bool fields_checked_{false};
  int n_scans_{32};
  double min_range_{0.0};
  long n_logged_{0};

  rclcpp::Subscription<sensor_msgs::msg::PointCloud2>::SharedPtr sub_;
  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr pub_;
};

}  // namespace lidar_converter

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<lidar_converter::LidarConverterNode>());
  rclcpp::shutdown();
  return 0;
}
