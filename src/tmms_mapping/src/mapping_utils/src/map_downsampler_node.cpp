// Voxel-downsamples FAST-LIO's accumulated map so it can be streamed to Lichtblick over
// rosbridge, giving the operator a live view of which areas have already been covered.
//
// Input  /Laser_map                 (pcl::PointXYZINormal, point_step 48)
// Output /downsampled_fastlio_map   (pcl::PointXYZI,       point_step 32)
//
// Why this exists: publish_map() accumulates into pcl_wait_pub and never clears it, then
// re-serialises the WHOLE buffer every tick (laserMapping.cpp:592-595) on a 1 Hz timer. The
// buffer has no deduplication, so a wall seen 100 times is stored 100 times and the cloud
// grows with TIME rather than with area covered. At 855k points that is 41 MB every second,
// which rosbridge (Python) cannot sustain -- the Lichtblick view freezes a minute or two in.
//
// A voxel grid changes the growth curve rather than just scaling it down: point count then
// tracks mapped-surface-area / leaf^2, which SATURATES once a space has been covered.
// Dropping the normals and curvature (48 -> 32 B/pt) is a further 1.5x on top.
//
// This is a separate node rather than a patch to publish_map() for two reasons:
//   1. FAST-LIO spins a single-threaded rclcpp::spin() (laserMapping.cpp:1162), so a
//      VoxelGrid over a growing cloud (50-100 ms and rising) would land directly on the
//      thread running state estimation.
//   2. save_to_pcd() writes pcl_wait_pub itself (laserMapping.cpp:611). A separate
//      subscriber cannot touch that buffer, so /map_save output is unaffected BY
//      CONSTRUCTION -- there is no way for a leaf-size change here to degrade a saved map.
//
// Stateless: every input message is the full map, so re-filtering per message needs no
// history and self-heals if FAST-LIO restarts and the map resets.

#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>

#include <pcl/common/common.h>  // pcl::getMinMax3D
#include <pcl/filters/voxel_grid.h>
#include <pcl/point_cloud.h>
#include <pcl/point_types.h>
#include <pcl_conversions/pcl_conversions.h>

namespace lidar_converter
{

class MapDownsamplerNode : public rclcpp::Node
{
public:
  MapDownsamplerNode()
  : rclcpp::Node("map_downsampler")
  {
    input_topic_ = declare_parameter<std::string>("input_topic", "/Laser_map");
    // Absolute: a relative name would resolve under the node namespace as
    // /map_downsampler/downsampled_fastlio_map.
    output_topic_ = declare_parameter<std::string>("output_topic", "/downsampled_fastlio_map");
    leaf_size_ = declare_parameter<double>("leaf_size", 0.5);
    min_publish_period_s_ = declare_parameter<double>("min_publish_period_s", 0.0);

    if (leaf_size_ <= 0.0) {
      RCLCPP_ERROR(get_logger(), "leaf_size must be > 0 (got %.4f); falling back to 0.5",
                   leaf_size_);
      leaf_size_ = 0.5;
    }

    // FAST-LIO publishes /Laser_map with a bare depth (laserMapping.cpp:932), so the offered
    // QoS is RELIABLE + VOLATILE. This subscription MUST stay volatile: a TRANSIENT_LOCAL
    // subscriber against a VOLATILE publisher is an incompatible pair and would receive
    // nothing at all. Depth 1 because these messages are tens of megabytes -- a deeper queue
    // would hold several whole maps at once, and only the newest is ever useful.
    const auto sub_qos = rclcpp::QoS(rclcpp::KeepLast(1)).reliable().durability_volatile();

    // Output is TRANSIENT_LOCAL so a late joiner gets the current map immediately instead of
    // a blank panel until the next publish. That matters here: this is a coverage display
    // refreshed at ~1 Hz at best, and slower as the input map grows.
    //
    // rosbridge picks this up on its own -- subscribers.py::_get_default_qos_profile sets the
    // subscription to TRANSIENT_LOCAL + RELIABLE when every publisher on the topic offers
    // TRANSIENT_LOCAL, which holds here since this node is the only publisher. Retaining one
    // sample costs one message of memory.
    //
    // Caveat: rosbridge samples publisher QoS when the subscription is created. If Lichtblick
    // subscribes before this node is up it falls back to VOLATILE (still compatible, just not
    // latched) and stays that way until it re-subscribes.
    const auto pub_qos = rclcpp::QoS(rclcpp::KeepLast(1)).reliable().transient_local();

    pub_ = create_publisher<sensor_msgs::msg::PointCloud2>(output_topic_, pub_qos);
    sub_ = create_subscription<sensor_msgs::msg::PointCloud2>(
      input_topic_, sub_qos,
      std::bind(&MapDownsamplerNode::callback, this, std::placeholders::_1));

    RCLCPP_INFO(get_logger(),
                "map_downsampler: %s -> %s (leaf %.3f m, min_period %.2f s)",
                input_topic_.c_str(), output_topic_.c_str(), leaf_size_, min_publish_period_s_);
  }

private:
  // PCL's VoxelGrid does NOT error out when the leaf is too small for the cloud's extent --
  // voxel_grid.hpp:248-258 emits a PCL_WARN and then does `output = *input_; return;`, i.e.
  // it passes the cloud through COMPLETELY UNFILTERED. On a large map that means silently
  // republishing the full 41 MB cloud, defeating the entire purpose of this node, with
  // nothing but a stderr warning to show for it.
  //
  // So replicate PCL's check up front and refuse to publish instead. Returns true if
  // filtering is safe.
  bool leafSizeIsSafe(const pcl::PointCloud<pcl::PointXYZI> & cloud)
  {
    pcl::PointXYZI min_p, max_p;
    pcl::getMinMax3D(cloud, min_p, max_p);

    const double inv = 1.0 / leaf_size_;
    const auto dx = static_cast<std::int64_t>((max_p.x - min_p.x) * inv) + 1;
    const auto dy = static_cast<std::int64_t>((max_p.y - min_p.y) * inv) + 1;
    const auto dz = static_cast<std::int64_t>((max_p.z - min_p.z) * inv) + 1;

    if (dx * dy * dz <= static_cast<std::int64_t>(std::numeric_limits<std::int32_t>::max())) {
      return true;
    }

    // Smallest leaf that keeps dx*dy*dz under the limit, for the current extent.
    const double ex = max_p.x - min_p.x;
    const double ey = max_p.y - min_p.y;
    const double ez = max_p.z - min_p.z;
    const double min_leaf =
      std::cbrt(ex * ey * ez / static_cast<double>(std::numeric_limits<std::int32_t>::max()));

    RCLCPP_ERROR_THROTTLE(
      get_logger(), *get_clock(), 5000,
      "leaf_size %.4f m is too small for a %.1f x %.1f x %.1f m map: PCL would silently pass "
      "the cloud through UNFILTERED (%zu points). Not publishing. Use leaf_size >= %.3f m.",
      leaf_size_, ex, ey, ez, cloud.size(), min_leaf);
    return false;
  }

