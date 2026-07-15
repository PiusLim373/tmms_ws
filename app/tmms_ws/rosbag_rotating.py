import os
import re
import shutil
import time
from datetime import datetime

from mcap.reader import make_reader

# Host-side paths (this script runs from the host's cron, not inside the
# tmms_run container -- same physical files as the container's
# /home/htxgrrt/.htxgrrt/bags/... via the compose bind mount).
ONGOING_DIR = '/home/unitree/.htxgrrt/bags/ongoing_rosbags'
DONE_DIR = '/home/unitree/.htxgrrt/bags/rosbags'

TIMESTAMP_FMT = '%Y_%m_%d-%H_%M_%S'

# Wait this long after a file's last write before moving it, as
# defense-in-depth against a filesystem-flush race right at rollover.
MIN_AGE_SECONDS = 5

# Archive folder size cap; oldest .mcap files are deleted first once
# exceeded.
MAX_ROSBAGS_BYTES = 200 * 1024 ** 3

# ros2 bag record (mcap storage) names split files "<bag_folder>_<N>.mcap",
# incrementing N each time --max-bag-size forces a rollover to a new file.
_MCAP_RE = re.compile(r'^(?P<prefix>.+)_(?P<index>\d+)\.mcap$')


def _finalized_start_time(mcap_path):
    try:
        with open(mcap_path, 'rb') as f:
            summary = make_reader(f).get_summary()
            if summary and summary.statistics and summary.statistics.message_start_time:
                return summary.statistics.message_start_time
    except Exception as exc:
        print(f'[rosbag_rotating] summary read failed for {mcap_path}: {exc}')

    try:
        with open(mcap_path, 'rb') as f:
            for _, _, message in make_reader(f).iter_messages():
                return message.log_time
    except Exception as exc:
        print(f'[rosbag_rotating] streaming read failed for {mcap_path}: {exc}')

    return None


def _unique_destination(dst):
    if not os.path.exists(dst):
        return dst
    root, ext = os.path.splitext(dst)
    n = 1
    while os.path.exists(f'{root}_{n}{ext}'):
        n += 1
    return f'{root}_{n}{ext}'


def _move_chunk(src):
    if time.time() - os.path.getmtime(src) < MIN_AGE_SECONDS:
        return False

    start_ns = _finalized_start_time(src)
    if start_ns is not None:
        start_dt = datetime.fromtimestamp(start_ns / 1e9)
        new_name = 'tmms_' + start_dt.strftime(TIMESTAMP_FMT) + '.mcap'
    else:
        print(f'[rosbag_rotating] no start time recoverable for {src}, keeping original name')
        new_name = os.path.basename(src)

    dst = _unique_destination(os.path.join(DONE_DIR, new_name))
    shutil.move(src, dst)
    print(f'[rosbag_rotating] moved {src} -> {dst}')
    return True


def rotate_bags():
    os.makedirs(DONE_DIR, exist_ok=True)

    if not os.path.isdir(ONGOING_DIR):
        return

    folders = sorted(
        e for e in os.listdir(ONGOING_DIR)
        if e.startswith('tmms_') and os.path.isdir(os.path.join(ONGOING_DIR, e)))
    if not folders:
        return

    current, old_folders = folders[-1], folders[:-1]

    # Every folder but the newest can only exist if the recording that
    # wrote it has already stopped (cleanly or via crash) -- a new
    # ros2 bag record process wouldn't be running otherwise. Safe to
    # drain entirely and discard once empty.
    for name in old_folders:
        bag_dir = os.path.join(ONGOING_DIR, name)
        for mcap_name in sorted(f for f in os.listdir(bag_dir) if f.endswith('.mcap')):
            _move_chunk(os.path.join(bag_dir, mcap_name))
        if not any(f.endswith('.mcap') for f in os.listdir(bag_dir)):
            shutil.rmtree(bag_dir)
            print(f'[rosbag_rotating] removed {bag_dir}')

    # Within the current (still recording) folder, split files are
    # numbered sequentially -- anything below the highest index present
    # has already been rolled past and closed. Never touch the highest.
    bag_dir = os.path.join(ONGOING_DIR, current)
    indexed = sorted(
        (int(m.group('index')), name)
        for name in os.listdir(bag_dir)
        for m in [_MCAP_RE.match(name)]
        if m and m.group('prefix') == current)
    for _, name in indexed[:-1]:
        _move_chunk(os.path.join(bag_dir, name))


def enforce_size_limit():
    mcap_files = sorted(
        f for f in os.listdir(DONE_DIR) if f.endswith('.mcap'))

    total_bytes = sum(
        os.path.getsize(os.path.join(DONE_DIR, f)) for f in mcap_files)

    for f in mcap_files:
        if total_bytes <= MAX_ROSBAGS_BYTES:
            break
        path = os.path.join(DONE_DIR, f)
        total_bytes -= os.path.getsize(path)
        os.remove(path)
        print(f'[rosbag_rotating] deleted {path} (over {MAX_ROSBAGS_BYTES} byte cap)')


if __name__ == '__main__':
    rotate_bags()
    enforce_size_limit()
