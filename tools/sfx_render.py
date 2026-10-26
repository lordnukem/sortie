#!/usr/bin/env python3
"""Offline sound design for Sortie!, starting with the explosions.

WHY OFFLINE
    The game's effects are synthesised live, which is the right call for anything fired
    constantly with varying pitch and pan -- laser bolts, whizz-bys, lock tones. It is the wrong
    call for explosions. A convincing explosion needs a long tail whose spectrum collapses as
    it decays, and dozens of scattered debris grains; per-frame Web Audio can afford neither, so
    the live version is three noise bursts and a sine drop. Rendered ahead of time, none of that
    is expensive: real FFT convolution, a sample-accurate filter sweep, a hundred grains.

    "Realistic" here does not mean "recorded". Nothing in this game has ever been recorded, and
    screen explosions are designed anyway -- layered, saturated, spectrally shaped. What the
    live version lacks is not authenticity, it is detail.

    Each sound renders several variants from different seeds, so the same enemy blowing up twice
    never sounds identical. The live synth stays in the game as the fallback path, exactly as it
    already does for the ship models and textures.

Usage
    sfx_render.py [--out DIR] [--variants N] [--legacy]

`--legacy` also renders a faithful port of the current live synthesis, for A/B comparison.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100   # the voice pack is 22050; explosions need the top end, so these are rendered wider


# ---------------------------------------------------------------- io
def write_wav(path: Path, x: np.ndarray) -> None:
    y = np.clip(x, -1.0, 1.0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767.0).astype("<i2").tobytes())


def encode(src: Path, dst: Path, kbps: int = 64) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                    "-c:a", "libmp3lame", "-b:a", f"{kbps}k", "-ar", str(SR), "-ac", "1",
                    str(dst)], check=True)


# ---------------------------------------------------------------- building blocks
def _biquad(x, b, a):
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


def _coef(f, q):
    w0 = 2.0 * np.pi * min(f, SR * 0.45) / SR
    return w0, np.cos(w0), np.sin(w0) / (2.0 * q)


def lowpass(x, f, q=0.707):
    _, c, al = _coef(f, q)
    a0 = 1 + al
    return _biquad(x, ((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0), (-2 * c / a0, (1 - al) / a0))


def highpass(x, f, q=0.707):
    _, c, al = _coef(f, q)
    a0 = 1 + al
    return _biquad(x, ((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0), (-2 * c / a0, (1 - al) / a0))


def bandpass(x, f, q=2.0):
    _, c, al = _coef(f, q)
    a0 = 1 + al
    return _biquad(x, (al / a0, 0.0, -al / a0), (-2 * c / a0, (1 - al) / a0))


def sweep_lowpass(x, f0, f1, curve=2.0):
    """A one-pole lowpass whose cutoff slides from f0 to f1 across the signal.

    This is the single most important thing the live version cannot do. Air absorbs high
    frequencies far faster than low ones, so a real blast goes from bright to dull as it decays.
    A fixed filter, or even Web Audio's linear ramp, does not read the same way.
    """
    n = x.size
    t = (np.arange(n) / max(n - 1, 1)) ** curve
    fc = f0 * (f1 / f0) ** t
    k = 1.0 - np.exp(-2.0 * np.pi * fc / SR)
    y = np.empty_like(x)
    v = 0.0
    for i in range(n):
        v += k[i] * (x[i] - v)
        y[i] = v
    return y


def exp_env(n, decay):
    return np.exp(-np.linspace(0.0, decay, n))


def sine_sweep(f0, f1, n, curve=2.0):
    t = np.arange(n) / SR
    k = (np.arange(n) / max(n - 1, 1)) ** curve
    f = f0 * (f1 / f0) ** k
    return np.sin(2.0 * np.pi * np.cumsum(f) / SR)


def fftconv(x, h):
    """FFT convolution. Direct convolution with a 2 s impulse would be ~10^10 operations."""
    n = 1 << (x.size + h.size - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(h, n), n)
    return y[: x.size + h.size - 1]


def impulse(seconds, decay, tilt, rng):
    """A designed reverb impulse: decaying noise, low-passed so the tail darkens as it rings."""
    n = int(seconds * SR)
    h = rng.standard_normal(n) * exp_env(n, decay)
    h = sweep_lowpass(h, 7000.0, tilt, curve=1.4)
    return h / (np.max(np.abs(h)) + 1e-9)


def modal(x, modes):
    """Struck-metal resonance: high-Q resonators ringing at inharmonic frequencies.

    This is what makes a hull hit sound like a hull rather than a thud. Metal plates ring at
    frequencies with no harmonic relationship, each decaying at its own rate -- eight resonators
    per impact is routine offline and out of the question in a per-frame budget.
    """
    out = np.zeros_like(x)
    for f, q, decay, gain in modes:
        r = bandpass(x, f, q) * exp_env(x.size, decay)
        out += r / (np.max(np.abs(r)) + 1e-9) * gain
    return out


# ---------------------------------------------------------------- asteroid breaking up
def designed_rock(size, rng):
    """size 3 = large, 2 = medium, 1 = small. Stone: a sharp fracture then a lot of rubble."""
    scale = {3: 1.0, 2: 0.66, 1: 0.44}[size]
    L = (1.5 * scale + 0.35) * rng.uniform(0.9, 1.12)
    n = int(L * SR)
    out = np.zeros(n)

    # Fracture: stone cracks rather than booming, so the transient is mid-forward and dry.
    ck = int(rng.uniform(0.012, 0.022) * SR)
    crack = bandpass(rng.standard_normal(ck) * exp_env(ck, 9.0),
                     rng.uniform(900, 1800) / scale ** 0.5, 1.1)
    out[:ck] += np.tanh(crack / (np.max(np.abs(crack)) + 1e-9) * 2.4) * 0.85

    # Mass: a short low thud, deeper for bigger rocks, with very little sustain.
    sl = int(0.22 * scale * SR)
    out[:sl] += sine_sweep(rng.uniform(95, 130) * (0.6 / scale) ** 0.5,
                           rng.uniform(42, 58), sl, curve=2.2) * exp_env(sl, 5.0) * 0.58 * scale

    # Rubble: the signature of the sound. Dense grains, dry and clattering, no long tail.
    # The grain band scales with the rock: a big body throws big, low-pitched debris. Without
    # that term every size shared one rubble spectrum and the three were indistinguishable --
    # the thud alone was not enough to tell them apart.
    for _ in range(int(rng.integers(50, 80) * scale + 18)):
        gl = int(rng.uniform(0.003, 0.018) * SR)
        at = int(rng.uniform(0.008, L * 0.8) * SR)
        if at + gl >= n:
            continue
        pos = at / n
        gf = rng.uniform(700, 5200) * (0.62 / scale) ** 0.45 * (1.0 - 0.5 * pos)
        g = bandpass(rng.standard_normal(gl) * exp_env(gl, rng.uniform(6.0, 14.0)),
                     gf, rng.uniform(2.0, 7.0))
        out[at:at + gl] += g / (np.max(np.abs(g)) + 1e-9) * rng.uniform(0.06, 0.22) * (1 - pos)

    h = impulse(0.8 * scale + 0.25, 7.0, 700.0, rng)
    wet = fftconv(out, h)[:n]
    out = out + wet / (np.max(np.abs(wet)) + 1e-9) * 0.2    # dry: stone does not ring
    out = sweep_lowpass(out, 9000.0, 1600.0, curve=1.4)
    out = highpass(out, 45.0)
    return out / (np.max(np.abs(out)) + 1e-9) * 0.9


# ---------------------------------------------------------------- taking a hit
def designed_hull(rng):
    """The player's hull. Should feel structural and expensive: metal, not a thump."""
    L = 1.5 * rng.uniform(0.92, 1.1)
    n = int(L * SR)
    out = np.zeros(n)

    ck = int(0.02 * SR)
    hit = rng.standard_normal(ck) * exp_env(ck, 8.0)
    out[:ck] += np.tanh(highpass(hit, 400.0) * 3.0) * 0.9

    # Inharmonic modes: a struck plate, not a tuned bell.
    ex = rng.standard_normal(n) * exp_env(n, 40.0)
    base = rng.uniform(150, 210)
    modes = [(base * r * rng.uniform(0.97, 1.03), q, d, g) for r, q, d, g in (
        (1.00, 14, 3.0, 0.40), (1.73, 18, 3.8, 0.26), (2.41, 22, 4.6, 0.18),
        (3.17, 26, 5.6, 0.12), (4.62, 30, 7.0, 0.08), (6.13, 34, 8.5, 0.05),
    )]
    out += modal(ex, modes) * 0.85

    # Structural stress: a low bend downward, overdriven. This is the part that reads as damage.
    sl = int(0.55 * SR)
    out[:sl] += np.tanh(sine_sweep(rng.uniform(88, 104), rng.uniform(34, 44), sl, curve=1.8)
                        * exp_env(sl, 4.0) * 1.8) * 0.45

    # Tearing: band-limited noise collapsing downward.
    tl = int(0.45 * SR)
    tear = sweep_lowpass(rng.standard_normal(tl), 3000.0, 180.0, curve=1.6) * exp_env(tl, 5.5)
    out[:tl] += np.tanh(tear / (np.max(np.abs(tear)) + 1e-9) * 2.2) * 0.4

    h = impulse(1.2, 6.0, 300.0, rng)
    wet = fftconv(out, h)[:n]
    out = out + wet / (np.max(np.abs(wet)) + 1e-9) * 0.3
    out = sweep_lowpass(out, 8000.0, 900.0, curve=1.5)
    out = highpass(out, 40.0)
    out = np.tanh(out * 1.25) / np.tanh(1.25)
    return out / (np.max(np.abs(out)) + 1e-9) * 0.92


