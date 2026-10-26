#!/usr/bin/env python3
"""Build the whole icon set from tools/icon-source.png.

    python3 tools/build-icons.py

The master is a 1024px render of the fighter. Two treatments come out of it:

* **Favicon sizes (16/32/48/64)** use a tighter square crop around the hull. The ship fills
  under half the master frame, which is right for a home-screen tile and far too timid at 16px —
  uncropped it reads as a smudge. A light unsharp pass after the downscale puts back the edge
  that resampling costs.
* **Tiles (180/192/512)** keep the full composition, because at that size the nebula and the
  stars are the point.

The maskable variant insets the art inside the middle 80%: Android crops app icons to whatever
shape the launcher prefers, and anything in the outer fifth may simply not be there.
"""
import os
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'icon-source.png')
OUT = os.path.join(HERE, '..', 'assets', 'icon')
ROOT = os.path.join(HERE, '..', 'favicon.ico')
CROP = (118, 170, 906, 958)      # 788px square around the hull, engine glow kept
MASK_BG = (10, 8, 26, 255)       # the art's own near-black violet, for the maskable ground


def save(im, size, path, sharpen=0):
    r = im.resize((size, size), Image.LANCZOS)
    if sharpen:
        r = r.filter(ImageFilter.UnsharpMask(radius=1, percent=sharpen, threshold=1))
    r.save(path, optimize=True)
    return r


def main():
    src = Image.open(SRC).convert('RGBA')
    tight = src.crop(CROP)
    os.makedirs(OUT, exist_ok=True)

    for size, sharpen in ((16, 140), (32, 120), (64, 90)):
        save(tight, size, os.path.join(OUT, f'ship-{size}.png'), sharpen)
    ico = save(tight, 48, os.path.join(OUT, 'ship-48.tmp.png'), 110)
    ico.save(os.path.join(OUT, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
    os.remove(os.path.join(OUT, 'ship-48.tmp.png'))

    save(src, 180, os.path.join(OUT, 'apple-touch-icon.png'), 60)
    save(src, 192, os.path.join(OUT, 'ship-192.png'), 60)
    save(src, 512, os.path.join(OUT, 'ship-512.png'))

    pad = Image.new('RGBA', (512, 512), MASK_BG)
    inner = src.resize((410, 410), Image.LANCZOS)
    pad.paste(inner, (51, 51), inner)
    pad.save(os.path.join(OUT, 'ship-maskable.png'), optimize=True)

    # Browsers ask for /favicon.ico whatever the page says, so it is kept at the root too.
    Image.open(os.path.join(OUT, 'favicon.ico')).save(ROOT, sizes=[(16, 16), (32, 32), (48, 48)])

    for f in sorted(os.listdir(OUT)):
        print(f'{f:<24} {os.path.getsize(os.path.join(OUT, f)) // 1024} KB')


if __name__ == '__main__':
    main()
