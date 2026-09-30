"""frames/*.png -> demo.gif. Holds the first and last frames longer."""
from pathlib import Path
from PIL import Image

here = Path(__file__).parent
paths = sorted((here / "frames").glob("*.png"))
frames = [Image.open(p).convert("RGB") for p in paths]
# Captured at 2x; the GIF is 1x to stay small.
frames = [f.resize((f.width // 2, f.height // 2), Image.LANCZOS) for f in frames]
pal = frames[-1].quantize(colors=256, method=Image.Quantize.MEDIANCUT)
frames = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
durations = [70] * len(frames)
durations[-1] = 2500
frames[0].save(here / "demo.gif", save_all=True, append_images=frames[1:],
               duration=durations, loop=0, optimize=True, disposal=1)
print(len(frames), "frames ->", (here / "demo.gif").stat().st_size // 1024, "KB")