  void callback(const sensor_msgs::msg::PointCloud2::ConstSharedPtr msg)
  {
    if (min_publish_period_s_ > 0.0) {
      const auto now = this->now();
      if (last_pub_time_.nanoseconds() != 0 &&
          (now - last_pub_time_).seconds() < min_publish_period_s_)
      {
        return;
      }
      last_pub_time_ = now;
    }

    const auto t_start = std::chrono::steady_clock::now();

    // Field-matches x/y/z/intensity by name; the source's normal_x/y/z and curvature are
    // simply not mapped. FAST-LIO's intensity survives, so Lichtblick can still colour by it.
    //
    // Built as a Ptr rather than a value + makeShared(): setInputCloud needs a shared_ptr,
    // and makeShared() would deep-copy the whole cloud -- ~27 MB per message at the sizes
    // this node exists to deal with.
    auto in = std::make_shared<pcl::PointCloud<pcl::PointXYZI>>();
    pcl::fromROSMsg(*msg, *in);
    if (in->empty()) {
      return;
    }

    if (!leafSizeIsSafe(*in)) {
      return;
    }

    pcl::PointCloud<pcl::PointXYZI> out;
    pcl::VoxelGrid<pcl::PointXYZI> vg;
    vg.setInputCloud(in);
    vg.setLeafSize(static_cast<float>(leaf_size_), static_cast<float>(leaf_size_),
                   static_cast<float>(leaf_size_));
    vg.filter(out);
    if (out.empty()) {
      return;
    }

    out.width = static_cast<std::uint32_t>(out.size());
    out.height = 1;
    out.is_dense = true;

    sensor_msgs::msg::PointCloud2 out_msg;
    pcl::toROSMsg(out, out_msg);
    // Pass the header through untouched: the frame must stay whatever FAST-LIO published
    // (camera_init) or the cloud lands in the wrong place in the TF tree.
    out_msg.header = msg->header;
    pub_->publish(out_msg);

    // Printed so the reduction is visible and the leaf is tunable from the terminal. If the
    // output count stops climbing while the input keeps growing, saturation is working.
    //
    // Watch `took`: /Laser_map arrives at 1 Hz, and the subscription is KeepLast(1), so once
    // deserialise + filter exceeds ~1 s the intervening messages are dropped and the OUTPUT
    // rate falls to 1/took. A downsampled topic publishing slower than 1 Hz is this, not a
    // bug -- the cost scales with the input map, which grows for the whole session.
    const double took = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - t_start).count();
    RCLCPP_INFO_THROTTLE(get_logger(), *get_clock(), 5000,
                         "%zu -> %zu pts (%.1fx) | %.1f MB -> %.1f MB | took %.3f s",
                         in->size(), out.size(),
                         static_cast<double>(in->size()) / static_cast<double>(out.size()),
                         static_cast<double>(msg->data.size()) / 1e6,
                         static_cast<double>(out_msg.data.size()) / 1e6, took);
  }

  std::string input_topic_;
  std::string output_topic_;
  double leaf_size_{0.5};
  double min_publish_period_s_{0.0};
  rclcpp::Time last_pub_time_{0, 0, RCL_ROS_TIME};

  rclcpp::Subscription<sensor_msgs::msg::PointCloud2>::SharedPtr sub_;
  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr pub_;
};

}  // namespace lidar_converter

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<lidar_converter::MapDownsamplerNode>());
  rclcpp::shutdown();
  return 0;
}
