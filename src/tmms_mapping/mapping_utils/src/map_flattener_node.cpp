// Flattens a saved FAST-LIO .pcd into the 2D nav_msgs/OccupancyGrid nav2 needs, with the
// filter thresholds retunable live from the UI.
//
// Service  ~/load_pcd            tmms_msgs/srv/StringTrigger, data = bare map name
// Service  ~/republish_map       std_srvs/srv/Trigger
// Output   /flattened_map        nav_msgs/OccupancyGrid    transient_local
// Output   /flattened_cloud      sensor_msgs/PointCloud2   transient_local
// Output   /flattened_map_info   std_msgs/String (JSON)    transient_local
// Output   /editor_flattened_map nav_msgs/OccupancyGrid    volatile, on ~/republish_map only
//
// Derived from LihanChen2004/pcd2pgm (Apache-2.0, Copyright 2025 Lihan Chen). The filter
// chain, the OccupancyGrid rasterisation and the parameter-descriptor retune path are
// upstream's; the service-driven load, the publish-on-change model and the guards below are
// not.
//
// Pipeline, re-run from the loaded cloud on every rebuild so nothing compounds:
//
//   pcd_cloud_  --PassThrough on z [thre_z_min, thre_z_max]-->  --RadiusOutlierRemoval-->  raster
//
// WHY SERVICE-DRIVEN: upstream takes its pcd_file as a startup parameter and dies if the file
// is missing. Here the operator picks a map in the UI after the mapping session is already
// over, so the node has to be running with nothing loaded and take the name later. The name
// is a BARE map name, never a path -- see loadPcdCallback for why that matters.
//
// WHY NO TIMER: upstream re-serialises the same unchanged grid onto the wire every second
// (pcd2pgm.cpp:105-121). The three rebuild publishers here are TRANSIENT_LOCAL instead, so the
// last sample is retained by the middleware and a late subscriber gets it on connect -- for the
// cost of one message of memory rather than one message per second, forever. Publishing
// therefore happens exactly twice per user action: once on load, once per rebuild. The fourth,
// /editor_flattened_map, is on-demand and volatile; see its publisher comment.
//
// The rebuild itself is NOT cheap (see rebuildAndPublish), which is why the parameter path
// debounces rather than rebuilding per set_parameters call.
//
// That debounce is also why /flattened_map_info exists. A set_parameters call returns the
// moment the timer is armed, seconds before the map it asked for exists, so a UI driving the
// thresholds has no way to tell "still working" from "finished, nothing changed". The info
// topic is published at the END of every rebuild -- including the ones that fail -- and
// carries the grid dimensions the caller needs to decide whether the result is worth pulling
// over the wire, plus the remediation text when the cell cap is hit.

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <rclcpp/rclcpp.hpp>
#include <rcl_interfaces/msg/parameter_descriptor.hpp>
#include <nav_msgs/msg/occupancy_grid.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_srvs/srv/trigger.hpp>
#include <tmms_msgs/srv/string_trigger.hpp>

#include <pcl/common/common.h>  // pcl::getMinMax3D
#include <pcl/common/transforms.h>
#include <pcl/filters/passthrough.h>
#include <pcl/filters/radius_outlier_removal.h>
#include <pcl/filters/voxel_grid.h>
#include <pcl/io/pcd_io.h>
#include <pcl/point_cloud.h>
#include <pcl/point_types.h>
#include <pcl_conversions/pcl_conversions.h>

