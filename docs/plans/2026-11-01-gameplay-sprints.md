# Gameplay direction — benchmark and sprints

**Written 2026-11-01**, after a genre benchmark and an audit of what our own telemetry can and
cannot support. Sprint 1 is implemented; the rest are queued in the order given and the order is
part of the proposal.

## The benchmark

Measured against the games Sortie is actually adjacent to:

| Game | What it is credited for | What we take |
|---|---|---|
| **House of the Dying Sun** | Focus. Combat-first, short, strong radio chatter and atmosphere. Criticised for being "light on content offerings and depth" | We are the same shape — including the criticism |
| **Nova Drift** | Build variety: 120–250 mods, fast runs, synergy hunting | Run-to-run variance, but we cannot compete on volume |
| **Star Wars: Squadrons** | Power routing between engines/weapons/shields, plus drifting. Reviewers name this as the source of its skill ceiling | Depth without content |
| **Everspace 2** | Responsive flight, quick fights. Criticised: "the cannon-fodder will become tiresome" | Fodder must differ by *behaviour* |
| **Sky Rogue** | Loadout slots. Criticised for missile-dominant balance making precise aim unrewarding | A caution, not a model |

Every one of these holds players with one of two engines, and **Sortie has neither**:

1. **Runs differ because your ship differs** — Nova Drift, Everspace 2, Sky Rogue.
2. **Runs differ because you got better** — Squadrons, House of the Dying Sun.

Sortie's only run-to-run variance is the wave number and spawn RNG. Wave 3 of a fifth run plays
like wave 3 of a first.

**The chosen direction is (2) before (1).** Three reasons, in order of weight:

- The research argues against the other order. Meta-progression "shouldn't be propping up a weak
  foundation", and players report persistent upgrades make early runs overpowered, diminish
  in-run choices, and blur self-evaluation — "you come back stronger after every run". On a game
  whose point is a global leader board, that last one is disqualifying.
- We cannot win on content volume. Nova Drift ships 120–250 mods. We would ship twelve.
- Depth is nearly free here. The three meters already exist with independent regen rates
  (`energy` +26/s, `boost` +12/s, `shield` +7/s after 3 s clean) and are coupled to nothing.
  Making them share one player-split budget is a handful of constants plus a readout, and it
  raises the ceiling of every fight already shipped without adding an asset.

## What our data could not support, and the correction that followed

The first version of this plan opened with "give the player a lead pip, the enemies have one and
you don't." **That was wrong.** `leadPoint()` is called for the player at `index.html:6253` and
draws an amber pip with a tracking line, and `index.html:5216` auto-acquires the nearest target
every frame, so it is on screen without the player pressing anything. The claim came from a grep
piped through `head -12` that truncated before the player's call site, asserted without reading
the drawing code.

The second leg was also weaker than presented. The 8.2% hit rate came from two runs dated the
same days as the audio work; 2 shots/s for four minutes with 12 kills is what testing sounds
looks like, not what playing to win looks like. The "nobody reaches wave 5" observation rests on
the same three rows.

**Standing conclusion: we had no reliable gameplay data at all.** Three submitted rows, one
player, one machine, contaminated by the sessions that produced them. That is what Sprint 1
fixes, and it is why the sprints that depend on evidence come before the ones that spend it.

## Sprint 1 — instrumentation ✅ done 2026-11-01

A score row exists only for a run someone chose to submit. There was no denominator: no way to
know how many opened the game, on what, or where they stopped.

- `sessions` table: one row per page load. `sid` per visit, `vid` per browser across visits, so
  "how many people" and "how many sessions" are different questions.
- `POST /api/ping` at `load` / `start` / `wave` / `end`, fire-and-forget with `keepalive`, 204 and
  no body. Monotonic fields merge with `MAX()` so a late or out-of-order ping cannot walk a run
  backwards.
- `GET /api/admin/funnel` and `/api/admin/sessions.csv`, rendered as a **Visits** panel on the
  operations page: visits, browsers, launch rate, boss-reach rate, submit rate, installs, average
  run and wave, hit rate across *all* runs, and breakdowns by stopping wave, ending, difficulty,
  device, OS and browser.

**Privacy note.** This records IP and coarse geolocation for everyone who loads the page, not
only for people who submit a score. That is a wider collection than before and a deliberate
choice; it is behind the admin gate and the sessions CSV is admin-only.

## Sprint 2 — read the data, then measure the gun

Data-gated: do not start until the funnel has real visits in it.

1. Read the funnel. The questions it answers: what fraction press Launch, where runs actually
   stop, what difficulty people pick, and what the device split really is.
2. Measure the gun in-engine rather than from submitted rows — hit rate by range bucket, with
   auto-fire shots separated from aimed ones. Bolts converge at 250 m; the pip draws out to 700 m
   and `onTarget` only registers inside 420 m. If players shoot past convergence, that is a
   readable, fixable mismatch. If the real hit rate is healthy, **this sprint ends here** and the
   gun needs nothing.

## Sprint 3 — the road to the first boss

Data-gated on Sprint 2's stopping-wave histogram.

Every boss sits at wave 5 or later. If the histogram confirms runs ending at waves 2–4, several
sprints of built-and-paid-for content is unreachable: the hive ship, the hold-out, the ace, the
capital escort, the rescued-pilot-to-spare-life loop. Options, cheapest first: compress waves
1–4, move a boss to wave 3, or shorten early waves' spawn queues. This is the best
content-per-hour in the project because the content already exists.

## Sprint 4 — power routing

The depth play, and deliberately not first: routing power to weapons is a meaningless choice
while the weapon's worth is unmeasured.

- One budget across `energy` / `boost` / `shield`, with a player-controlled split.
- Overcharged lasers, engine-boosted top speed, fast shield recharge — pick two at a time.
- A cockpit readout; the dashboard MFDs already exist.
- **Mobile control surface designed in the same sprint.** On desktop this is three keys. On touch
  there is no room beside throttle, burn, fire, missile, target and roll — likely an auto-preset
  that shifts with context rather than a manual control. Ship both or ship neither; a mechanic
  half the players cannot reach is worse than no mechanic.

## Sprint 5 — make the fodder differ by behaviour

`drone` (6 hp) and `lancer` (12 hp) differ in hit points and damage and nothing else. That is
precisely what Everspace 2 is criticised for. We have the slow-and-tanky role (Warden) and
nothing genuinely fast-and-fragile. Give one fodder type a distinct behaviour — a fast
slashing attack that cannot sustain a turn fight, against a type that holds formation and trades.

## Sprint 6 — in-run choice, nothing persistent

Between waves, choose 1 of 3 from a curated pool of about a dozen, aiming for synergy pairs
rather than coverage. **Nothing carries across runs.** That answers the hollow-success criticism
directly and keeps a difficulty-weighted leader board meaningful.

## Sprint 7 — objectives beyond "kill everything"

Escort, strike, intercept, reusing existing ships. Plus deliberate spend on audio: radio chatter
is specifically what reviewers credit for House of the Dying Sun's immersion, and with 105 voice
lines through a radio-processed mix it is the one axis where we already beat the benchmarks.

## Explicitly not doing

- **Loot/RPG progression.** Everspace 2's lane needs a team.
- **Persistent meta-progression.** See Sprint 6.
- **More bosses.** Three boss types against two interchangeable grunts is already backwards.
- **Further mobile polish as a goal in itself.** Touch controls, fullscreen, PWA install, radar
  placement and roll-button sizing have all shipped. Mobile is a constraint on new mechanics
  (Sprint 4), not a destination.
