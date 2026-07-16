import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from mcap_ros2.reader import read_ros2_messages

# The last entry's `duration` directive is ignored by ffmpeg's concat
# demuxer, so the true last frame is listed twice to make its duration
# take effect.
_MIN_DURATION_SECONDS = 1e-3


def main():
    input_mcap, topic, output_mp4 = sys.argv[1], sys.argv[2], sys.argv[3]

    frames_dir = Path(tempfile.mkdtemp(prefix='mcap_to_mp4_'))
    try:
        messages = sorted(
            read_ros2_messages(input_mcap, topics=[topic]),
            key=lambda m: m.log_time_ns)

        if not messages:
            print(f'[mcap_to_mp4] no messages found on topic {topic} in {input_mcap}', file=sys.stderr)
            sys.exit(1)

        frame_paths = []
        for i, msg in enumerate(messages):
            frame_path = frames_dir / f'frame_{i:05d}.jpg'
            frame_path.write_bytes(msg.ros_msg.data)
            frame_paths.append(frame_path)

        concat_list_path = frames_dir / 'concat_list.txt'
        with open(concat_list_path, 'w') as f:
            for i, frame_path in enumerate(frame_paths):
                if i + 1 < len(messages):
                    duration = max(
                        (messages[i + 1].log_time_ns - messages[i].log_time_ns) / 1e9,
                        _MIN_DURATION_SECONDS)
                else:
                    duration = _MIN_DURATION_SECONDS
                f.write(f"file '{frame_path.name}'\n")
                f.write(f'duration {duration}\n')
            # Repeat the last frame so its duration isn't dropped.
            f.write(f"file '{frame_paths[-1].name}'\n")

        result = subprocess.run(
            ['ffmpeg', '-f', 'concat', '-safe', '0', '-i', str(concat_list_path),
             '-vsync', 'vfr', '-pix_fmt', 'yuv420p', '-y', output_mp4],
            cwd=frames_dir, capture_output=True, text=True)

        if result.returncode != 0:
            print(f'[mcap_to_mp4] ffmpeg failed: {result.stderr}', file=sys.stderr)
            sys.exit(1)

        print(f'[mcap_to_mp4] wrote {output_mp4} ({len(messages)} frames)')
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
