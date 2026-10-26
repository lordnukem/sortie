#!/usr/bin/env python3
"""Bake the world outline used by stats.html and admin.html into assets/world.js.

The map has to draw without fetching anything at runtime, so the outline is simplified here
and embedded as one SVG path. Source is Natural Earth 1:110m land, which is public domain.

    python3 tools/build-world.py            # fetches and rebuilds assets/world.js
"""
import json, math, os, sys, urllib.request

SRC = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson'
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'world.js')
EPS = 0.6        # simplification tolerance, in degrees
MIN_AREA = 6     # drop rings whose bounding box is smaller than this many square degrees


def rdp(pts, eps):
    """Ramer-Douglas-Peucker. Iterative stack rather than recursion: some rings are long
    enough to blow the default recursion limit."""
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = pts[lo]
        bx, by = pts[hi]
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        dmax, idx = 0.0, lo
        for i in range(lo + 1, hi):
            x, y = pts[i]
            if span == 0:
                d = math.hypot(x - ax, y - ay)
            else:
                t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / span))
                d = math.hypot(x - (ax + t * dx), y - (ay + t * dy))
            if d > dmax:
                dmax, idx = d, i
        if dmax > eps:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))
    return [p for p, k in zip(pts, keep) if k]


def main():
    with urllib.request.urlopen(SRC, timeout=60) as r:
        src = json.load(r)
    paths = []
    for f in src['features']:
        g = f['geometry']
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        for poly in polys:
            # Equirectangular into a 360x180 viewBox, y down.
            pts = [(round(x + 180, 1), round(90 - y, 1)) for x, y in poly[0]]
            pts = rdp(pts, EPS)
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            if len(pts) < 4 or (max(xs) - min(xs)) * (max(ys) - min(ys)) < MIN_AREA:
                continue
            paths.append('M' + 'L'.join(f'{x} {y}' for x, y in pts) + 'Z')
    d = ''.join(paths)
    with open(OUT, 'w', encoding='utf-8') as out:
        out.write('// Natural Earth 1:110m land outline (public domain, naturalearthdata.com), simplified with\n')
        out.write('// Ramer-Douglas-Peucker and projected equirectangular into a 360x180 viewBox, y down. Baked in\n')
        out.write('// at build time by tools/build-world.py so the page fetches nothing at runtime.\n')
        out.write(f'window.__WORLD = "{d}";\n')
    print(f'{len(paths)} rings, {len(d)} path characters -> {OUT}')


if __name__ == '__main__':
    sys.exit(main())