namespace lidar_converter
{
namespace
{

using PointT = pcl::PointXYZ;
using CloudT = pcl::PointCloud<PointT>;

// Anchored, and with no dot or slash possible. This is the WHOLE path-traversal defence for
// load_pcd, which joins the name straight onto pcd_dir -- the same rule mapping_manager_node.py
// and ui_backend.js enforce on the way in.
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

// The info topic is JSON, so anything interpolated into it has to survive being quoted. Map
// names are already [A-Za-z0-9_], but the status messages are assembled from filter output and
// there is no reason to assume they always will be.
std::string jsonEscape(const std::string & s)
{
  std::string out;
  out.reserve(s.size() + 8);
  for (const char c : s) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}

// NOTE: the step is deliberately left at 0.0 (continuous). rclcpp rejects any value that does
// not land exactly on a non-zero step grid, and slider UIs emit arbitrary doubles, so a
// non-zero step here would make every slider throw "doesn't comply with step".
rcl_interfaces::msg::ParameterDescriptor tunableRange(
  const std::string & description, double from, double to)
{
  rcl_interfaces::msg::ParameterDescriptor descriptor;
  descriptor.description = description;
  rcl_interfaces::msg::FloatingPointRange range;
  range.from_value = from;
  range.to_value = to;
  range.step = 0.0;
  descriptor.floating_point_range.push_back(range);
  return descriptor;
}

rcl_interfaces::msg::ParameterDescriptor tunableIntRange(
  const std::string & description, std::int64_t from, std::int64_t to)
{
  rcl_interfaces::msg::ParameterDescriptor descriptor;
  descriptor.description = description;
  rcl_interfaces::msg::IntegerRange range;
  range.from_value = from;
  range.to_value = to;
  range.step = 1;
  descriptor.integer_range.push_back(range);
  return descriptor;
}

rcl_interfaces::msg::ParameterDescriptor describe(const std::string & description)
{
  rcl_interfaces::msg::ParameterDescriptor descriptor;
  descriptor.description = description;
  return descriptor;
}

// Marking a parameter read_only makes a set_parameters call fail WITH A REASON instead of
// silently accepting a change that never takes effect. Used for anything baked in at
// construction -- the publishers exist by then, and the paths are resolved.
rcl_interfaces::msg::ParameterDescriptor startupOnly(const std::string & description)
{
  auto descriptor = describe(description + " (applied at startup only)");
  descriptor.read_only = true;
  return descriptor;
}

}  // namespace

class MapFlattenerNode : public rclcpp::Node
{
public:
  MapFlattenerNode()
  : rclcpp::Node("map_flattener")
  {
    declareParameters();

    maps_dir_ = expandUser(get_parameter("maps_dir").as_string());
    pcd_dir_ = maps_dir_ + "/pcd";
    map_topic_name_ = get_parameter("map_topic_name").as_string();
    cloud_topic_name_ = get_parameter("cloud_topic_name").as_string();
    info_topic_name_ = get_parameter("info_topic_name").as_string();
    editor_topic_name_ = get_parameter("editor_topic_name").as_string();
    map_frame_id_ = get_parameter("map_frame_id").as_string();
    readTunables();

    // TRANSIENT_LOCAL is the whole reason there is no republish timer: the middleware retains
    // the last sample and hands it to any subscriber that joins later. rosbridge picks this up
    // on its own -- subscribers.py::_get_default_qos_profile sets the subscription to
    // TRANSIENT_LOCAL + RELIABLE when every publisher on the topic offers it, which holds here
    // since this node is the only publisher on both topics.
    //
    // Caveat, same as map_downsampler: rosbridge samples publisher QoS when the subscription is
    // created. A browser that subscribes before this node is up falls back to VOLATILE (still
    // compatible, just not latched) until it re-subscribes.
    //
    // KeepLast(1) because only the newest grid is ever useful and these are large messages.
    const auto latched_qos = rclcpp::QoS(rclcpp::KeepLast(1)).reliable().transient_local();

    map_pub_ = create_publisher<nav_msgs::msg::OccupancyGrid>(map_topic_name_, latched_qos);
    cloud_pub_ = create_publisher<sensor_msgs::msg::PointCloud2>(cloud_topic_name_, latched_qos);
    // Latched like the other two, so a UI that connects after a rebuild still learns the
    // current state instead of waiting for the operator to touch a slider.
    info_pub_ = create_publisher<std_msgs::msg::String>(info_topic_name_, latched_qos);

    // The same grid as map_pub_, on a topic that exists for one reason: LICHTBLICK MUST NEVER
    // SUBSCRIBE TO IT. Do not add it to a layout in app/tmms_lichtblick/.
    //
    // rosbridge keeps ONE subscription per topic shared by every browser client, and applies
    // the `raw` flag only for whichever client subscribed FIRST (subscribers.py:350).
    // Lichtblick subscribes with compression cbor-raw, so on any topic it has open that shared
    // subscription is in raw mode and its callback is handed `bytes` instead of a message. When
    // the map editor then subscribes to the same topic asking for plain cbor, rosbridge throws
    //     AttributeError: 'bytes' object has no attribute 'get_fields_and_field_types'
    // on its handler thread -- the browser is sent nothing at all and simply waits. /flattened_map
    // is exactly that case, which is why the editor reads this topic instead.
    //
    // VOLATILE, unlike every other publisher here, and that is deliberate. Latching would retain
    // the last grid this service published, and that sample is stale by construction: open the
    // editor, close it, retune, rebuild, open again -- the subscriber joins, the middleware hands
    // it the PREVIOUS grid, and the editor opens the pre-retune map looking perfectly normal.
    // With nothing retained the only thing that can ever arrive is the publish below, taken from
    // last_grid_, which every successful rebuild refreshes. The caller must therefore subscribe
    // BEFORE calling ~/republish_map; the UI does exactly that.
    editor_pub_ = create_publisher<nav_msgs::msg::OccupancyGrid>(
      editor_topic_name_, rclcpp::QoS(rclcpp::KeepLast(1)).reliable());

    // Two mutually-exclusive groups rather than one: a rebuild can run for seconds on a large
    // map (see rebuildAndPublish), and it must not sit in front of the next load_pcd in the
    // same queue. state_mutex_ is what actually serialises them; the groups just keep them off
    // each other's executor thread. Parameter set_parameters calls are served by the node's
    // default group, so the UI's sliders stay responsive while a rebuild is in flight.
    service_group_ = create_callback_group(rclcpp::CallbackGroupType::MutuallyExclusive);
    rebuild_group_ = create_callback_group(rclcpp::CallbackGroupType::MutuallyExclusive);

    load_srv_ = create_service<tmms_msgs::srv::StringTrigger>(
      "~/load_pcd",
      std::bind(&MapFlattenerNode::loadPcdCallback, this,
                std::placeholders::_1, std::placeholders::_2),
      rclcpp::ServicesQoS(), service_group_);

    // The only thing that ever publishes on editor_topic_name_. See that publisher's comment
    // for why the map editor cannot just read /flattened_map, and why the topic is volatile.
    // The UI subscribes and then calls this; the grid goes out while the browser is listening.
    republish_srv_ = create_service<std_srvs::srv::Trigger>(
      "~/republish_map",
      std::bind(&MapFlattenerNode::republishMapCallback, this,
                std::placeholders::_1, std::placeholders::_2),
      rclcpp::ServicesQoS(), service_group_);

    // create_wall_timer has no one-shot mode, so this is armed by cancel/reset instead: it is
    // cancelled here, reset() by the parameter callback (which restarts the countdown, so a
    // burst of slider changes re-arms rather than stacking), and cancels itself before doing
    // the work. Net effect is upstream's needs_update_ coalescing without a periodic wakeup.
    rebuild_timer_ = create_wall_timer(
      std::chrono::duration<double>(rebuild_debounce_s_),
      std::bind(&MapFlattenerNode::rebuildTimerCallback, this), rebuild_group_);
    rebuild_timer_->cancel();

    // post_set rather than on_set: the descriptors above already reject out-of-range values,
    // so by the time this runs the change is committed and the only job left is to mirror it
    // into the members and arm the rebuild.
    post_set_params_handle_ = add_post_set_parameters_callback(
      std::bind(&MapFlattenerNode::onParametersSet, this, std::placeholders::_1));

    RCLCPP_INFO(get_logger(),
                "map_flattener: pcd_dir %s -> %s + %s (frame %s, res %.3f m, z [%.2f, %.2f]%s, "
                "radius %.2f m / %d pts)",
                pcd_dir_.c_str(), map_topic_name_.c_str(), cloud_topic_name_.c_str(),
                map_frame_id_.c_str(), map_resolution_, thre_z_min_, thre_z_max_,
                flag_pass_through_ ? " inverted" : "", thre_radius_, thres_point_count_);
    RCLCPP_INFO(get_logger(),
                "map editor reads %s (volatile), served by %s/republish_map",
                editor_topic_name_.c_str(), get_fully_qualified_name());
    RCLCPP_INFO(get_logger(),
                "waiting for a map: ros2 service call %s/load_pcd "
                "tmms_msgs/srv/StringTrigger \"{data: <map_name>}\"",
                get_fully_qualified_name());
  }

private:
  // -- setup -----------------------------------------------------------------