def designed_shield(rng):
    """Energy absorbing a hit: bright, electrical, glassy, and over quickly."""
    L = 1.1 * rng.uniform(0.92, 1.1)
    n = int(L * SR)
    out = np.zeros(n)

    # Bright absorb: a highpassed burst that sweeps down and out.
    bl = int(0.5 * SR)
    b = rng.standard_normal(bl)
    b = highpass(b, 1200.0) * exp_env(bl, 6.0)
    out[:bl] += b / (np.max(np.abs(b)) + 1e-9) * 0.6

    # Glassy cluster: tuned high resonators, which is what makes it read as a field rather
    # than as an impact.
    ex = rng.standard_normal(n) * exp_env(n, 55.0)
    base = rng.uniform(620, 780)
    out += modal(ex, [(base * r, 30, d, g) for r, d, g in (
        (1.0, 5.0, 0.3), (2.02, 6.0, 0.22), (3.04, 7.5, 0.15), (5.1, 9.0, 0.1), (7.3, 11.0, 0.06),
    )]) * 0.8

    # Shimmer: fast tremolo so the field sounds alive rather than struck once.
    t = np.arange(n) / SR
    out *= 1.0 + 0.22 * np.sin(2 * np.pi * rng.uniform(26, 38) * t)

    # A short low counterweight, or it floats with no impact at all.
    sl = int(0.2 * SR)
    out[:sl] += sine_sweep(rng.uniform(190, 240), 90, sl, curve=2.0) * exp_env(sl, 6.0) * 0.3

    h = impulse(1.0, 5.0, 1400.0, rng)      # bright tail, unlike the hull
    wet = fftconv(out, h)[:n]
    out = out + wet / (np.max(np.abs(wet)) + 1e-9) * 0.34
    out = highpass(out, 120.0)
    return out / (np.max(np.abs(out)) + 1e-9) * 0.9


