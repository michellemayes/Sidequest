"""frames/ + manifest.json -> demo.gif, each frame held for its own duration.

Frames are captured at 2x (2560 wide) and scaled down to WIDTH (default 1440:
sharp on a retina README, under 3 MB for the whole run) with COLORS (default
128) palette entries.

Needs ffmpeg on PATH, or FFMPEG=/path/to/ffmpeg. If yours lacks one:
    pip install imageio-ffmpeg
    FFMPEG=$(python3 -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())') python3 docs/demo/make_gif.py

One palette is built from every frame, so the Slack and terminal colours both
survive quantisation. No dithering: this is flat UI and text, where dither only
adds noise that changes from frame to frame and inflates the file.
"""
import json
import os
import subprocess
from pathlib import Path

here = Path(__file__).parent
frames = here / "frames"
manifest = json.loads((frames / "manifest.json").read_text())
width = int(os.environ.get("WIDTH", "1440"))
dither = os.environ.get("DITHER", "none")
colors = int(os.environ.get("COLORS", "128"))

concat = frames / "concat.txt"
lines = []
for f in manifest:
    lines += [f"file '{f['file']}'", f"duration {f['ms'] / 1000:.3f}"]
lines.append(f"file '{manifest[-1]['file']}'")  # the concat demuxer drops the last duration otherwise
concat.write_text("\n".join(lines) + "\n")

ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
scale = f"scale={width}:-1:flags=lanczos"
subprocess.run([
    ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat),
    "-vf", f"{scale},split[a][b];[a]palettegen=max_colors={colors}:stats_mode=full[p];"
           f"[b][p]paletteuse=dither={dither}:diff_mode=rectangle",
    "-fps_mode", "vfr", str(here / "demo.gif"),
], check=True)
total = sum(f["ms"] for f in manifest) / 1000
print(f"{len(manifest)} frames, {total:.1f}s ->", (here / "demo.gif").stat().st_size // 1024, "KB")