  void declareParameters()
  {
    declare_parameter(
      "maps_dir", "~/.htxgrrt/maps",
      startupOnly("Root of the map store; .pcd files are read from <maps_dir>/pcd"));
    declare_parameter(
      "map_topic_name", "/flattened_map",
      startupOnly("Topic the occupancy grid is published on"));
    declare_parameter(
      "cloud_topic_name", "/flattened_cloud",
      startupOnly("Topic the post-filter preview cloud is published on"));
    declare_parameter(
      "info_topic_name", "/flattened_map_info",
      startupOnly("Topic the per-rebuild JSON status is published on"));
    declare_parameter(
      "editor_topic_name", "/editor_flattened_map",
      startupOnly("Topic the map editor pulls the grid from, on ~/republish_map only. Must "
                  "stay off every Lichtblick layout -- see the publisher comment"));
    // camera_init, not map. A FAST-LIO .pcd is accumulated in camera_init -- the IMU pose at
    // the moment that session initialised -- so those ARE the coordinates of every point in
    // the file, and of the grid rasterised from it. Stamping it `map` would be a claim about
    // where the map sits in the world that nothing in the system currently backs: no
    // localiser runs yet, so nothing publishes map -> odom and the grid would render nowhere.
    // camera_init is connected (mapping_manager latches odom -> camera_init at session
    // start), so the operator can actually see what they are tuning.
    //
    // This costs nothing at navigation time: the saved .png/.yaml carry no frame at all, and
    // map_server stamps whatever it loads as `map` regardless.
    declare_parameter(
      "map_frame_id", "camera_init", startupOnly("frame_id stamped on both outputs"));

    declare_parameter(
      "thre_z_min", 0.1, tunableRange("Lower bound of the obstacle height band [m]", -5.0, 5.0));
    declare_parameter(
      "thre_z_max", 1.45, tunableRange("Upper bound of the obstacle height band [m]", -5.0, 5.0));
    declare_parameter(
      "flag_pass_through", false,
      describe("Invert the height band: keep floor/ceiling instead of the band"));
    declare_parameter(
      "thre_radius", 0.1, tunableRange("Radius Outlier Removal search radius [m]", 0.01, 1.0));
    declare_parameter(
      "thres_point_count", 10,
      tunableIntRange("Minimum neighbours within thre_radius to keep a point", 0, 200));
    declare_parameter(
      "map_resolution", 0.02, tunableRange("Occupancy grid cell size [m]", 0.005, 1.0));

    declare_parameter(
      "odom_to_lidar_odom", std::vector<double>{0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
      describe("[x, y, z, r, p, y] pose that becomes the cloud origin. FAST-LIO's camera_init "
               "sits at the IMU pose at init -- roughly 0.3-0.5 m above the floor, and tilted "
               "if the robot was not level -- so the z band is measured from there, not from "
               "the ground, unless this corrects it. Applied on the next load_pcd"));
    declare_parameter(
      "prefilter_leaf_size", 0.0,
      tunableRange("Voxel leaf applied ONCE at load, before filtering [m]. 0 = off. "
                   "RadiusOutlierRemoval is O(n log n) with a large constant, so on a "
                   "million-point map every slider move costs seconds; 0.02-0.03 m is invisible "
                   "at these grid resolutions and cuts that hard. Applied on the next load_pcd",
                   0.0, 1.0));
    declare_parameter(
      "cloud_preview_leaf_size", 0.05,
      tunableRange("Voxel leaf for the preview cloud only [m]. 0 = publish every surviving "
                   "point, which on a large map will exceed the rosbridge message cap",
                   0.0, 1.0));
    declare_parameter(
      "max_map_cells", 25000000,
      tunableIntRange("Refuse to rasterise a grid larger than this many cells. 25M is "
                      "100 x 100 m at 0.02 m, or 250 x 250 m at 0.05 m; one cell is one byte "
                      "on the wire and rosbridge's cap is 50 MB",
                      1000, 200000000));
    declare_parameter(
      "rebuild_debounce_s", 0.3,
      startupOnly("Delay between the last parameter change and the rebuild it triggers [s]"));

    declare_parameter(
      "loaded_pcd", "",
      describe("Map name currently loaded, set by this node on a successful load_pcd. "
               "Informational -- mapping_manager reads it back to record which .pcd a saved "
               "2D map came from"));

    rebuild_debounce_s_ = get_parameter("rebuild_debounce_s").as_double();
    if (rebuild_debounce_s_ <= 0.0) {
      RCLCPP_ERROR(get_logger(), "rebuild_debounce_s must be > 0 (got %.3f); using 0.3",
                   rebuild_debounce_s_);
      rebuild_debounce_s_ = 0.3;
    }
  }

  // Only "~" and "~/..." -- enough for the maps_dir default, and it leaves an absolute path
  // (which is what every launch file passes) completely alone.
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

  void readTunables()
  {
    thre_z_min_ = get_parameter("thre_z_min").as_double();
    thre_z_max_ = get_parameter("thre_z_max").as_double();
    flag_pass_through_ = get_parameter("flag_pass_through").as_bool();
    thre_radius_ = get_parameter("thre_radius").as_double();
    thres_point_count_ = static_cast<int>(get_parameter("thres_point_count").as_int());
    map_resolution_ = get_parameter("map_resolution").as_double();
    cloud_preview_leaf_size_ = get_parameter("cloud_preview_leaf_size").as_double();
    max_map_cells_ = get_parameter("max_map_cells").as_int();
  }

  // -- parameters ------------------------------------------------------------

  // Runs on whichever thread served the set_parameters request, i.e. NOT the rebuild thread.
  // It therefore does the smallest possible amount of work under params_mutex_ and hands the
  // actual rebuild to the timer -- a rebuild can hold state_mutex_ for seconds, and blocking
  // the UI's slider behind it is exactly what this split avoids.
  void onParametersSet(const std::vector<rclcpp::Parameter> & parameters)
  {
    bool rebuild = false;
    {
      std::lock_guard<std::mutex> lock(params_mutex_);
      for (const auto & parameter : parameters) {
        const auto & name = parameter.get_name();
        if (name == "thre_z_min") {
          thre_z_min_ = parameter.as_double();
        } else if (name == "thre_z_max") {
          thre_z_max_ = parameter.as_double();
        } else if (name == "flag_pass_through") {
          flag_pass_through_ = parameter.as_bool();
        } else if (name == "thre_radius") {
          thre_radius_ = parameter.as_double();
        } else if (name == "thres_point_count") {
          thres_point_count_ = static_cast<int>(parameter.as_int());
        } else if (name == "map_resolution") {
          map_resolution_ = parameter.as_double();
        } else if (name == "cloud_preview_leaf_size") {
          cloud_preview_leaf_size_ = parameter.as_double();
        } else if (name == "max_map_cells") {
          max_map_cells_ = parameter.as_int();
        } else {
          // odom_to_lidar_odom, prefilter_leaf_size and loaded_pcd are read at load time.
          continue;
        }
        rebuild = true;
        RCLCPP_INFO(get_logger(), "parameter '%s' changed", name.c_str());
      }
    }

    if (!rebuild) {
      return;
    }
    // Atomic rather than a peek at pcd_cloud_ under state_mutex_, which a running rebuild may
    // be holding for seconds.
    if (!cloud_loaded_.load()) {
      RCLCPP_INFO(get_logger(), "no map loaded yet; the change applies on the next load_pcd");
      return;
    }
    // Restarts the countdown if it was already running, which is what collapses a burst of
    // slider changes into one rebuild.
    rebuild_timer_->reset();
  }

  void rebuildTimerCallback()
  {
    rebuild_timer_->cancel();

    std::lock_guard<std::mutex> lock(state_mutex_);
    if (pcd_cloud_ == nullptr || pcd_cloud_->empty()) {
      return;
    }
    std::string detail;
    // Reported either way, and NOT as "rebuilt" when it failed: rasterise() has already logged
    // the real reason at ERROR, and repeating it under a success word is how a log convinces
    // someone the map updated when the previous one is still latched.
    if (rebuildAndPublish(detail)) {
      RCLCPP_INFO(get_logger(), "rebuilt '%s': %s", loaded_pcd_.c_str(), detail.c_str());
    } else {
      RCLCPP_WARN(get_logger(), "rebuild of '%s' FAILED, previous map kept: %s",
                  loaded_pcd_.c_str(), detail.c_str());
    }
  }

  // -- load ------------------------------------------------------------------

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

    const std::string path = pcd_dir_ + "/" + name + ".pcd";
    const auto t_start = std::chrono::steady_clock::now();

    auto cloud = std::make_shared<CloudT>();
    if (pcl::io::loadPCDFile<PointT>(path, *cloud) == -1) {
      res->success = false;
      res->message = "could not read " + path;
      RCLCPP_ERROR(get_logger(), "%s", res->message.c_str());
      return;
    }
    if (cloud->empty()) {
      res->success = false;
      res->message = path + " contains no points";
      RCLCPP_ERROR(get_logger(), "%s", res->message.c_str());
      return;
    }

    const std::size_t raw_points = cloud->size();
    applyTransform(*cloud);

    const double prefilter_leaf = get_parameter("prefilter_leaf_size").as_double();
    if (prefilter_leaf > 0.0) {
      auto reduced = std::make_shared<CloudT>();
      if (voxelise(cloud, prefilter_leaf, *reduced) && !reduced->empty()) {
        cloud = reduced;
      }
    }

    std::string detail;
    {
      std::lock_guard<std::mutex> lock(state_mutex_);
      pcd_cloud_ = cloud;
      loaded_pcd_ = name;
      cloud_loaded_.store(true);
      // Mirrored onto the parameter so `ros2 param get` answers "which map is this?" without
      // a topic echo. Set before the rebuild, so it is still correct on the failure path
      // below -- the cloud IS loaded there. /flattened_map_info carries the same name, and is
      // what the UI actually reads.
      set_parameter(rclcpp::Parameter("loaded_pcd", name));
      if (!rebuildAndPublish(detail)) {
        // The cloud stays loaded: the failure is a filter/resolution problem, and keeping it
        // means the operator can fix the parameter and get a rebuild without re-reading the
        // file, which is the slow part.
        res->success = false;
        res->message = "loaded " + path + " (" + std::to_string(raw_points) + " pts) but " +
                       detail;
        RCLCPP_ERROR(get_logger(), "%s", res->message.c_str());
        return;
      }
    }

    const double took = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - t_start).count();
    res->success = true;
    res->message = "loaded " + name + ": " + std::to_string(raw_points) + " pts -> " + detail +
                   " in " + std::to_string(took) + " s";
    RCLCPP_INFO(get_logger(), "%s", res->message.c_str());
  }

