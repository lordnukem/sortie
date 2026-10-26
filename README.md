# Sortie!

A first-person space combat game that runs entirely in the browser. Launch from
the carrier *Halcyon*, break the Swarm's attack formations before they reach the
fleet, and stay out of the Wardens' tractor beams.

Waves alternate between strike groups, asteroid storms and a capital-ship boss.
Each stage states its own objectives, pays a score multiplier for meeting them,
and debriefs you afterwards.

Built with [three.js](https://threejs.org/). No build step, no bundler, no
server-side code — one `index.html` plus generated assets is the whole thing.

## Play

- **GitHub Pages:** https://lordnukem.github.io/sortie/
- **VPS:** http://72.62.196.152/sortie/

Needs a browser with WebGL2. Gamepad support requires HTTPS, so controllers work
on the Pages URL but not over plain HTTP.

## Controls

| | Keyboard & mouse | Controller | Touch |
|---|---|---|---|
| Steer | `W` `A` `S` `D` or mouse | Left stick | Left half of screen |
| Roll | `Q` `E` | Right stick ↔ | On-screen ⟲ ⟳ |
| Throttle | `[` `]` or wheel | Right stick ↕ | THR slider |
| Afterburner | `Shift` | LB | BURN |
| Lasers | `Space` or left click | RT or A | FIRE |
| Missile | `F` or right click | LT or B | MSL |
| Target | `T` nearest · `Tab` next · `R` attacker | X · Y · RB | TGT · ATK |
| Camera | `C` | Right stick click | VIEW |
| Throttle cut | `Backspace` idle · `\` full | — | — |
| Invert pitch | `I` | Back | — |
| Sound | `M` all · `V` voice callouts | — | — |
| Pause | `P` or `Esc` | Start | PAUSE |

## Stages

Wave type is decided in one place, with the boss taking precedence where both divide:

| Wave | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | fight | fight | storm | fight | **boss** | storm | fight | fight | storm | **boss** | fight | storm | fight | fight | **boss** |

`BOSS_EVERY` and `STORM_EVERY` are both single constants, because this is the balance most worth
revisiting — dogfighting is the core of the game, and every boss or storm is a wave that is not
one:

| | fights | storms | bosses |
|---|---|---|---|
| boss 4, storm 3 | 6/12 = 50% | 3 | 3 |
| **boss 5, storm 3** (current) | 8/15 = **53%** | 4 | 3 |
| boss 6, storm 3 | 8/12 = 67% | 2 | 2 |
| boss 5, storm 4 | 12/20 = 60% | 4 | 4 |

Worth knowing: moving the boss from every 4th to every 5th only gains three points, because the
**storms** are the more frequent interruption. If dogfighting still feels diluted, `STORM_EVERY`
is the larger lever.

**Objectives are bonus only** — they cannot fail you, and the only way to lose is still to run
out of fighters. Flat points would be ignored, though: next to a 10,000-point storm clear and an
extra life at 20,000, a 1,000-point bounty is noise and nobody takes a risk for noise. So each
objective met raises that wave's score **multiplier** (+0.5× each), and clearing all of them
loads two extra missiles for the next wave — a reward felt in the next fight rather than in a
number.

There is deliberately no "survive N seconds" objective. A survival timer rewards circling at
maximum range until the clock runs out. The timed goal is *clear the wave inside N seconds*,
which rewards pressing the attack. Reinforcement arrival is shown as a HUD countdown instead:
information, not a goal.

## The hive ship

A procedural capital ship, ~63 units long against a fighter's 5–14, on every 4th wave. Four
emitter pods sit on four different faces — dorsal, ventral, port, starboard — so there is no
approach from which two can be hit. **Hull fire does nothing while the pods are up**, and the
player sees sparks with no damage so they do not mistake it for a large health bar.

Pods are 35 hp each and the core is 80. Lasers sustain about 6.5 dps once the energy budget
drains, so a pod is one solid gun run; a missile is worth **four times** its normal damage
against a hardpoint, which makes ordnance the right tool rather than a waste — six missiles at
their usual 8 could not kill a single pod. It turns at a fifth of a fighter's rate, so the fight
is positional: get on a face, strip the pod, come round again. Escorts keep arriving so it is
never a quiet duel.

Each boss is tougher than the last via `bossTier()`, because `diff()` flattens at wave 7 — on
its own, the second and third capital ships would be identical to the first.

## Taking damage

Ramming used to be the efficient play: a flat 30 damage destroyed anything outright, so a full
health bar was worth roughly seven free kills. Collision damage now scales with what you hit
(drone 55 up to hive ship 150) and **the heavy ships survive being rammed** — a Warden takes 40
and keeps flying, the capital ship does not notice. Enemy fire also scales past `diff()`'s
wave-7 ceiling via `threat()`, so a drone needs 19 hits to strip a full bar at wave 7 and 13 by
wave 20, where before it was 33 forever.

## How it works

Nothing here was recorded or authored by hand. Everything is either generated at
runtime or generated offline by the scripts in [`tools/`](tools/) — the split is
about what a per-frame budget can afford, not about where the realism comes from.

**Generated at runtime:**

- **The thruster, weapons and impacts** are synthesised with the Web Audio API.
  Anything fired constantly stays live, because per-shot pitch and pan variation
  is free there and a sample would be the repetitive option.
- **The score is adaptive and also generated** — there is no music file. Four
  stems (a held pad, a bass pulse, an arpeggio and percussion) are scheduled on
  a sixteenth-note grid at 100 BPM and faded in and out by how dangerous the
  fight is, measured from how many Swarm ships are alive, how many are within
  220 m, and how deep into the waves you are. Between waves it thins to a single
  held chord; with the hull under 34 % the third bar of the progression turns to
  bII, and a tractor beam drags the whole bed a third of a semitone flat.
  Everything is in C — the bed is C natural minor on a i–VI–III–VII vamp, and
  the victory jingles lift to C major over it, ducking the music under
  themselves so the thirds do not collide.
- **Hull plating, Swarm carapace and asteroid rock** have procedural fallback
  textures drawn to canvas, used if the downloaded ones fail to load.
- **The hive ship** is built from primitives at spawn, like the carrier — nothing
  in the downloaded ship pack is remotely capital-ship scale.
- **The radio link** — hiss, fading, dropouts, squelch — is simulated per
  transmission, so it differs every time and can answer to range.

**Generated offline, shipped as files** (because a convolution tail or a hundred
debris grains cannot be afforded per frame):

- **Halcyon's voice** — 102 clips, ~950 KiB. See [Voice](#voice).
- **Explosions, rock breaks and impacts** — 23 clips, ~290 KiB. See [Effects](#effects).

**Downloaded, CC0:** the five ship meshes (as OBJ text in
`assets/ship-models.js`, scaled and re-oriented at load so every ship flies
along its own +z) and four surface textures.

Every one of those file-backed layers falls back to live synthesis if it fails to
load. That is the same discipline the ship models already used, and it means a
missing pack degrades the game rather than breaking it.

## Audio

Four layers share one `AudioContext`: the live synthesis, the adaptive
score, the rendered effect pack and Halcyon's voice. They meet at a set of
submix buses behind a limiter.

### Audio routing

Everything shares one `AudioContext`. Each category has its own submix bus with
its own dynamics, and they meet at a brick-wall limiter:

| Bus | Contents | Compression |
|---|---|---|
| `wpn` | Lasers, point defence, missiles | −20 dB, 3:1, 3 ms attack |
| `imp` | Hits, shields, hull | −15 dB, 4:1, 2 ms attack |
| `big` | Explosions, rocks, jump flashes | −9 dB, 1.8:1, 8 ms attack |
| `amb` | Engine, saucer hum, fly-bys, beam, reverb return | none |
| `ui` | Lock tones, radio, jingles, alarm | none |
| `vox` | Halcyon control, slightly forward of the rest | none |
| `mus` | Music (runs its own ducking) | none |

There used to be a single compressor for everything, which meant an explosion
flattened the lasers for a fifth of a second and pumped the music along with it.
The reverb tail returns on `amb`, outside the transient compressors, so a big hit
does not pump its own tail. The limiter (−3 dB, 20:1, 1 ms) is what lets the mix
sit louder without clipping when several things go off at once.

### The voice budget

Buses control the balance between categories. They do nothing about one category
arriving many times at once, and that is the case the game actually produces: a
flight of five dying on the same frame, or a boss pod going up while an asteroid
field shatters. Every one of those used to allocate its own full-bandwidth voice.

So the dense effects share a budget. Each one claims a single gain node that all
its layers play through, which makes the whole effect something that can be taken
away as a unit.

| Group | Cap | Covers |
|---|---|---|
| `blast` | 3 | Explosions and asteroid breaks, which are the same pile of broadband energy on the same bus |
| `shot` | 4 | Enemy lasers and carrier point defence |
| `hit` | 4 | Bullet impacts, the densest and least individually meaningful sound in the game |

Over the cap, what happens depends on the age of the voice being displaced, and
that distinction is the whole mechanism. Fading the oldest is right when a fresh
kill arrives over three dying rumbles — it should be heard, and a hard stop would
be its own click. It is wrong for a voice that started on this same frame: a fade
takes about 36 ms to settle, and the attack is already in the sum by then.
Measured at the master with sixteen explosions on one frame, stealing held the
count at three and still let peak climb to 3.57. Refusing the new voice instead
keeps it under 0.83 across one to thirty-two.

Player fire is deliberately not in the table. The gun's own rate of fire limits
it, and the player's shot should never be the thing that gets dropped.

### The thruster

Noise is the signal; resonance is the character. Four band-limited noise layers (rumble, body,
shear hiss, plus three fixed high-Q chamber resonances) through a saturation stage that is
driven harder under reheat.

It replaced two detuned sawtooth oscillators and a sine sub. That design measured **0.86
periodicity** in the 30–120 Hz band — a steady pitch down there is what made it read as a
synthesiser rather than thrust. The rewrite measures 0.05. The 40 / 40.7 Hz detune was also
producing a regular beat, so the "turbulence" was a metronome.

Each layer is modulated by its own stream of heavily smoothed **noise**, played at a different
rate. A sine modulator gives a wobble the ear locks onto within a second; combustion is chaotic,
so the modulator has to be noise too. Afterburner adds pre-baked reheat crackle and an ignition
thump, so engaging it is an event rather than a fader — and it shifts the spectral balance
(+6.7 points of hiss) instead of only getting louder.

`tools/engine_proto.py` renders both designs over the same throttle timeline for A/B.

### Voice

Halcyon control is a pre-rendered pack of 102 clips (~950 KiB), not browser speech
synthesis. The reason is routing, not accents: `speechSynthesis` output cannot be
fed into a Web Audio graph, so it can never be radio-processed, compressed, or
ducked under the music — it always sits *on top of* the mix rather than coming
through a headset.

Clips are generated by [Piper](https://github.com/rhasspy/piper) using
`en_GB-cori-medium` (UK female, **public domain**, trained from scratch — so no
licence inherited from a base model). The `VOX` table in `index.html` is the
single source of truth: the renderer parses it out of the page, and the runtime
uses the same text for the speech-synthesis fallback if the clips fail to load.

**Every clip is a complete sentence.** Lines are assembled by playing clips in
sequence with a 190 ms pause, because a join is only inaudible where speech would
stop anyway. Joining mid-sentence — around a spoken bearing, say — is obvious.
That constraint is why spoken bearings became directions: "off your port bow"
instead of "zero four seven". The exact figure stays in the comms log, and a pilot
can act on a direction without converting it first.

The radio chain is split in two, and the split is forced by that same constraint:

| Baked into each clip (`radio.py transmitter`) | Simulated at runtime (Web Audio) |
|---|---|
| Presence lift, overdrive, 3-pole/2-pole band-limit | Noise bed, keyed to the transmission |
| Multipath comb (1.1 ms), AGC | Fading and dropouts, different every playback |
| | PTT click, squelch tail |

Bake the keying into a clip and you get a squelch burst between every sentence.
And because the noise must *continue* through a dropout — silence where there
should be static is the thing that gives it away — the noise bed has to be
generated at runtime too, independent of the voice.

Link quality follows range to the *Halcyon*: drift far enough out and your own
controller gets harder to hear.

Rendering the pack: `tools/render_pack.py` (see `tools/README.md`).

### Effects

Explosions, asteroid breaks and impacts are rendered offline by
`tools/sfx_render.py` (23 clips, ~290 KiB) rather than synthesised live.
The reason is detail, not authenticity — nothing in this game was ever recorded,
and screen explosions are designed anyway. What per-frame Web Audio cannot afford
is a tail whose spectrum collapses as it decays plus a hundred debris grains; the
live version does it with three noise bursts.

Each sound ships several variants, picked at random and detuned ±6% per hit, so a
repeated kill is never the same waveform. Anything fired constantly — laser
bolts, whizz-bys, lock tones — **stays synthesised**, where per-shot variation is
free and samples would be the repetitive option. If the pack fails to load every
sound falls back to the live synthesis.

The explosion is seven layers: a saturated crack for force, a body sweeping ~5 kHz
down to ~150 Hz, an overdriven sub, granular debris, a pitched-down copy of itself,
a real FFT convolution tail, and finally air absorption applied to the *finished
mix*. That last step matters: applied per-layer, the low end decayed first and left
bright reverb on top, so the composite got **brighter** as it decayed — backwards
from a real blast. Sweeping the mix is what makes the collapse monotonic.

Hull and shield are deliberate opposites: the hull is six inharmonic resonators
ringing like a struck plate, 96% of its energy under 300 Hz; the shield is glassy
and shimmering with 50% above 2 kHz. Rock is dry — stone does not ring — and the
three sizes separate by grain band, not just by the thud.

Sampled clips bypass the shared reverb, since each already carries its own tail.

Nothing in `assets/` is recorded or borrowed, so the repository carries no
third-party claim — and when royalty-free clips were auditioned against the four
reward cues, the synthesis was preferred. Those cues are musical, pitched in the
score's own key, which is the thing a borrowed library cannot match. Should that
ever change, it goes through `tools/import_sfx.py`,
which levels and trims an outside clip to the pack's standard and records its
author, URL and licence in `tools/imported.json` — the file `ATTRIBUTION.md` is
generated from, so credits cannot drift from the files. The licence bar is CC0 or
CC BY, and the reason is the shape of this repository rather than taste: the pack
is loose mp3s anyone can fetch one at a time, which the usual "free for games"
commercial libraries forbid because they only permit distribution inside a
finished binary. `tools/README.md` has the detail.

## Deployment

It is static files; any web server will do. On the VPS it is an additive nginx
`location` block, so it shares the default server without affecting anything else:

```nginx
location = /sortie { return 301 /sortie/; }
location /sortie/ {
    alias /var/www/sortie/;
    index index.html;
    try_files $uri $uri/ =404;
    gzip on;
    gzip_types application/javascript text/javascript text/plain;
    gzip_min_length 1024;
    # The page must NOT be cached: it is one big file, so a stale copy makes a
    # fresh deploy invisible and looks exactly like a broken one.
    add_header Cache-Control "no-cache";
}
location /sortie/assets/ {
    alias /var/www/sortie/assets/;
    try_files $uri =404;
    gzip on;
    gzip_types application/javascript text/javascript text/plain;
    gzip_min_length 1024;
    # Assets only change when their content does, so they can cache hard.
    add_header Cache-Control "public, max-age=604800";
}
```

gzip matters here: `assets/ship-models.js` is 1,021 KB raw and 357 KB compressed.

That caching split is not cosmetic — a cached page masked a live change during
testing and reported the old audio graph as though the edit had not applied.

## Credits

Third-party assets are all **CC0 1.0 (public domain)** — see
[`assets/LICENSES.txt`](assets/LICENSES.txt):

- Ship models and `q_*.jpg` textures: [Ultimate Spaceships](https://quaternius.com/)
  by Quaternius (Striker, Dispatcher, Spitfire, Imperial, Pancake)
- `metal_*.jpg`: MetalPlates006 from [ambientCG](https://ambientcg.com/)
- `rock_*.jpg`: Rock063 from [ambientCG](https://ambientcg.com/)

three.js is loaded from jsDelivr at runtime and is not vendored here.

The game code itself has no license yet — add one if you want others to reuse it.
