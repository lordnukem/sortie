# Multiplayer — co-op, the client, and the lobby

**Written 2026-11-02; rewritten the same day when the scope was cut to co-op only.** The relay
exists and is tested (`server/multiplayer.js`, branch `feature/multiplayer-support`, PR #8).
Nothing in the game speaks to it: `grep -c -i websocket index.html` returns **0**.

## What the scope cut changed, and what it cost

The first draft of this plan opened with a skirmish mode — pilots, open space, no AI — and
deferred co-op to a second sprint. That order was chosen for one reason: in skirmish every entity
in the sector is a player, so nothing has to decide where the enemies are, and the relay's
existing protocol covers it exactly.

Co-op does not get that for free. Somebody has to own the Swarm. **Scoping to co-op only makes
this sprint larger, not smaller**, and the honest version of that sentence belongs at the top
rather than in a risks section at the bottom.

There is a real simplification hiding in it, though, and it is what makes the sprint tractable:

> **The host runs the game that already exists.** Solo play is co-op with one pilot and no socket.
> None of the wave, boss, carrier or asteroid code changes. The new code is the *guest* path.

That is a much better position than skirmish would have left us in, where the whole mode was new
code with no existing behaviour to inherit.

## The shape

Three pilots join a host; **four in a flight**, which is the number the game is already written
for. `WING_NAME` / `WING_LABEL` / `WING_SLOT` at `index.html:4544-4549` name Gold Two, Three and
Four and give each a formation station. A guest takes one of those slots instead of an AI wingman
filling it. The HUD, the radio chatter and the formation geometry all work already.

| | Host | Guest |
|---|---|---|
| Own ship | authoritative | authoritative |
| Enemies, asteroids, mines, carrier | authoritative, runs the real sim | replicated, no AI running |
| Wave and boss progression | authoritative | replicated |
| Shots at an enemy | local hit detection | local hit detection, reported up |
| Damage taken | local | local |

Everything is client-authoritative, as it already was. In co-op that is defensible in a way it
never would be in PvP: **the only thing a cheat buys you is ruining a sortie for people who
invited you.** It still gets written into the client, so nobody later builds a ranked mode on it
by mistake.

**Host leaves, the sortie ends** for everyone, with a clear message and nothing posted. The lobby
marks who the host is. Host migration needs enemy-state transfer, an election and a freeze
window, and it fails in ways that are miserable to reproduce; it is not in this sprint.

## What gets replicated, and how

This is the part that decides whether the sprint works, so it is specific.

**Enemies — snapshot.** The host sends every live enemy at 20 Hz: id, type, position, rotation,
hp, ai state. A late wave carries ~28 ships (`startWave`, `index.html:5354`, and the comment there
counts them), so at roughly 100 bytes each that is ~3 KB a tick, ~60 KB/s. That is inside
`MAX_FRAME` (16 KiB) but not comfortably, and it is more than a phone on cellular should be sent
without measuring. Mitigations in order of preference: short keys, positions quantized to 2 dp,
and only sending an enemy whose state actually changed.

**Asteroids and mines — once, then dead reckoning.** They spawn at wave start and drift
predictably. Send the spawn list once per wave; let every client integrate it. Only destruction is
an event. This is the single biggest bandwidth saving available and it costs nothing in fidelity.

**Bolts — events, never snapshots.** A bolt is origin, direction, speed and owner. Every client
simulates it from the `fire` event through the existing `spawnBolt()` (`index.html:4891`).
Snapshotting projectiles would multiply the tick size for no gain.

**Hits — reported, not asked.** A client resolves its own shots against its own copy of the enemy
positions and sends `hit { enemyId, damage }`. The host applies it and broadcasts the result. Same
trust model the relay already has, and in co-op it is the right one.

**Wave progression — events.** `wave_start`, `wave_clear`, `boss_phase`, `holdout_begin`,
`reinforcements`. Guests do not decide any of these; they play the banner and the voice line.

## Shared run state

- **Lives are a pool, not per pilot.** The carrier's spare fighters already work this way, and the
  rescued-pilot mechanic (`index.html:4330`, `4550`) already converts a rescue into a spare
  fighter. A guest who dies respawns from the Halcyon and spends one from the pool; the sortie
  ends when it is empty.
- **Score is per pilot, summed into a team score.** Each pilot sees their own contribution in the
  HUD and the team total on the debrief. Kill credit goes to whoever reported the killing hit.
- **Enemies scale with the flight.** A wave built for one pilot is trivial for four. The drone
  count in `startWave` is the obvious lever; the scaling factor has to come from playtesting, not
  from arithmetic, and should be a named constant that is easy to turn.

## Scoring: a separate board

Co-op runs rank against co-op runs, never against solo. A co-op kill is cheaper than a solo one,
and the whole point of the difficulty multiplier work was to keep the solo board comparable.

- New table `coop_scores`, the shape of `scores` (`server/server.js:38`) plus `pilots` and a
  `flight` id so one sortie's rows can be read as one run.
- `GET /api/coop` with the same rate limit and the same 100-row keep as the solo board.
- A board view on the title screen alongside the existing one, with the pilot count shown — a
  four-pilot run and a two-pilot run are not the same achievement and the board should say so.
- The solo path (`postScore`, `index.html:3891`) must not fire in co-op, and the solo endpoint
  should reject a submission that carries a flight id.

## The work, in the order it can be proven

Each item is testable before the next exists. That ordering is the point: netcode that is wrong
in item 1 makes items 2–6 unprovable rather than merely broken.

### 0 — Server: sectors, lobbies, host, co-op board  (~250 lines)

Sectors in the plural instead of one hardcoded `varan-prime`; a 4-character private code from an
unambiguous alphabet (no `O`/`0`, no `I`/`1`); `GET /api/lobbies` for public sectors; a `host` flag
on the first pilot in a sector, re-sent on `welcome`; a passthrough for the co-op message types
with the host-only ones enforced server-side; `coop_scores` and `GET /api/coop`.

Frame and rate limits need re-tuning against a measured snapshot, not guessed at — `MAX_FRAME`
and `MSG_PER_SEC` were sized for a protocol that carried one ship per message.

*Proven by:* socket tests in the style of PR #8, plus `curl /api/lobbies` and `curl /api/coop`.

### 1 — `net.js`, the transport  (~300 lines)

Its own file, not `index.html`: `docs/workflow.md` says one writer on that file, and netcode is
the part most likely to want a second reader. Connect, join, reconnect with backoff, send `state`
at 20 Hz, decode inbound into a snapshot buffer. The game loop reads the buffer and never touches
a socket.

The URL is `wss://sortiethegame.com/ws` from both hosts — GitHub Pages is a different origin and
cannot be relative, which is exactly why the relay checks `Origin` against the allowlist
`server.js` already keeps.

*Proven by:* two Node clients joining, exchanging state and reconnecting after a drop. No
rendering involved.

### 2 — Peers on screen  (~300 lines)

A `peers` Map, one `buildFriendly()` ship each (`index.html:2526` — already the Striker the
wingmen fly), driven by `tick`. Two things make or break it:

- **Interpolation.** The relay ticks at 20 Hz and the game renders at 60+. Render each peer ~100 ms
  in the past and interpolate between the snapshots bracketing that time. This is the highest-risk
  item in the sprint and the one most likely to need a second pass after it is first seen over a
  real connection rather than loopback.
- **Nameplates.** A peer with no callsign over it is unreadable in a dogfight. Same screen-space
  projection the HUD already does.

*Proven by:* two headless browsers in one sector, each screenshotted showing the other's ship.

### 3 — Enemy replication  (~400 lines)

The host serialises enemies and wave events; the guest builds and drives ships from snapshots with
the AI loop switched off. The guest's enemy update becomes interpolation plus the existing
rendering, nothing more.

Expect the gate — "am I the host?" — to be the fiddly part, because the wave machinery is threaded
through `update()` and every call site has to be *read* rather than guessed at.

*Proven by:* a guest browser screenshotting the same wave the host sees, with matching enemy
counts and positions.

### 4 — Shooting, damage, death  (~250 lines)

`fire` out, `proj` in through `spawnBolt()`, local hit detection, `hit` up, `enemy_damage` /
`enemy_dead` down. Shared life pool, respawn from the carrier, kill credit, team score.

*Proven by:* a two-pilot wave cleared cooperatively, both clients agreeing on the kill count.

### 5 — The lobby  (~350 lines)

A fourth routed view at `#flight`, beside `#controls` and `#about` (`VIEW_IDS`,
`index.html:5858`). Callsign field persisted next to the existing arcade initials. Quick match;
a public list refreshed while the view is open; create-private showing the code with a copy
button; enter-a-code; a pilot list with the host marked; Leave.

Mobile matters more here than anywhere, because the touch layout owns the whole screen — so the
lobby is a title-screen view and never an in-flight overlay.

**Built with no text field at all** (decided by the survey, 2026-11-02). This game has never had
an `<input>` anywhere — the arcade initials are a wheel driven by keys — and on a phone a text
field summons the soft keyboard over a game that has just gone full screen. So the callsign is
the three initials the player already has, and the sector code reuses the initials wheel, which
works from a keyboard, a thumb or a gamepad without asking for one.

*Proven by:* quick match, private code round trip, list refresh and leave, on desktop and at phone
width.

### 5b — A full-screen button on the title  (~20 lines, done)

Pressing Launch already goes full screen, which is no help to someone who has not pressed it
yet and is reading the leader board with an address bar over the top. The machinery existed;
only the title-screen control was missing.

It hides itself where it cannot work: installed from the home screen, where there is no chrome
to lose, and **iPhone Safari, which has no Element Fullscreen API at all** — WebKit bug 206854
is still open and iOS 26 did not change it, while iPad has had it since Safari 16.4. On iPhone
the Add to Home Screen panel is the whole answer, and already says so.

### 6 — Balance and the co-op board  (~200 lines, done)

Enemy scaling per pilot count, the co-op board view, the debrief showing both your contribution
and the team total.

**The two balance numbers are starting values, not answers.** They are named constants sitting
together for exactly that reason:

- `COOP_SHIPS_PER_PILOT = 0.7` — ships scale sub-linearly, because four pilots are better than
  four times one (they share targets and arrive together) while also sharing one pool of
  fighters. A linear ramp on top of a shared pool looked likely to be punishing rather than hard.
- `COOP_LIVES_PER_PILOT = 1` — the pool grows by one fighter per extra pilot. Three between four
  would end most sorties inside two waves; this keeps roughly the solo allowance each while the
  pool itself stays shared, which is the part that makes a flight watch out for each other.

Neither can be settled by arithmetic. *Proven by:* playtesting, which is the only thing that can.

## What is not in this sprint

- **No PvP, no skirmish.** Cut deliberately.
- **No host migration.** The host leaving ends the sortie.
- **No voice, text chat or friend lists.**
- **Nothing co-op touches the solo board.**
- **No second deployment target.** The relay runs inside the existing `sortie-api` unit; the only
  infra change is the `/ws` block in the live nginx, which stays out until item 4 works.

## What will actually bite

1. **Interpolation**, not the protocol. Budget a second pass.
2. **The host gate.** Threading `if (host)` through `update()` is more call sites than it sounds,
   and each one has to be read. This is where a rushed sprint breaks solo play.
3. **Snapshot size on cellular.** 28 enemies at 20 Hz needs measuring on a real phone before the
   quantization work is declared done.
4. **Reconnect is not optional.** Phones background the tab and the socket dies. A sortie that ends
   because someone looked at a notification is worse than no multiplayer at all.
5. **`index.html` is 7,138 lines.** If items 2–6 land inline it gains perhaps another 1,500.
   Splitting the game out of the HTML stops being optional and becomes its own sprint.
6. **Solo must not regress.** Every item above touches the single-player path. Solo is the game
   that has players today; it gets re-tested at the end of every item, not at the end of the
   sprint.

## Merge posture

`feature/multiplayer-support` stays unmerged until item 4 works, because merging a reachable
endpoint that no player uses is surface without benefit. When it merges, `/ws` goes into the live
nginx in the same change, and `docs/workflow.md` already carries the deploy step for
`server/multiplayer.js` as of `b6fe2c8`.