  // Puts the last built grid on the editor topic, which is VOLATILE and published nowhere else
  // -- so this call is the only way that topic ever carries anything, and a subscriber has to
  // already be listening. Not a rebuild: nothing is re-filtered and the header keeps its
  // original stamp, so an operator reading the stamp still sees when the map was computed.
  //
  // Deliberately NOT republished on map_topic_name_ as well. Lichtblick already holds that
  // topic and its retained sample; pushing the whole grid at it again would cost a multi-MB
  // transfer to redraw something it is already drawing.
  //
  // success: false is the useful answer here, not an error -- "nothing has been flattened yet"
  // is exactly what a UI that has been waiting on an empty topic needs to hear, and it arrives
  // immediately instead of after that UI's own timeout.
  void republishMapCallback(
    const std_srvs::srv::Trigger::Request::SharedPtr,
    std_srvs::srv::Trigger::Response::SharedPtr res)
  {
    nav_msgs::msg::OccupancyGrid grid;
    {
      std::lock_guard<std::mutex> lock(last_grid_mutex_);
      if (!has_grid_) {
        res->success = false;
        res->message = "no map to republish: nothing has been flattened yet, load a pcd first";
        RCLCPP_WARN(get_logger(), "%s", res->message.c_str());
        return;
      }
      grid = last_grid_;
    }

    editor_pub_->publish(grid);
    res->success = true;
    res->message = "republished " + std::to_string(grid.info.width) + "x" +
                   std::to_string(grid.info.height) + " grid at " +
                   std::to_string(grid.info.resolution) + " m on " + editor_topic_name_;
    RCLCPP_INFO(get_logger(), "%s", res->message.c_str());
  }

