#!/usr/bin/env python3
"""Bring an outside sound effect into Sortie!'s pack, on the pack's own terms.

WHY THIS EXISTS
    Everything else in `assets/sfx/` is rendered by `sfx_render.py`, so it is loud enough,
    dry enough and trimmed by construction. A downloaded clip is none of those things. Measured
    across the two Kenney CC0 packs: every clip peaks between 0.87 and 1.00, while a full
    rendered explosion peaks at 0.42 -- drop one in untouched and it is seven decibels louder
    than the loudest thing in the game. Several also carry real pre-roll (`maximize_005` has
    237 ms of it), and in an arcade shooter a quarter-second between the pickup and the chime
    reads as the game being slow, not the sound being long.

    So every import goes through the same four steps, and the ledger records that it did:
      trim to the first transient  ->  mono 44.1 kHz  ->  -18 LUFS / -1.5 dBFS  ->  64 kbps mp3

PROVENANCE IS THE POINT
    `imported.json` is the single source of truth for anything in the pack that this project
    did not make. It is what `ATTRIBUTION.md` is generated from, so the credits cannot drift
    from the files the way a hand-maintained list would. A CC BY clip with no ledger entry is a
    licence breach waiting to be noticed; the ledger makes the entry a precondition of the
    import rather than a thing to remember afterwards.

Usage
    import_sfx.py --from DIR            # DIR holds the unpacked source libraries
    import_sfx.py --from DIR --audition # also render the current synth-level reference, no install
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LEDGER = HERE / "imported.json"        # confirmed picks, and what ATTRIBUTION.md is built from
CANDIDATES = HERE / "candidates.json"  # shortlist to listen to; nothing here is installed
SR = 44100          # matches sfx_render.py; the voice pack is 22050 and separate
LUFS = -18.0        # integrated target, so imports sit under the rendered explosions
PEAK = -1.5         # dBFS ceiling, leaving the master limiter something to do
ONSET = 0.10        # fraction of peak envelope that counts as "the sound has started"
RMS_TARGET = -20.0  # dBFS, the stand-in target for clips too short to have an integrated loudness


def run(cmd: list[str]) -> bytes:
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {r.stderr.decode()[:300]}")
    return r.stdout


def onset_seconds(src: Path) -> float:
    """Where the sound actually starts, so the trim is measured rather than guessed."""
    import numpy as np
    import io
    import wave
    raw = run(["ffmpeg", "-v", "error", "-i", str(src), "-ac", "1", "-ar", str(SR), "-f", "wav", "-"])
    with wave.open(io.BytesIO(raw)) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float64) / 32768
    if x.size < 64:
        return 0.0
    env = np.convolve(np.abs(x), np.ones(int(0.01 * SR)) / (0.01 * SR), "same")
    i = int(np.argmax(env > env.max() * ONSET))
    # Leave a couple of milliseconds, so the trim never clips the attack itself.
    return max(0.0, (i - int(0.002 * SR)) / SR)


def load(src: Path, start: float = 0.0):
    import io as _io
    import wave
    import numpy as np
    raw = run(["ffmpeg", "-v", "error", "-ss", f"{start:.4f}", "-i", str(src),
               "-ac", "1", "-ar", str(SR), "-f", "wav", "-"])
    with wave.open(_io.BytesIO(raw)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float64) / 32768


def measure_lufs(src: Path, start: float) -> float | None:
    """Integrated loudness, or None when the clip is too short for one to mean anything.

    loudnorm gates on 400 ms blocks above a relative threshold, so a 139 ms UI blip has no
    integrated loudness at all and the filter reports -inf. Half the interface pack is that
    short, so this has to degrade rather than fail.
    """
    probe = subprocess.run(
        ["ffmpeg", "-v", "info", "-ss", f"{start:.4f}", "-i", str(src), "-ac", "1",
         "-ar", str(SR), "-af", f"loudnorm=I={LUFS}:TP={PEAK}:print_format=json",
         "-f", "null", "-"], capture_output=True).stderr.decode()
    m = re.search(r"\{[^{}]*input_i[^{}]*\}", probe, re.S)
    if not m:
        return None
    try:
        v = float(json.loads(m.group(0))["input_i"])
    except (ValueError, KeyError, TypeError):
        return None
    return v if v > -99 else None


def convert(src: Path, dst: Path) -> dict:
    """Trim, downmix, normalise, encode. Returns what was done, for the ledger.

    One linear gain, decided two ways. Where an integrated measurement exists it is used, so an
    import lands at the same perceived level as the rest of the pack. Where it does not, RMS
    over the part of the clip that is actually sounding stands in -- cruder, but a short blip
    has little dynamic range for K-weighting to disagree about. Either way the gain is then
    pulled back if it would breach the peak ceiling, because a reward chime that clips is worse
    than one that is slightly quiet.
    """
    import numpy as np
    start = onset_seconds(src)
    x = load(src, start)
    if x.size == 0:
        raise RuntimeError(f"{src.name}: nothing left after trimming")

    lufs = measure_lufs(src, start)
    if lufs is not None:
        gain, basis = 10 ** ((LUFS - lufs) / 20), f"integrated {lufs:.2f} LUFS"
    else:
        sounding = x[np.abs(x) > np.abs(x).max() * 0.05]
        rms = float(np.sqrt(np.mean(np.square(sounding if sounding.size else x))))
        rms_db = 20 * np.log10(max(rms, 1e-9))
        gain, basis = 10 ** ((RMS_TARGET - rms_db) / 20), f"RMS {rms_db:.2f} dBFS (too short to gate)"

    ceiling = 10 ** (PEAK / 20)
    hit = float(np.abs(x).max()) * gain
    clamped = hit > ceiling
    if clamped:
        gain *= ceiling / hit

    y = np.clip(x * gain, -1.0, 1.0)
    tmp = dst.with_suffix(".tmp.wav")
    dst.parent.mkdir(parents=True, exist_ok=True)
    import wave
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767).astype("<i2").tobytes())
    run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp), "-c:a", "libmp3lame", "-b:a", "64k", str(dst)])
    tmp.unlink(missing_ok=True)
    return {"trimmed_ms": round(start * 1000, 1), "basis": basis,
            "gain_db": round(20 * float(np.log10(gain)), 2),
            "peak_limited": bool(clamped), "dur": round(y.size / SR, 3)}


def attribution(ledger: dict) -> str:
    """Generated, never hand-written: the credits cannot drift from the ledger."""
    out = ["# Audio attribution", "",
           "Generated by `tools/import_sfx.py` from `tools/imported.json`. Do not edit by hand.",
           "",
           "Everything else in `assets/` is generated by this project's own tools and carries no",
           "third-party claim: the voice pack by `tools/render_pack.py` (piper `en_GB-cori-medium`,",
           "public domain), the effect pack by `tools/sfx_render.py`, and the music at runtime.",
           ""]
    mods = (f"Modified for this project: trimmed to the first transient, downmixed to mono "
            f"{SR} Hz, normalised to {LUFS} LUFS integrated with a {PEAK} dBFS true-peak "
            f"ceiling, encoded as 64 kbps mp3.")
    out += [mods, ""]
    for name, e in sorted(ledger["clips"].items()):
        out.append(f"## `assets/sfx/{name}-*.mp3` — {e['slot']}")
        out.append("")
        out.append(f"- **Source:** {e['title']}")
        out.append(f"- **Author:** {e['author']}")
        out.append(f"- **From:** {e['pack']}")
        out.append(f"- **URL:** {e['url']}")
        out.append(f"- **Licence:** {e['licence']}")
        if e.get("licence_evidence"):
            out.append(f"- **Licence evidence:** {e['licence_evidence']}")
        out.append("")
        for v in e["variants"]:
            out.append(f"  - `{name}-{v['n']}.mp3` ← `{v['file']}`")
        out.append("")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", required=True,
                    help="directory holding the unpacked source libraries")
    ap.add_argument("--out", default=str(HERE.parent / "assets" / "sfx"))
    ap.add_argument("--audition", action="store_true",
                    help="write candidates to tools/build/audition instead of installing them")
    a = ap.parse_args()

    src = Path(a.src)

    # Auditioning runs the exact same conversion as installing, because a candidate judged on
    # its raw file is not the candidate that would ship: the trim and the 7 dB of level change
    # are most of what one sounds like in the game.
    if a.audition:
        cands = json.loads(CANDIDATES.read_text())
        out = HERE / "build" / "audition"
        index, done = {}, 0
        for slot, files in sorted(cands["slots"].items()):
            index[slot] = []
            for i, f in enumerate(files):
                sp = src / f
                if not sp.is_file():
                    print(f"  MISSING {f}", file=sys.stderr)
                    continue
                name = f"{slot}-{chr(97 + i)}"
                info = convert(sp, out / f"{name}.mp3")
                index[slot].append({"id": name, "file": f, **info})
                print(f"  {name:<16} <- {f:<40} trim {info['trimmed_ms']:5.1f} ms, "
                      f"{info['gain_db']:+6.2f} dB on {info['basis']}"
                      f"{' (peak limited)' if info['peak_limited'] else ''}")
                done += 1
        (out / "index.json").write_text(json.dumps(index, indent=1, sort_keys=True) + "\n")
        print(f"\n{done} candidate(s) in {out} -- nothing installed, nothing credited yet.")
        return 0

    ledger = json.loads(LEDGER.read_text())
    out = Path(a.out)
    done = 0
    for name, e in sorted(ledger["clips"].items()):
        for v in e["variants"]:
            sp = src / v["file"]
            if not sp.is_file():
                print(f"  MISSING {v['file']}", file=sys.stderr)
                continue
            info = convert(sp, out / f"{name}-{v['n']}.mp3")
            v.update(info)
            print(f"  {name}-{v['n']:<2} <- {v['file']:<40} "
                  f"trim {info['trimmed_ms']:5.1f} ms, {info['gain_db']:+6.2f} dB on {info['basis']}")
            done += 1

    LEDGER.write_text(json.dumps(ledger, indent=1, sort_keys=True) + "\n")
    (HERE.parent / "ATTRIBUTION.md").write_text(attribution(ledger))
    print(f"\n{done} clip(s) installed in {out}")
    print("wrote ATTRIBUTION.md; re-run sfx_render.py to fold them into the manifest")
    return 0


if __name__ == "__main__":
    sys.exit(main())
