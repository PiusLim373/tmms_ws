// Voxel-downsamples a saved .pcd so it can be streamed to Lichtblick over rosbridge, giving
// the operator 3D context alongside the 2D map during navigation.
//
// Service ~/load_pcd                tmms_msgs/srv/StringTrigger, data = bare map name
// Output  /downsampled_pcd_map      (pcl::PointXYZI,       point_step 32)
//
// A raw .pcd is far too large for rosbridge. A voxel grid makes the point count track
// mapped-surface-area / leaf^2 instead of the number of scans that went into the file, and
// dropping the normals and curvature (48 -> 32 B/pt) is a further 1.5x on top.
//
// The live map during a mapping session is not done here: FAST-LIO publishes its own
// /downsampled_fastlio_map.

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <std_msgs/msg/header.hpp>
#include <tmms_msgs/srv/string_trigger.hpp>

#include <pcl/common/common.h>  // pcl::getMinMax3D
#include <pcl/filters/voxel_grid.h>
#include <pcl/io/pcd_io.h>
#include <pcl/point_cloud.h>
#include <pcl/point_types.h>
#include <pcl_conversions/pcl_conversions.h>

namespace lidar_converter
{
namespace
{

// Anchored, no dot or slash possible -- the whole path-traversal defence for load_pcd, which
// joins the name straight onto pcd_dir. Same rule as map_flattener_node, mapping_manager_node
// and ui_backend.js.
bool isValidMapName(const std::string & name)
{
  return !name.empty() && std::all_of(name.begin(), name.end(), [](unsigned char c) {
           return std::isalnum(c) != 0 || c == '_';
         });
}

std::string trimmed(const std::string & s)
{
  const auto begin = s.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) {
    return "";
  }
  return s.substr(begin, s.find_last_not_of(" \t\r\n") - begin + 1);
}

}  // namespace

class MapDownsamplerNode : public rclcpp::Node
{
public:
  MapDownsamplerNode()
  : rclcpp::Node("map_downsampler")
  {
    pcd_output_topic_ = declare_parameter<std::string>("pcd_output_topic", "/downsampled_pcd_map");
    leaf_size_ = declare_parameter<double>("leaf_size", 0.5);
    // Root of the map store; ~/load_pcd reads <maps_dir>/pcd/<name>.pcd. Every node in the
    // workspace takes the ROOT and derives the subfolder, so there is one path to configure.
    maps_dir_ = expandUser(declare_parameter<std::string>("maps_dir", "~/.htxgrrt/maps"));
    // A .pcd carries no frame: a loaded map is whatever the 2D map alongside it is anchored
    // to, which for nav2 is `map`.
    pcd_frame_id_ = declare_parameter<std::string>("pcd_frame_id", "map");

    if (leaf_size_ <= 0.0) {
      RCLCPP_ERROR(get_logger(), "leaf_size must be > 0 (got %.4f); falling back to 0.5",
                   leaf_size_);
      leaf_size_ = 0.5;
    }

    // TRANSIENT_LOCAL, and for this topic latching is the entire delivery mechanism: a loaded
    // .pcd is published exactly once per load, so a subscriber that joins afterwards would
    // otherwise see nothing at all.
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
    pcd_pub_ = create_publisher<sensor_msgs::msg::PointCloud2>(pcd_output_topic_, pub_qos);

    load_srv_ = create_service<tmms_msgs::srv::StringTrigger>(
      "~/load_pcd",
      std::bind(&MapDownsamplerNode::loadPcdCallback, this,
                std::placeholders::_1, std::placeholders::_2));

    RCLCPP_INFO(get_logger(), "map_downsampler: %s/pcd/<name>.pcd -> %s (leaf %.3f m, frame %s)",
                maps_dir_.c_str(), pcd_output_topic_.c_str(), leaf_size_, pcd_frame_id_.c_str());
  }

private:
  // PCL's VoxelGrid does NOT error out when the leaf is too small for the cloud's extent --
  // voxel_grid.hpp:248-258 emits a PCL_WARN and then does `output = *input_; return;`, i.e.
  // it passes the cloud through COMPLETELY UNFILTERED. On a large map that means silently
  // publishing the full cloud, defeating the entire purpose of this node, with nothing but a
  // stderr warning to show for it.
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