  // Upstream applies this destructively to the source cloud, so it can only ever be done once
  // and the parameter is startup-only there. Re-loading from disk on every load_pcd means the
  // pose can be retuned between loads without restarting the node.
  void applyTransform(CloudT & cloud)
  {
    const auto pose = get_parameter("odom_to_lidar_odom").as_double_array();
    if (pose.size() != 6) {
      RCLCPP_ERROR(get_logger(),
                   "odom_to_lidar_odom must have 6 elements [x, y, z, r, p, y] (got %zu); "
                   "leaving the cloud untransformed", pose.size());
      return;
    }
    if (std::all_of(pose.begin(), pose.end(), [](double v) { return v == 0.0; })) {
      return;
    }

    Eigen::Affine3f transform = Eigen::Affine3f::Identity();
    transform.translation() << static_cast<float>(pose[0]), static_cast<float>(pose[1]),
      static_cast<float>(pose[2]);
    transform.rotate(Eigen::AngleAxisf(static_cast<float>(pose[3]), Eigen::Vector3f::UnitX()));
    transform.rotate(Eigen::AngleAxisf(static_cast<float>(pose[4]), Eigen::Vector3f::UnitY()));
    transform.rotate(Eigen::AngleAxisf(static_cast<float>(pose[5]), Eigen::Vector3f::UnitZ()));

    pcl::transformPointCloud(cloud, cloud, transform.inverse());
    RCLCPP_INFO(get_logger(), "applied odom_to_lidar_odom [%.3f %.3f %.3f | %.3f %.3f %.3f]",
                pose[0], pose[1], pose[2], pose[3], pose[4], pose[5]);
  }