def designed_beam(rng):
    """A Warden's tractor beam engaging: sustained, rising, and meant to feel like dread."""
    L = 1.6
    n = int(L * SR)
    t = np.arange(n) / SR

    # Rising inharmonic pair -- a deliberately unresolved interval, so it never settles.
    a = sine_sweep(rng.uniform(110, 130), rng.uniform(300, 350), n, curve=1.1)
    b = sine_sweep(rng.uniform(155, 180), rng.uniform(430, 500), n, curve=1.1)
    out = a * 0.4 + b * 0.26

    # Swept resonant noise over the top: the sound of the field itself.
    ns = bandpass(rng.standard_normal(n), 900.0, 6.0)
    ns = ns / (np.max(np.abs(ns)) + 1e-9)
    out += ns * 0.3 * (0.3 + 0.7 * (np.arange(n) / n))

    # Pulsing, accelerating: the giveaway that something has hold of you.
    out *= 1.0 + 0.3 * np.sin(2 * np.pi * np.cumsum(6.0 + 10.0 * t / L) / SR)
    # Swell in, cut off sharply at the end.
    env = np.minimum(1.0, np.arange(n) / (0.25 * SR)) * np.minimum(1.0, (n - np.arange(n)) / (0.12 * SR))
    out *= env

    h = impulse(1.4, 5.0, 900.0, rng)
    wet = fftconv(out, h)[:n]
    out = out + wet / (np.max(np.abs(wet)) + 1e-9) * 0.34
    out = highpass(out, 60.0)
    return out / (np.max(np.abs(out)) + 1e-9) * 0.88


