#!/usr/bin/env python3
"""Thruster prototype: why the current engine sounds mechanical, and what to replace it with.

THE PROBLEM
    sfx.engine() is built on two sawtooth oscillators at 36-96 Hz plus a sine sub, through one
    resonant lowpass, with a thin noise band on top. The loudest thing in it is therefore a
    pitched waveform -- and a sawtooth at a steady pitch is a synthesiser, not combustion.

    A real thruster has no pitched fundamental. It is broadband turbulent noise, shaped by the
    resonances of the chamber and nozzle, modulated irregularly because combustion is chaotic.
    The fix is to invert the architecture: make noise the signal and resonance the character,
    and drive everything with turbulence that is random rather than periodic.

WHAT THIS SCRIPT IS FOR
    Rendering both designs over the same throttle timeline so they can be compared by ear
    before any of it is rewritten in Web Audio. Everything here maps onto nodes the game
    already uses -- buffer noise, biquads, gains -- so nothing in the new design is cheaper
    offline than it is live.

Usage
    engine_proto.py [--out DIR]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
BLOCK = 64          # filter coefficients are recomputed per block, not per sample


def write_wav(path: Path, x: np.ndarray) -> None:
    y = np.clip(x, -1.0, 1.0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767.0).astype("<i2").tobytes())


def encode(src: Path, dst: Path) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                    "-c:a", "libmp3lame", "-b:a", "80k", "-ar", str(SR), "-ac", "1", str(dst)],
                   check=True)


# ---------------------------------------------------------------- time-varying biquad
def tv_biquad(x, freq, q, kind="lowpass"):
    """A biquad whose cutoff follows `freq` (per-sample array), updated once per block.

    Web Audio's BiquadFilterNode does exactly this when its frequency AudioParam is automated,
    so anything achievable here is achievable in the game.
    """
    n = x.size
    y = np.empty(n)
    x1 = x2 = y1 = y2 = 0.0
    for start in range(0, n, BLOCK):
        stop = min(start + BLOCK, n)
        f = float(np.clip(freq[start], 20.0, SR * 0.45))
        w0 = 2.0 * np.pi * f / SR
        c, al = np.cos(w0), np.sin(w0) / (2.0 * q)
        a0 = 1 + al
        if kind == "lowpass":
            b0, b1, b2 = (1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0
        elif kind == "highpass":
            b0, b1, b2 = (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0
        else:  # bandpass
            b0, b1, b2 = al / a0, 0.0, -al / a0
        a1, a2 = -2 * c / a0, (1 - al) / a0
        for i in range(start, stop):
            xi = x[i]
            yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2, x1 = x1, xi
            y2, y1 = y1, yi
            y[i] = yi
    return y


def smooth(x, hz):
    """One-pole smoothing, the equivalent of setTargetAtTime on a control signal."""
    k = 1.0 - np.exp(-2.0 * np.pi * hz / SR)
    y = np.empty_like(x)
    v = float(x[0])
    for i in range(x.size):
        v += k * (x[i] - v)
        y[i] = v
    return y


def turbulence(n, rng, hz, depth):
    """Band-limited noise as a modulator: irregular, not periodic.

    This is the part that matters. Modulating with a sine gives a wobble the ear locks onto
    immediately and reads as an effect; combustion is chaotic, so the modulator has to be noise.
    """
    t = smooth(rng.standard_normal(n), hz)
    t /= (np.max(np.abs(t)) + 1e-9)
    return 1.0 + depth * t


# ---------------------------------------------------------------- the control timeline
def timeline(seconds=7.0):
    """throttle 0..1 and afterburner on/off, as the game would supply them."""
    n = int(seconds * SR)
    level = np.zeros(n)
    boost = np.zeros(n)
    marks = [(0.0, 1.3, 0.10, 0), (1.3, 2.8, 0.50, 0), (2.8, 4.2, 1.00, 0),
             (4.2, 5.9, 1.00, 1), (5.9, seconds, 0.45, 0)]
    for t0, t1, lv, bs in marks:
        a, b = int(t0 * SR), int(min(t1, seconds) * SR)
        level[a:b] = lv
        boost[a:b] = bs
    # The game ramps these with setTargetAtTime; match that so neither design gets step changes.
    return smooth(level, 1.2), smooth(boost, 2.5), n


# ---------------------------------------------------------------- the engine as it is today
def legacy_engine(level, boost, n, rng):
    # g.gain = 0.04 + level*0.035 + boost*0.03
    # saws at 36 + level*34 + boost*26 ; sub at 18 + level*17
    # lowpass 200 + level*520 + boost*900, Q 2 ; noise band 400 + level*600 + boost*1400
    fsaw = 36 + level * 34 + boost * 26
    ph1 = 2 * np.pi * np.cumsum(fsaw) / SR
    ph2 = 2 * np.pi * np.cumsum(fsaw * 1.0175) / SR     # the 40 / 40.7 Hz detune
    saw = lambda p: 2.0 * (p / (2 * np.pi) % 1.0) - 1.0
    osc = saw(ph1) + saw(ph2)
    body = tv_biquad(osc, 200 + level * 520 + boost * 900, 2.0, "lowpass")
    sub = np.sin(2 * np.pi * np.cumsum(18 + level * 17) / SR)
    out = (body + sub) * (0.04 + level * 0.035 + boost * 0.03)
    ns = tv_biquad(rng.standard_normal(n), 400 + level * 600 + boost * 1400, 0.8, "bandpass")
    ns /= (np.max(np.abs(ns)) + 1e-9)
    out += ns * (0.01 + level * 0.02 + boost * 0.07)
    return out


# ---------------------------------------------------------------- the proposed thruster
def designed_engine(level, boost, n, rng):
    """Noise for the signal, resonance for the character, turbulence for the life."""
    out = np.zeros(n)

    # Independent turbulence per layer, at different rates. Sharing one modulator makes the
    # whole thing pulse together, which reads as a tremolo effect rather than as combustion.
    t_rumble = turbulence(n, rng, 1.8, 0.45)
    t_body = turbulence(n, rng, 5.0, 0.38)
    t_hiss = turbulence(n, rng, 9.0, 0.30)
    # Boost makes the flame less stable, not just louder.
    chaos = 1.0 + boost * 0.5

    # 1. Rumble: weight, with no pitch to it. This replaces the sawtooth pair entirely.
    rum = tv_biquad(rng.standard_normal(n), 70 + level * 55 + boost * 30, 0.9, "lowpass")
    rum /= (np.max(np.abs(rum)) + 1e-9)
    out += rum * t_rumble * (0.055 + level * 0.085 + boost * 0.05)

    # 2. Body: the roar. Mildly resonant so it has a throat without being a tone.
    bod = tv_biquad(rng.standard_normal(n), 190 + level * 420 + boost * 260, 1.4, "bandpass")
    bod /= (np.max(np.abs(bod)) + 1e-9)
    out += bod * t_body * (0.05 + level * 0.1 + boost * 0.07)

    # 3. Chamber resonances: three fixed high-Q peaks. These are what make it read as a machine
    #    -- a cavity ringing, which is a very different thing from an oscillator playing a note.
    src = rng.standard_normal(n)
    for f0, q, g in ((236.0, 7.0, 0.030), (529.0, 9.0, 0.020), (1187.0, 11.0, 0.012)):
        # The peaks shift a little with throttle, as a real nozzle's would under pressure.
        pk = tv_biquad(src, f0 * (1.0 + level * 0.14 + boost * 0.08), q, "bandpass")
        pk /= (np.max(np.abs(pk)) + 1e-9)
        out += pk * g * (0.35 + 0.65 * level)

    # 4. Shear hiss: the exhaust tearing through vacuum. Mostly an afterburner tell.
    hs = tv_biquad(rng.standard_normal(n), 2400 + level * 2600 + boost * 3200, 0.7, "highpass")
    hs /= (np.max(np.abs(hs)) + 1e-9)
    out += hs * t_hiss * (0.006 + level * 0.022 + boost * 0.055)

    # 5. Afterburner crackle: short random pops. Real reheat crackles, and nothing in the
    #    current engine marks the transition except more volume.
    amt = boost * level
    gate = amt > 0.25
    if gate.any():
        idx = np.flatnonzero(gate)
        for _ in range(int(len(idx) / SR * 90)):
            at = int(rng.choice(idx))
            gl = int(rng.uniform(0.002, 0.012) * SR)
            if at + gl >= n:
                continue
            pop = rng.standard_normal(gl) * np.exp(-np.linspace(0, 7, gl))
            out[at:at + gl] += pop * rng.uniform(0.02, 0.07)

    # 6. Ignition: a thump when reheat lights, so engaging the afterburner is an event.
    lit = np.flatnonzero(np.diff((boost > 0.5).astype(int)) > 0)
    for at in lit:
        wl = int(0.3 * SR)
        if at + wl >= n:
            continue
        wh = tv_biquad(rng.standard_normal(wl), np.full(wl, 160.0), 1.2, "lowpass")
        out[at:at + wl] += wh / (np.max(np.abs(wh)) + 1e-9) * np.exp(-np.linspace(0, 6, wl)) * 0.18

    # Saturation that tightens up under reheat: the flame is being pushed harder.
    drive = 1.0 + level * 0.6 + boost * 1.6
    return np.tanh(out * drive * chaos) / np.tanh(1.0 + 0.6 + 1.6)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "build" / "engine"))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    level, boost, n = timeline()
    print("timeline: idle -> cruise -> full -> AFTERBURNER -> cruise  (7 s)")
    for name, fn in (("engine-legacy", legacy_engine), ("engine-designed", designed_engine)):
        rng = np.random.default_rng(4242)
        y = fn(level, boost, n, rng)
        peak = np.max(np.abs(y))
        # Matched peak level, so the comparison is about character and not loudness.
        y = y / (peak + 1e-9) * 0.85
        w = out / f"{name}.wav"
        write_wav(w, y)
        encode(w, out / f"{name}.mp3")
        print(f"  {name:18} {(out / f'{name}.mp3').stat().st_size / 1024:6.1f} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