  // -- filter + rasterise ----------------------------------------------------

  // Snapshot of every tunable, taken once per rebuild. The filters run for seconds and the UI
  // can move a slider mid-run; working off a copy means one rebuild uses one consistent set of
  // thresholds instead of a mix, and keeps params_mutex_ held for microseconds.
  struct Tunables
  {
    double z_min;
    double z_max;
    bool invert;
    double radius;
    int min_neighbours;
    double resolution;
    double preview_leaf;
    std::int64_t max_cells;
  };

  Tunables snapshotTunables() const
  {
    std::lock_guard<std::mutex> lock(params_mutex_);
    return Tunables{thre_z_min_, thre_z_max_, flag_pass_through_, thre_radius_,
                    thres_point_count_, map_resolution_, cloud_preview_leaf_size_,
                    max_map_cells_};
  }

  // Caller must hold state_mutex_. Fills `detail` with a human-readable summary either way.
  bool rebuildAndPublish(std::string & detail)
  {
    const Tunables t = snapshotTunables();

    // Always re-filtered from pcd_cloud_, never from the previous result, so a widened band
    // brings points back instead of only ever removing more.
    CloudT::Ptr sliced(new CloudT);
    pcl::PassThrough<PointT> passthrough;
    passthrough.setInputCloud(pcd_cloud_);
    passthrough.setFilterFieldName("z");
    passthrough.setFilterLimits(t.z_min, t.z_max);
    passthrough.setNegative(t.invert);
    passthrough.filter(*sliced);

    CloudT::Ptr kept(new CloudT);
    if (!sliced->empty()) {
      pcl::RadiusOutlierRemoval<PointT> radius_outlier;
      radius_outlier.setInputCloud(sliced);
      radius_outlier.setRadiusSearch(t.radius);
      radius_outlier.setMinNeighborsInRadius(t.min_neighbours);
      radius_outlier.filter(*kept);
    }

    nav_msgs::msg::OccupancyGrid grid;
    if (!rasterise(kept, t, grid, detail)) {
      // Nothing was published, so the only way anyone learns why is the info topic. Grid
      // dimensions are zeroed because there is no new grid -- the PREVIOUS one is still
      // latched on /flattened_map and still valid.
      publishInfo(sliced->size(), kept->size(), 0, 0, t.resolution, false, detail);
      return false;
    }

    {
      std::lock_guard<std::mutex> lock(last_grid_mutex_);
      last_grid_ = grid;
      has_grid_ = true;
    }
    map_pub_->publish(grid);
    publishPreview(kept, t.preview_leaf);

    detail = std::to_string(sliced->size()) + " in band, " + std::to_string(kept->size()) +
             " after outlier removal, " + detail;
    publishInfo(sliced->size(), kept->size(), grid.info.width, grid.info.height, t.resolution,
                true, "");
    return true;
  }