# ---------------------------------------------------------------- the current live synthesis
# A faithful port of sfx.boom() as the game plays it today, so the comparison is real rather
# than asserted. Web Audio's exponentialRampToValueAtTime is a*(b/a)^(t/T); its biquad frequency
# ramp is the same shape, which is what the sweep below reproduces.
def _wa_env(n, v, attack):
    a = max(int(attack * SR), 1)
    env = np.empty(n)
    env[:a] = 0.0001 * (v / 0.0001) ** (np.arange(a) / a)
    rest = n - a
    env[a:] = v * (0.0001 / v) ** (np.arange(rest) / max(rest, 1))
    return env


def _wa_tone(n, f, f2, v, attack, kind="sine"):
    k = np.arange(n) / max(n - 1, 1)
    f_t = f * (f2 / f) ** k
    ph = 2.0 * np.pi * np.cumsum(f_t) / SR
    x = np.sin(ph) if kind == "sine" else np.sign(np.sin(ph))
    return x * _wa_env(n, v, attack)


def _wa_hiss(n, f, f2, v, attack, rng, kind="lowpass", q=0.7, dist=False):
    x = rng.standard_normal(n)
    # Web Audio ramps one filter's cutoff; a one-pole sweep is the closest honest equivalent.
    x = sweep_lowpass(x, f, f2, curve=1.0) if kind == "lowpass" else bandpass(x, (f + f2) / 2, q)
    x = x / (np.max(np.abs(x)) + 1e-9)
    y = x * _wa_env(n, v, attack)
    return np.tanh(y * 3.0) / np.tanh(3.0) if dist else y


def legacy_boom(big, rng):
    L = 1.8 if big else 0.9
    n = int((L + 0.3) * SR)
    out = np.zeros(n)
    ln = int(L * SR)
    out[:ln] += _wa_tone(ln, 85 if big else 120, 26, 0.5 if big else 0.3, 0.005)
    out[:ln] += _wa_hiss(ln, 4200 if big else 5200, 70, 0.55 if big else 0.38, 0.004, rng, dist=True)
    for _ in range(9 if big else 5):
        d = rng.uniform(0.04, 0.12)
        dl = int(d * SR)
        at = int(rng.uniform(0.08, L * 0.7) * SR)
        if at + dl >= n:
            continue
        out[at:at + dl] += _wa_hiss(dl, rng.uniform(2000, 6000), 900, rng.uniform(0.04, 0.1),
                                    0.003, rng, kind="bandpass", q=2)
    # The game's reverb: 2.4 s of noise shaped (1 - i/len)^3, sent at roughly 0.4 wet.
    h = rng.standard_normal(int(2.4 * SR)) * (1 - np.arange(int(2.4 * SR)) / (2.4 * SR)) ** 3
    wet = fftconv(out, h / (np.max(np.abs(h)) + 1e-9))[:n]
    out = out + wet * 0.4 / (np.max(np.abs(wet)) + 1e-9) * np.max(np.abs(out))
    return out / (np.max(np.abs(out)) + 1e-9) * 0.89


