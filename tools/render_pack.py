#!/usr/bin/env python3
"""Render Sortie!'s voice pack from the VOX table in the game source.

The game's `VOX` object is the single source of truth: this reads it straight out of
index.html, so the pack can never list a line the game does not speak, or miss one it does.

Each clip gets the *transmitter* half of the radio chain only -- equipment character, baked in
and deterministic. The link half (fading, dropouts, hiss, squelch) happens at runtime in Web
Audio, once per transmission rather than once per clip, because a line like "Three Lancers
inbound. Off your port bow." is two clips and should not have a squelch burst in the middle.

Mood maps onto delivery the same way the browser's speech synthesis used it: `rate` becomes
piper's --length-scale (inverted, since length is the reciprocal of speed) and `pitch` becomes
a rubberband shift. That is what keeps urgent and grave distinguishable once they are files.

Usage
    render_pack.py [--quality weak] [--out DIR] [--only ID[,ID...]] [--jobs N]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import os
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GAME = Path(os.environ.get("SORTIE_GAME", HERE.parent / "index.html"))
# The voice model is ~64 MB and freely downloadable, so it is not in the repo. See tools/README.md.
MODEL = Path(os.environ.get("PIPER_MODEL", HERE / "models" / "en_GB-cori-medium.onnx"))
# Whatever interpreter is running this script -- piper is imported as a module, so there is no
# need to hardcode a virtualenv path.
PIPER = Path(sys.executable)

# Lifted from the game's MOOD table, so the files inherit the delivery the game already chose.
MOOD = {
    "calm":   {"rate": 0.98, "pitch": 1.04},
    "brisk":  {"rate": 1.08, "pitch": 1.10},
    "urgent": {"rate": 1.17, "pitch": 1.22},
    "alarm":  {"rate": 1.24, "pitch": 1.32},
    "warm":   {"rate": 0.97, "pitch": 1.16},
    "grave":  {"rate": 0.88, "pitch": 0.94},
}

_spec = importlib.util.spec_from_file_location("radio", HERE / "radio.py")
radio = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(radio)


def read_vox(path: Path) -> dict[str, tuple[str, str]]:
    """Pull `'id': ['text', 'mood'],` lines out of the game's VOX table."""
    src = path.read_text(encoding="utf-8")
    block = re.search(r"const VOX = \{(.*?)\n\};", src, re.S)
    if not block:
        raise SystemExit(f"{path}: could not find the VOX table")
    out = {}
    for cid, text, mood in re.findall(r"'([a-z0-9-]+)':\s*\['((?:[^'\\]|\\.)*)',\s*'(\w+)'\]",
                                      block.group(1)):
        if mood not in MOOD:
            raise SystemExit(f"{cid}: unknown mood {mood!r}")
        out[cid] = (text.replace("\\'", "'"), mood)
    return out


def _probe_dur(path: Path) -> float:
    """Duration of a clip this run did not render, so the manifest can still describe it."""
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return round(float(r.stdout.strip()), 3)
    except ValueError:
        return 0.0