  // Caller must hold state_mutex_ (loaded_pcd_, suggested_resolution_). Hand-built rather than
  // pulled through a JSON library: the shape is fixed and every field is known here, so the
  // alternative is taking on a dependency to emit one string.
  void publishInfo(
    std::size_t in_band, std::size_t kept, std::uint32_t width, std::uint32_t height,
    double resolution, bool ok, const std::string & message)
  {
    char buf[768];
    std::snprintf(
      buf, sizeof(buf),
      "{\"loaded\":\"%s\",\"in_band\":%zu,\"kept\":%zu,\"width\":%u,\"height\":%u,"
      "\"resolution\":%.6f,\"suggested_resolution\":%.6f,\"ok\":%s,\"message\":\"%s\"}",
      jsonEscape(loaded_pcd_).c_str(), in_band, kept, width, height, resolution,
      suggested_resolution_, ok ? "true" : "false", jsonEscape(message).c_str());

    std_msgs::msg::String msg;
    msg.data = buf;
    info_pub_->publish(msg);
  }

  bool rasterise(
    const CloudT::Ptr & cloud, const Tunables & t, nav_msgs::msg::OccupancyGrid & msg,
    std::string & detail)
  {
    msg.header.stamp = now();
    msg.header.frame_id = map_frame_id_;
    msg.info.map_load_time = msg.header.stamp;
    msg.info.resolution = static_cast<float>(t.resolution);
    msg.info.origin.orientation.w = 1.0;

    // Cleared per attempt, so the info topic never advertises a stale remedy for a cell-cap
    // failure that has since been fixed.
    suggested_resolution_ = 0.0;

    if (cloud->empty()) {
      // Publish an empty grid rather than bailing out: leaving the previous map in place would
      // make an over-aggressive threshold look like the change simply did nothing.
      RCLCPP_WARN(get_logger(), "nothing survives the current filters; publishing an empty map");
      msg.info.width = 0;
      msg.info.height = 0;
      msg.data.clear();
      detail = "empty grid";
      return true;
    }

    PointT min_p, max_p;
    pcl::getMinMax3D(*cloud, min_p, max_p);
    const double x_min = min_p.x;
    const double y_min = min_p.y;
    const double span_x = static_cast<double>(max_p.x) - x_min;
    const double span_y = static_cast<double>(max_p.y) - y_min;

    // Computed in int64 BEFORE the assign: map_resolution is UI-tunable, and 0.02 m over a
    // 200 m site is 1e8 cells -- a 100 MB message that would blow straight past rosbridge's
    // 50 MB cap (max_message_size in operation.launch.py) and allocate 100 MB per rebuild.
    const auto width = static_cast<std::int64_t>(std::ceil(span_x / t.resolution));
    const auto height = static_cast<std::int64_t>(std::ceil(span_y / t.resolution));
    const std::int64_t cells = width * height;
    if (cells > t.max_cells) {
      const double min_res = std::sqrt(span_x * span_y / static_cast<double>(t.max_cells));
      // Surfaced as a number on the info topic, not just inside the prose below: with
      // map_resolution hidden from the UI by default, this value IS the operator's way out,
      // and making them parse it back out of an error string would be silly.
      suggested_resolution_ = min_res;
      detail = "grid would be " + std::to_string(width) + " x " + std::to_string(height) +
               " = " + std::to_string(cells) + " cells (max " + std::to_string(t.max_cells) +
               "); raise map_resolution to at least " + std::to_string(min_res) + " m";
      RCLCPP_ERROR(get_logger(),
                   "map_resolution %.4f m over a %.1f x %.1f m map: %s. Keeping the previous "
                   "map.", t.resolution, span_x, span_y, detail.c_str());
      return false;
    }

    msg.info.origin.position.x = x_min;
    msg.info.origin.position.y = y_min;
    msg.info.width = static_cast<std::uint32_t>(width);
    msg.info.height = static_cast<std::uint32_t>(height);
    msg.data.assign(static_cast<std::size_t>(cells), 0);

    // int64 throughout: upstream compared an `int` index against `msg.info.width` (uint32),
    // which both warns under -Wall -Wextra and sign-converts.
    for (const auto & point : cloud->points) {
      const auto i = static_cast<std::int64_t>(std::floor((point.x - x_min) / t.resolution));
      const auto j = static_cast<std::int64_t>(std::floor((point.y - y_min) / t.resolution));
      if (i >= 0 && i < width && j >= 0 && j < height) {
        msg.data[static_cast<std::size_t>(i + j * width)] = 100;
      }
    }

    detail = std::to_string(width) + " x " + std::to_string(height) + " cells at " +
             std::to_string(t.resolution) + " m";
    return true;
  }

  // The grid is the real output; this is the tuning aid -- it shows in 3D exactly which slab of
  // the cloud became occupied cells. Voxelised because the surviving points can still be
  // hundreds of megabytes on a large map, and this goes over the same bridge as the grid.
  void publishPreview(const CloudT::Ptr & cloud, double preview_leaf)
  {
    CloudT::Ptr out = cloud;
    if (preview_leaf > 0.0 && !cloud->empty()) {
      CloudT::Ptr reduced(new CloudT);
      if (voxelise(cloud, preview_leaf, *reduced) && !reduced->empty()) {
        out = reduced;
      }
    }

    out->width = static_cast<std::uint32_t>(out->size());
    out->height = 1;
    out->is_dense = true;

    sensor_msgs::msg::PointCloud2 msg;
    pcl::toROSMsg(*out, msg);
    msg.header.stamp = now();
    msg.header.frame_id = map_frame_id_;
    cloud_pub_->publish(msg);
  }

