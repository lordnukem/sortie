#!/usr/bin/env python3
"""Radio channel simulator for Sortie!'s voice pack.

Band-limiting on its own just sounds like a small speaker. What makes a clip read as a
*transmission* is modelling the whole path:

    microphone -> transmitter (overdrive, band-limit) -> channel (fade, dropouts)
               -> receiver (noise floor, AGC, squelch)

The important part is the last one. A real receiver's hiss is roughly constant while the
*signal* varies, so when the signal fades the noise comes up to meet it. Scaling the voice
and the noise together -- the obvious way -- sounds wrong, because the hiss ducks politely
whenever the signal does. Here the noise bed is independent and the voice fades into it.

The squelch is what frames it: the noise exists only while the channel is keyed, so each
clip opens with a click, carries hiss under the voice, and closes with a burst of static as
the carrier drops. The game already plays its own `sfx.comm()` and `sfx.squelch()` around a
line; these tails are deliberately short so they layer rather than fight.

Usage
    radio.py IN.wav OUT.wav [--quality strong|normal|weak|bad] [--seed TEXT]

`--seed` is hashed, so a given line always degrades the same way -- renders are reproducible,
and two different lines never get the same dropouts.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import wave

import numpy as np

SR = 22050

# How bad the link is. `dropouts` is events per second; `noise` is the receiver floor
# relative to full scale; `fade` is how deep the slow multipath fade goes.
QUALITY = {
    "strong": {"dropouts": 0.15, "noise": 0.004, "fade": 0.05, "crackle": 0.3, "drive": 2.2},
    "normal": {"dropouts": 0.55, "noise": 0.011, "fade": 0.11, "crackle": 1.1, "drive": 2.8},
    "weak":   {"dropouts": 1.30, "noise": 0.028, "fade": 0.20, "crackle": 2.6, "drive": 3.4},
    "bad":    {"dropouts": 2.40, "noise": 0.055, "fade": 0.32, "crackle": 4.5, "drive": 4.2},
}


# ---------------------------------------------------------------- wav io
def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise SystemExit(f"{path}: expected 16-bit mono, got "
                             f"{w.getsampwidth() * 8}-bit {w.getnchannels()}ch")
        raw = w.readframes(w.getnframes())
        sr = w.getframerate()
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if sr != SR:
        # Linear resample is plenty: everything downstream band-limits to 3 kHz anyway.
        n = int(round(len(x) * SR / sr))
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    return x


def write_wav(path: str, x: np.ndarray) -> None:
    y = np.clip(x, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767.0).astype("<i2").tobytes())


# ---------------------------------------------------------------- biquads (RBJ cookbook)
def _biquad(x: np.ndarray, b: tuple[float, float, float], a: tuple[float, float]) -> np.ndarray:
    b0, b1, b2 = b
    a1, a2 = a
    y = np.empty_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(x.size):
        xi = x[i]
        yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, xi
        y2, y1 = y1, yi
        y[i] = yi
    return y


def _wa(f: float, q: float) -> tuple[float, float, float]:
    w0 = 2.0 * np.pi * f / SR
    return w0, np.cos(w0), np.sin(w0) / (2.0 * q)


def highpass(x: np.ndarray, f: float, q: float = 0.707) -> np.ndarray:
    _, c, al = _wa(f, q)
    a0 = 1 + al
    return _biquad(x, ((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0),
                   (-2 * c / a0, (1 - al) / a0))


def lowpass(x: np.ndarray, f: float, q: float = 0.707) -> np.ndarray:
    _, c, al = _wa(f, q)
    a0 = 1 + al
    return _biquad(x, ((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0),
                   (-2 * c / a0, (1 - al) / a0))


def peaking(x: np.ndarray, f: float, q: float, gain_db: float) -> np.ndarray:
    A = 10.0 ** (gain_db / 40.0)
    _, c, al = _wa(f, q)
    a0 = 1 + al / A
    return _biquad(x, ((1 + al * A) / a0, -2 * c / a0, (1 - al * A) / a0),
                   (-2 * c / a0, (1 - al / A) / a0))


# ---------------------------------------------------------------- dynamics
def envelope(x: np.ndarray, attack: float, release: float) -> np.ndarray:
    """One-pole follower on |x|, with separate attack and release times in seconds."""
    ka = float(np.exp(-1.0 / (attack * SR)))
    kr = float(np.exp(-1.0 / (release * SR)))
    out = np.empty_like(x)
    v = 0.0
    for i in range(x.size):
        a = abs(x[i])
        k = ka if a > v else kr
        v = a + k * (v - a)
        out[i] = v
    return out


def agc(x: np.ndarray, target: float = 0.3, max_gain: float = 8.0) -> np.ndarray:
    """What a radio's automatic gain control does: squash everything toward one level.

    This is why radio voices sound so relentlessly present -- quiet syllables are hauled up
    to meet the loud ones, so the dynamic range of real speech is mostly thrown away.
    """
    env = envelope(x, 0.004, 0.14)
    gain = np.clip(target / np.maximum(env, 1e-4), 0.0, max_gain)
    gain = lowpass(gain, 90.0)  # keep the gain changes from clicking
    return x * gain


# ---------------------------------------------------------------- the channel
def channel_envelope(n: int, rng: np.random.Generator, q: dict) -> np.ndarray:
    """Slow multipath fading, with abrupt dropouts cut into it."""
    t = np.arange(n) / SR
    env = np.ones(n)
    # Two slow components beating against each other: never periodic enough to notice.
    for freq, depth in ((rng.uniform(0.22, 0.55), q["fade"]),
                        (rng.uniform(0.8, 1.9), q["fade"] * 0.55)):
        env *= 1.0 - depth + depth * np.cos(2 * np.pi * freq * t + rng.uniform(0, 2 * np.pi))

    # Dropouts: the carrier loses lock for a few tens of milliseconds. Ramped over ~4 ms so
    # they thud rather than click -- an instant cut reads as an edit, not a signal loss.
    count = rng.poisson(q["dropouts"] * (n / SR))
    ramp_n = max(1, int(0.004 * SR))
    ramp = np.linspace(0.0, 1.0, ramp_n)
    for _ in range(count):
        dur = int(SR * rng.uniform(0.02, 0.09))
        if dur + 2 * ramp_n >= n:
            continue
        start = int(rng.integers(0, n - dur - 2 * ramp_n))
        depth = rng.uniform(0.02, 0.25)
        shape = np.concatenate([1.0 - (1.0 - depth) * ramp,     # ramp down into the gap
                                np.full(dur, depth),            # the gap itself
                                depth + (1.0 - depth) * ramp])  # ramp back up
        env[start:start + shape.size] *= shape
    return env


def noise_bed(n: int, rng: np.random.Generator, q: dict) -> np.ndarray:
    """Receiver hiss, plus the odd crackle. Independent of the signal, by design."""
    hiss = rng.standard_normal(n)
    # Brighter than the voice band, which is why static sits "above" speech on a real radio.
    hiss = lowpass(highpass(hiss, 420.0), 4600.0)
    hiss /= max(np.max(np.abs(hiss)), 1e-9)
    out = hiss * q["noise"]

    # Crackle: short, sharp impulses from interference.
    for _ in range(rng.poisson(q["crackle"] * (n / SR))):
        dur = int(SR * rng.uniform(0.0015, 0.012))
        if dur >= n:
            continue
        at = int(rng.integers(0, n - dur))
        burst = rng.standard_normal(dur) * np.exp(-np.linspace(0, 6, dur))
        out[at:at + dur] += burst * q["noise"] * rng.uniform(6.0, 22.0)
    return out


def transmitter(x: np.ndarray, q: dict) -> np.ndarray:
    """The part of the chain that belongs to the equipment, not the link.

    This is deliberately deterministic and has no padding, noise or squelch, because clips
    processed this way get concatenated at runtime to build lines like "bearing zero four
    seven". Bake keying into each token and you get a squelch burst between every digit.
    """
    x = x / max(np.max(np.abs(x)), 1e-9)
    # Presence lift before clipping, so the distortion lands on the consonants where it
    # reads as "radio" rather than on the vowels where it just sounds broken.
    x = peaking(x, 2000.0, 0.8, 5.0)
    x = np.tanh(x * q["drive"]) / np.tanh(q["drive"])
    # Carrier band. The low cut has to be steep: at -12 dB/oct a third of the energy was still
    # under 300 Hz, which reads as a small speaker rather than a radio. Three poles gets the
    # chest out of the voice, which is what leaves only the part a headset would pass.
    x = highpass(highpass(highpass(x, 320.0), 320.0), 320.0)
    x = lowpass(lowpass(x, 3000.0), 3000.0)

    # Multipath: a copy delayed under 2 ms comb-filters the band and gives the metallic,
    # slightly hollow character of a signal that arrived by more than one path.
    d = int(SR * 0.0011)
    x = x + np.concatenate([np.zeros(d), x[:-d]]) * 0.42
    x = agc(x)
    return x * (0.89 / max(np.max(np.abs(x)), 1e-9))


def channel(x: np.ndarray, q: dict, rng: np.random.Generator) -> np.ndarray:
    """The part that belongs to the link: fading, dropouts, hiss and squelch.

    Applied once per *transmission*, never per clip. At runtime the game does this in Web
    Audio instead, so the degradation differs every time a line is heard; this version exists
    to render standalone previews and to check the two implementations agree.
    """
    lead, tail = int(0.05 * SR), int(0.22 * SR)
    x = np.concatenate([np.zeros(lead), x, np.zeros(tail)])
    n = x.size

    # No AGC here: the transmitter stage already applied it. Running it twice flattens the
    # fades back out, which defeats the point of having a channel at all.
    x *= channel_envelope(n, rng, q)

    bed = noise_bed(n, rng, q)
    # Squelch: hiss only while the carrier is up, with a burst as it drops. The gate opening
    # and slamming shut is most of what sells it.
    gate = np.ones(n)
    gate[:lead] = np.linspace(0.0, 1.0, lead) ** 3
    close = np.linspace(0.0, 1.0, tail)
    gate[n - tail:] = (1.0 - close) ** 1.6
    bed = bed * gate
    # The squelch burst itself: louder static right as the signal goes.
    bed[n - tail:] *= 1.0 + 2.6 * np.exp(-np.linspace(0, 5, tail))

    y = x + bed

    # PTT click at key-down: a real transmitter thumps the receiver as the carrier appears.
    click_n = int(0.006 * SR)
    click = rng.standard_normal(click_n) * np.exp(-np.linspace(0, 9, click_n))
    y[lead - click_n:lead] += highpass(click, 700.0) * 0.22

    # --- output ------------------------------------------------------------------
    y = np.tanh(y * 1.25) / np.tanh(1.25)
    peak = max(np.max(np.abs(y)), 1e-9)
    return y * (0.89 / peak)


def process(x: np.ndarray, quality: str, seed: str, mode: str = "full") -> np.ndarray:
    q = QUALITY[quality]
    y = transmitter(x, q)
    if mode == "transmitter":
        return y
    rng = np.random.default_rng(int(hashlib.sha256(seed.encode()).hexdigest()[:16], 16))
    return channel(y, q, rng)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--quality", default="normal", choices=sorted(QUALITY))
    ap.add_argument("--seed", default="")
    ap.add_argument("--mode", default="full", choices=("full", "transmitter"),
                    help="transmitter = equipment character only, safe to concatenate; "
                         "full = also apply the link (fades, dropouts, hiss, squelch)")
    a = ap.parse_args()
    write_wav(a.dst, process(read_wav(a.src), a.quality, a.seed or a.src, a.mode))
    return 0


if __name__ == "__main__":
    sys.exit(main())