  // Reads <maps_dir>/pcd/<name>.pcd, voxelises it and puts it out on pcd_output_topic_.
  void loadPcdCallback(
    const tmms_msgs::srv::StringTrigger::Request::SharedPtr req,
    tmms_msgs::srv::StringTrigger::Response::SharedPtr res)
  {
    const std::string name = trimmed(req->data);
    if (!isValidMapName(name)) {
      res->success = false;
      res->message = "invalid map name '" + name + "': must match [A-Za-z0-9_]+";
      RCLCPP_ERROR(get_logger(), "%s", res->message.c_str());
      return;
    }

    const std::string path = maps_dir_ + "/pcd/" + name + ".pcd";

    // loadPCDFile field-matches by name, so a FAST-LIO PointXYZINormal file loads into
    // PointXYZI with the normals and curvature simply dropped -- which is what we want on the
    // wire anyway (32 B/pt instead of 48).
    auto in = std::make_shared<pcl::PointCloud<pcl::PointXYZI>>();
    if (pcl::io::loadPCDFile<pcl::PointXYZI>(path, *in) == -1) {
      res->success = false;
      res->message = "could not read " + path;
      RCLCPP_ERROR(get_logger(), "%s", res->message.c_str());
      return;
    }

    std_msgs::msg::Header header;
    header.stamp = now();
    header.frame_id = pcd_frame_id_;

    // 32 B/pt is the on-disk-equivalent size, for a like-for-like ratio in the log.
    const std::size_t input_bytes = in->size() * 32;

    std::string summary;
    if (!downsampleAndPublish(in, header, input_bytes, summary)) {
      res->success = false;
      res->message = "loaded " + path + " but nothing could be published; see the node log "
                     "(usually leaf_size too small for the map extent)";
      RCLCPP_ERROR(get_logger(), "%s", res->message.c_str());
      return;
    }

    res->success = true;
    res->message = name + ": " + summary;
    RCLCPP_INFO(get_logger(), "loaded %s -> %s | %s", path.c_str(), pcd_output_topic_.c_str(),
                summary.c_str());
  }

  // Returns false and publishes nothing if the cloud is empty or the leaf is unsafe for its
  // extent.
  bool downsampleAndPublish(
    const pcl::PointCloud<pcl::PointXYZI>::Ptr & in,
    const std_msgs::msg::Header & header,
    std::size_t input_bytes,
    std::string & summary)
  {
    if (in->empty()) {
      return false;
    }
    if (!leafSizeIsSafe(*in)) {
      return false;
    }

    const auto t_start = std::chrono::steady_clock::now();

    pcl::PointCloud<pcl::PointXYZI> out;
    pcl::VoxelGrid<pcl::PointXYZI> vg;
    vg.setInputCloud(in);
    vg.setLeafSize(static_cast<float>(leaf_size_), static_cast<float>(leaf_size_),
                   static_cast<float>(leaf_size_));
    vg.filter(out);
    if (out.empty()) {
      return false;
    }

    out.width = static_cast<std::uint32_t>(out.size());
    out.height = 1;
    out.is_dense = true;

    sensor_msgs::msg::PointCloud2 out_msg;
    pcl::toROSMsg(out, out_msg);
    out_msg.header = header;
    pcd_pub_->publish(out_msg);

    const double took = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - t_start).count();

    char buf[256];
    std::snprintf(buf, sizeof(buf), "%zu -> %zu pts (%.1fx) | %.1f MB -> %.1f MB | took %.3f s",
                  in->size(), out.size(),
                  static_cast<double>(in->size()) / static_cast<double>(out.size()),
                  static_cast<double>(input_bytes) / 1e6,
                  static_cast<double>(out_msg.data.size()) / 1e6, took);
    summary = buf;
    return true;
  }

  // Only "~" and "~/..." -- enough for the maps_dir default, and it leaves the absolute path
  // every launch file passes completely alone.
  std::string expandUser(const std::string & path) const
  {
    if (path.empty() || path[0] != '~') {
      return path;
    }
    const char * home = std::getenv("HOME");
    if (home == nullptr) {
      RCLCPP_WARN(get_logger(), "HOME is unset; cannot expand '%s'", path.c_str());
      return path;
    }
    return std::string(home) + path.substr(1);
  }

  std::string pcd_output_topic_;
  std::string maps_dir_;
  std::string pcd_frame_id_;
  double leaf_size_{0.5};

  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr pcd_pub_;
  rclcpp::Service<tmms_msgs::srv::StringTrigger>::SharedPtr load_srv_;
};

}  // namespace lidar_converter

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<lidar_converter::MapDownsamplerNode>());
  rclcpp::shutdown();
  return 0;
}