  // PCL's VoxelGrid does NOT error when the leaf is too small for the cloud's extent --
  // voxel_grid.hpp:248-258 emits a PCL_WARN and then does `output = *input_; return;`, i.e. it
  // passes the cloud through COMPLETELY UNFILTERED. Same trap map_downsampler_node guards
  // against; replicate the check rather than silently shipping the full cloud.
  bool voxelise(const CloudT::ConstPtr & in, double leaf, CloudT & out)
  {
    PointT min_p, max_p;
    pcl::getMinMax3D(*in, min_p, max_p);

    const double inv = 1.0 / leaf;
    const auto dx = static_cast<std::int64_t>((max_p.x - min_p.x) * inv) + 1;
    const auto dy = static_cast<std::int64_t>((max_p.y - min_p.y) * inv) + 1;
    const auto dz = static_cast<std::int64_t>((max_p.z - min_p.z) * inv) + 1;
    if (dx * dy * dz > static_cast<std::int64_t>(std::numeric_limits<std::int32_t>::max())) {
      const double ex = max_p.x - min_p.x;
      const double ey = max_p.y - min_p.y;
      const double ez = max_p.z - min_p.z;
      RCLCPP_ERROR(get_logger(),
                   "leaf %.4f m is too small for a %.1f x %.1f x %.1f m cloud: PCL would pass "
                   "it through UNFILTERED. Skipping this voxel pass; use >= %.3f m.",
                   leaf, ex, ey, ez,
                   std::cbrt(ex * ey * ez /
                             static_cast<double>(std::numeric_limits<std::int32_t>::max())));
      return false;
    }

    pcl::VoxelGrid<PointT> vg;
    vg.setInputCloud(in);
    vg.setLeafSize(static_cast<float>(leaf), static_cast<float>(leaf), static_cast<float>(leaf));
    vg.filter(out);
    return true;
  }

  // -- state -----------------------------------------------------------------

  std::string maps_dir_;
  std::string pcd_dir_;
  std::string map_topic_name_;
  std::string cloud_topic_name_;
  std::string info_topic_name_;
  std::string editor_topic_name_;
  std::string map_frame_id_;

  // Written by the parameter callback, read by the rebuild thread -- guarded by params_mutex_
  // and only ever copied out wholesale via snapshotTunables().
  mutable std::mutex params_mutex_;
  double thre_z_min_{0.1};
  double thre_z_max_{1.45};
  bool flag_pass_through_{false};
  double thre_radius_{0.1};
  int thres_point_count_{10};
  double map_resolution_{0.02};
  double cloud_preview_leaf_size_{0.05};
  std::int64_t max_map_cells_{25000000};

  double rebuild_debounce_s_{0.3};  // read once at construction

  // The loaded cloud and its name. Held for the whole of a rebuild, which is why the
  // parameter path never touches it.
  std::mutex state_mutex_;
  CloudT::Ptr pcd_cloud_;
  std::string loaded_pcd_;
  std::atomic<bool> cloud_loaded_{false};
  // Set by rasterise when the cell cap is hit, reported on the info topic. 0 = not applicable.
  double suggested_resolution_{0.0};

  rclcpp::CallbackGroup::SharedPtr service_group_;
  rclcpp::CallbackGroup::SharedPtr rebuild_group_;
  // Copy of the last grid handed to map_pub_, so ~/republish_map can put it back on the wire
  // without re-running the filters. Its own mutex rather than state_mutex_: that one is held
  // for the whole of a rebuild, and a republish asked for mid-rebuild should answer with the
  // map that is on the topic right now instead of blocking for seconds.
  std::mutex last_grid_mutex_;
  nav_msgs::msg::OccupancyGrid last_grid_;
  bool has_grid_{false};

  rclcpp::Service<tmms_msgs::srv::StringTrigger>::SharedPtr load_srv_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr republish_srv_;
  rclcpp::Publisher<nav_msgs::msg::OccupancyGrid>::SharedPtr map_pub_;
  rclcpp::Publisher<nav_msgs::msg::OccupancyGrid>::SharedPtr editor_pub_;
  rclcpp::Publisher<sensor_msgs::msg::PointCloud2>::SharedPtr cloud_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr info_pub_;
  rclcpp::TimerBase::SharedPtr rebuild_timer_;
  rclcpp::node_interfaces::PostSetParametersCallbackHandle::SharedPtr post_set_params_handle_;
};

}  // namespace lidar_converter

int main(int argc, char ** argv)
{
  rclcpp::init(argc, argv);
  // Multi-threaded so a multi-second rebuild cannot stall the load service or the parameter
  // services the UI drives. See the callback-group comment in the constructor.
  auto node = std::make_shared<lidar_converter::MapFlattenerNode>();
  rclcpp::executors::MultiThreadedExecutor executor(rclcpp::ExecutorOptions(), 3);
  executor.add_node(node);
  executor.spin();
  rclcpp::shutdown();
  return 0;
}
