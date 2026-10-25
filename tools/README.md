# Audio tooling

Both audio packs in `assets/` are generated, not recorded. These three scripts are what
generate them, and the game reads from the same tables they do, so a pack can always be
rebuilt from the source it came from.

| Script | Produces |
|---|---|
| `render_pack.py` | `assets/vox/` — 98 voice clips + manifest |
| `sfx_render.py` | `assets/sfx/` — 23 effect clips + manifest |
| `radio.py` | the radio channel chain, used by `render_pack.py` and standalone for previews |

Neither pack is needed to play the game. If `assets/vox/` or `assets/sfx/` is missing or
fails to load, the game falls back to live Web Audio synthesis and browser speech synthesis,
the same way it falls back to built-in ships if the models do not arrive.

## Setup

```bash
cd tools
python3 -m venv .venv            # or: uv venv .venv
.venv/bin/pip install piper-tts  # pulls numpy and onnxruntime

# The voice: en_GB-cori-medium. UK female, PUBLIC DOMAIN, and trained from scratch, so
# nothing is inherited from a restricted base model. That last part matters -- en_GB-alba
# looks clean at CC BY 4.0 but is finetuned from `lessac`, whose licence is Blizzard
# research-only, and en_US-hfc_female is CC BY-NC-SA.
mkdir -p models
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/medium
curl -L -o models/en_GB-cori-medium.onnx      $BASE/en_GB-cori-medium.onnx
curl -L -o models/en_GB-cori-medium.onnx.json $BASE/en_GB-cori-medium.onnx.json
```

`ffmpeg` must be on `PATH` (used for pitch shifting via `rubberband`, and for mp3 encoding).

The virtualenv, the model (~64 MB) and render intermediates are all gitignored.

## Rendering

```bash
cd tools
.venv/bin/python render_pack.py                      # the whole voice pack
.venv/bin/python render_pack.py --only lock-1,lock-2 # just those lines
.venv/bin/python render_pack.py --quality normal     # a cleaner radio link
.venv/bin/python sfx_render.py --variants 3          # the whole effect pack
.venv/bin/python sfx_render.py --legacy              # also render the live synthesis, for A/B
```

`render_pack.py` reads the `VOX` table straight out of `../index.html`. That table is the
single source of truth: the pack cannot list a line the game does not speak, or miss one it
does, and the runtime uses the same text for its speech-synthesis fallback. Add a line to
`VOX`, re-run, done.

## The two things worth knowing before changing anything

**Every voice clip is a complete sentence.** Lines are assembled at runtime by playing clips
in sequence with a pause. A join is only inaudible where speech would have stopped anyway —
an earlier version built bearings word by word (`"bearing"` + `"zero"` + `"four"`) and the
mid-sentence seams were obvious. That is why spoken bearings are eight directional clips
rather than digits, with the exact figure left in the on-screen comms log.

**The radio chain is split in two, and the split is forced.** `radio.py transmitter` is baked
into each clip: overdrive, band-limiting, multipath comb, AGC — the equipment. The *link* —
hiss, fading, dropouts, PTT click, squelch — is simulated in the game instead, once per
transmission. Bake the keying into a clip and you get a squelch burst between every sentence.
And the noise bed has to be runtime too, because it must continue *through* a dropout: silence
where there should be static is the thing that gives it away.

`radio.py` can still render a full-chain preview for listening:

```bash
.venv/bin/python radio.py in.wav out.wav --quality weak --mode full
```

## Tuning

Quality presets live at the top of `radio.py` (`QUALITY`): dropout rate, noise floor, fade
depth, crackle, drive. The game ships `weak`.

For the effects, the useful knobs are at the top of each `designed_*` function in
`sfx_render.py` — crack gain, body sweep endpoints, sub level, grain counts, impulse tilt. The
whole pack re-renders in about six seconds.

One lesson is worth repeating, because it is not obvious: air absorption has to be applied to
the **finished mix**, not per layer. Darkened layer by layer, the sub and body die steeply and
leave bright reverb and debris with no low end beneath them — so the composite gets *brighter*
as it decays, which is backwards from a real blast.