def run(cmd: list[str], stdin: str | None = None) -> None:
    r = subprocess.run(cmd, input=stdin, text=True, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {r.stderr.strip()[:300]}")


def trim(x, thresh: float = 0.012):
    """Strip piper's leading and trailing padding -- that padding is the gap you hear on a join."""
    import numpy as np
    w = int(0.005 * radio.SR)
    env = np.convolve(np.abs(x), np.ones(w) / w, "same")
    idx = np.flatnonzero(env > thresh)
    return x[idx[0]:idx[-1] + 1] if idx.size else x


def render_one(cid: str, text: str, mood: str, quality: str, out: Path, tmp: Path) -> dict:
    m = MOOD[mood]
    raw, pitched = tmp / f"{cid}.raw.wav", tmp / f"{cid}.pitch.wav"
    baked, mp3 = tmp / f"{cid}.baked.wav", out / f"{cid}.mp3"

    run([str(PIPER), "-m", "piper", "-m", str(MODEL),
         "--length-scale", f"{1.0 / m['rate']:.4f}",
         "--noise-scale", "0.6", "--noise-w-scale", "0.8",
         "-f", str(raw)], stdin=text)
    run(["ffmpeg", "-y", "-v", "error", "-i", str(raw),
         "-af", f"rubberband=pitch={m['pitch']}", "-ar", str(radio.SR), "-ac", "1", str(pitched)])

    x = trim(radio.read_wav(str(pitched)))
    radio.write_wav(str(baked), radio.transmitter(x, radio.QUALITY[quality]))

    run(["ffmpeg", "-y", "-v", "error", "-i", str(baked),
         "-c:a", "libmp3lame", "-b:a", "48k", "-ar", str(radio.SR), "-ac", "1", str(mp3)])
    for f in (raw, pitched, baked):
        f.unlink(missing_ok=True)
    return {"id": cid, "text": text, "mood": mood,
            "dur": round(len(x) / radio.SR, 3), "bytes": mp3.stat().st_size}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quality", default="weak", choices=sorted(radio.QUALITY))
    ap.add_argument("--out", default="/home/ubuntu/sortie/assets/vox")
    ap.add_argument("--only", default="")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()

    vox = read_vox(GAME)
    if a.only:
        want = set(a.only.split(","))
        vox = {k: v for k, v in vox.items() if k in want}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = HERE / "build" / "pack"
    tmp.mkdir(parents=True, exist_ok=True)

    print(f"rendering {len(vox)} clips at quality={a.quality} -> {out}")
    rows, failed = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.jobs) as ex:
        futs = {ex.submit(render_one, cid, t, m, a.quality, out, tmp): cid
                for cid, (t, m) in sorted(vox.items())}
        for i, f in enumerate(concurrent.futures.as_completed(futs), 1):
            cid = futs[f]
            try:
                rows.append(f.result())
            except Exception as exc:  # noqa: BLE001
                failed.append((cid, str(exc)[:160]))
                print(f"  [{i}/{len(futs)}] FAIL {cid}: {str(exc)[:160]}", file=sys.stderr)
            else:
                print(f"  [{i}/{len(futs)}] {cid}")

    rows.sort(key=lambda r: r["id"])
    total = sum(r["bytes"] for r in rows)

    # The manifest must list every clip on disk, not just the ones this run produced. Writing
    # only `rows` meant a `--only` render silently orphaned the rest of the pack: the files were
    # still there, but the game loads from the manifest, so everything missing from it fell back
    # to speech synthesis. Rebuild it from the VOX table intersected with what is actually on
    # disk, which is correct whether this was a full render or a single line.
    full = read_vox(GAME)
    clips = {}
    for cid, (_text, _mood) in sorted(full.items()):
        mp3 = out / f"{cid}.mp3"
        if not mp3.is_file():
            continue
        fresh = next((r for r in rows if r["id"] == cid), None)
        clips[cid] = {"dur": fresh["dur"]} if fresh else {"dur": _probe_dur(mp3)}
    manifest = {
        "quality": a.quality,
        "voice": "piper en_GB-cori-medium (public domain, trained from scratch)",
        "format": "mp3 48kbps mono 22050Hz, transmitter-processed; link simulated at runtime",
        "clips": clips,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    missing = sorted(set(full) - set(clips))
    if missing:
        print(f"note: {len(missing)} VOX line(s) have no clip yet: {missing[:6]}"
              f"{'...' if len(missing) > 6 else ''}")
    print(f"manifest lists {len(clips)} clip(s)")
    print(f"\n{len(rows)} clips, {total / 1024:.0f} KiB total, "
          f"{total / max(len(rows), 1) / 1024:.1f} KiB average")
    if failed:
        print(f"{len(failed)} FAILED: {[c for c, _ in failed]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
