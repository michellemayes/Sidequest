"""frames/ + manifest.json -> demo.gif at full capture resolution (2x), each
frame held for its own duration.

Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg). The palette is built from
every frame, so the Slack and terminal colours both survive quantisation.
"""
import json
import os
import subprocess
from pathlib import Path

here = Path(__file__).parent
frames = here / "frames"
manifest = json.loads((frames / "manifest.json").read_text())
width = int(os.environ.get("WIDTH", "2560"))

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
    "-vf", f"{scale},split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];"
           f"[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
    "-vsync", "vfr", str(here / "demo.gif"),
], check=True)
print(len(manifest), "frames ->", (here / "demo.gif").stat().st_size // 1024, "KB")