# ---------------------------------------------------------------- the designed explosion
def designed_boom(big, rng):
    # Macro parameters are jittered per variant, not just the noise seeds. Varying only the
    # noise left three renders 79% waveform-correlated, which is near enough to identical.
    L = (2.6 if big else 1.3) * rng.uniform(0.9, 1.15)
    n = int(L * SR)
    out = np.zeros(n)

    # 1. Crack. The first ~30 ms is what the ear reads as force, so it is mixed hot and
    #    saturated: it has to survive the bus compressor rather than be the first thing squashed.
    ck = int(rng.uniform(0.024, 0.034) * SR)
    crack = highpass(rng.standard_normal(ck) * exp_env(ck, rng.uniform(11.0, 15.0)), 1500.0)
    out[:ck] += np.tanh(crack * 3.6) * (1.15 if big else 0.95)

    # 2. Body.
    bl = int((1.5 if big else 0.8) * SR * rng.uniform(0.9, 1.1))
    body = sweep_lowpass(rng.standard_normal(bl), rng.uniform(4600, 6200) if big else rng.uniform(5800, 7400),
                         rng.uniform(130, 190) if big else rng.uniform(230, 310), curve=2.2)
    body = body / (np.max(np.abs(body)) + 1e-9) * exp_env(bl, rng.uniform(4.4, 6.0))
    out[:bl] += np.tanh(body * 1.6) * (0.8 if big else 0.58)

    # 3. Sub. Kept modest on purpose: pushed hard it reached half the total energy, which is
    #    headroom spent on frequencies most speakers cannot reproduce -- and it buried the crack.
    sl = int((1.1 if big else 0.55) * SR * rng.uniform(0.9, 1.1))
    sub = sine_sweep(rng.uniform(72, 88) if big else rng.uniform(105, 125),
                     rng.uniform(30, 38) if big else rng.uniform(44, 54),
                     sl, curve=2.6) * exp_env(sl, rng.uniform(3.4, 4.6))
    out[:sl] += np.tanh(sub * 1.35) * (0.5 if big else 0.34)

    # 4. Debris, granular. Grains thrown later are filtered lower, so the rubble darkens with
    #    everything else instead of leaving a bright rattle on top of a dead low end.
    for _ in range(int(rng.integers(80, 120) if big else rng.integers(34, 54))):
        gl = int(rng.uniform(0.004, 0.028) * SR)
        at = int(rng.uniform(0.025, L * 0.72) * SR)
        if at + gl >= n:
            continue
        pos = at / n
        g = bandpass(rng.standard_normal(gl) * exp_env(gl, rng.uniform(4.0, 11.0)),
                     rng.uniform(600, 6800) * (1.0 - 0.72 * pos), rng.uniform(1.5, 6.0))
        out[at:at + gl] += g / (np.max(np.abs(g)) + 1e-9) * rng.uniform(0.05, 0.2) * (1 - pos)

    # 5. A pitched-down copy layered under itself: cheap, and it reads as a bigger event.
    if big:
        idx = np.clip((np.arange(n) * rng.uniform(0.68, 0.78)).astype(int), 0, n - 1)
        out += out[idx] * 0.34

    # 6. Tail: real convolution on a designed impulse. The impulse is deliberately dark -- a
    #    bright tail is what made the first attempt get brighter as it decayed.
    h = impulse(2.4 if big else 1.4, 5.2, 180.0 if big else 320.0, rng)
    wet = fftconv(out, h)[:n]
    out = out + wet / (np.max(np.abs(wet)) + 1e-9) * (0.45 if big else 0.3)

    # 7. Air absorption over the whole event. Applying the sweep to the finished mix is what
    #    guarantees the composite darkens monotonically: layered separately, the low end decayed
    #    first and left the top, which is backwards from how a real blast behaves.
    out = sweep_lowpass(out, 9500.0, 950.0 if big else 1400.0, curve=1.5)
    out = highpass(out, 38.0)
    out = np.tanh(out * 1.3) / np.tanh(1.3)
    return out / (np.max(np.abs(out)) + 1e-9) * 0.92


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "build" / "sfx"))
    ap.add_argument("--variants", type=int, default=3)
    ap.add_argument("--legacy", action="store_true")
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    # name -> (renderer, variant count). The beam is sustained and far more recognisable than a
    # one-shot, so two variants is plenty; the rest get the full set.
    PACK = {
        "boom-big":   (lambda r: designed_boom(True, r), a.variants),
        "boom-small": (lambda r: designed_boom(False, r), a.variants),
        "rock-3":     (lambda r: designed_rock(3, r), a.variants),
        "rock-2":     (lambda r: designed_rock(2, r), a.variants),
        "rock-1":     (lambda r: designed_rock(1, r), a.variants),
        "hull":       (designed_hull, a.variants),
        "shield":     (designed_shield, a.variants),
        "beam":       (designed_beam, 2),
    }

    rows, counts = [], {}
    for i, (name, (fn, nvar)) in enumerate(PACK.items()):
        counts[name] = nvar
        for v in range(nvar):
            rng = np.random.default_rng(9000 + i * 97 + v)
            w = out / f"{name}-{v + 1}.wav"
            write_wav(w, fn(rng))
            encode(w, out / f"{name}-{v + 1}.mp3")
            w.unlink()
            rows.append((f"{name}-{v + 1}", (out / f"{name}-{v + 1}.mp3").stat().st_size))

    if a.legacy:
        for big, name in ((True, "boom-big"), (False, "boom-small")):
            rng = np.random.default_rng(1000 + (0 if big else 500))
            w = out / f"legacy-{name}.wav"
            write_wav(w, legacy_boom(big, rng))
            encode(w, out / f"legacy-{name}.mp3")

    # The manifest describes the whole pack, not just this run's output. Anything imported by
    # `import_sfx.py` lives in the same directory and is listed in `tools/imported.json`, so it
    # gets folded in here -- the game loads the manifest and nothing else, so a name missing
    # from it silently falls back to synthesis. render_pack.py learned this the hard way when a
    # `--only` run orphaned the other 98 voice clips.
    import json
    ledger_path = Path(__file__).resolve().parent / "imported.json"
    sources = {n: "rendered by tools/sfx_render.py" for n in counts}
    if ledger_path.is_file():
        ledger = json.loads(ledger_path.read_text())
        for name, e in ledger.get("clips", {}).items():
            present = [v for v in e["variants"] if (out / f"{name}-{v['n']}.mp3").is_file()]
            if not present:
                print(f"  note: {name} is in imported.json but has no clip on disk")
                continue
            counts[name] = len(present)
            sources[name] = f"{e['author']} -- {e['licence']} -- see ATTRIBUTION.md"

    (out / "manifest.json").write_text(json.dumps({
        "variants": counts,
        "sources": sources,
        "format": "mp3 64kbps mono 44100Hz; rendered clips have no reverb send (tails are baked)",
    }, indent=1, sort_keys=True) + "\n")

    for n, b in rows:
        print(f"  {n:22} {b / 1024:6.1f} KiB")
    print(f"\n{len(rows)} clips, {sum(b for _, b in rows) / 1024:.0f} KiB total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
