# Multiplayer — the client and the lobby

**Written 2026-11-02.** The relay exists and is tested (`server/multiplayer.js`, branch
`feature/multiplayer-support`, PR #8). Nothing in the game speaks to it: `grep -c -i websocket
index.html` returns **0**. This plan is the client for it, and the lobby in front of it.

## The decision this plan turns on

Sortie is a wave-survival game against AI. The moment two players share a sector, something has
to decide where the enemies are, and there are only three ways to answer that:

| Approach | What it costs | Verdict |
|---|---|---|
| **Server simulates the waves** | Porting the enemy AI, carrier, boss phases, asteroids and tractor beams out of `index.html` into Node — thousands of lines, and then two copies of the game to keep in step | No |
| **Deterministic lockstep from a shared seed** | Every client must produce bit-identical float results every frame. The sim is `dt`-driven and frame-rate dependent | No |
| **One player's browser hosts the sim** | New message types, a host election, a migration path when the host quits | Yes — but later |

So the first multiplayer mode deliberately **has no AI in it at all.**

**Skirmish**: pilots, open space, asteroids, each other. No waves, no carrier, no boss. Every
entity in the sector is a player, and every player is authoritative over exactly one ship — their
own. That is precisely the protocol the relay already speaks (`join`, `state`, `fire`, `hit`,
`ping` up; `welcome`, `tick`, `proj`, `damage`, `kill`, `respawn`, `player_joined`, `player_left`
down), which is not a coincidence — it is why the relay was shaped that way.

Co-op against the Swarm is the better mode and the one originally asked for. It is **sprint 2**,
because it needs host authority, and host authority is worth building on top of a netcode layer
that already works rather than at the same time as one.

## What exists to build on

| Piece | Where | Use |
|---|---|---|
| Relay, bounded and tested | `server/multiplayer.js` | the whole transport |
| `buildFriendly()` | `index.html:2526` | a peer's ship model, already Striker-based |
| `wings[]` + `updateWings()` | `index.html:4550`, `4575` | the pattern for non-player ships that are not enemies |
| `spawnBolt()` | `index.html:4891` | replicating a peer's shot |
| `comm()` | `index.html:3901` | join/leave/kill chatter in the existing HUD voice |
| `openView()` / `VIEW_IDS` | `index.html:5858` | the lobby is a fourth routed view |
| `API` base | `index.html:3786` | the lobby list; the socket URL is its sibling |

## Server work first

The relay today has exactly one hardcoded sector, `varan-prime`. A lobby is a named sector plus a
way to find it.

1. **Sectors, plural.** A `Map` of sector id to `Sector`, created on first join and destroyed when
   the last pilot leaves. Caps: `MAX_SECTORS`, and the existing `MAX_PLAYERS` per sector.
2. **`join` carries a sector.** `{ type:'join', sector:'<id>', code:'<4 chars>' }`. No sector means
   matchmake into the emptiest public one that is not full, creating one if all are full.
3. **Private sectors.** A 4-character code, from an unambiguous alphabet (no `O`/`0`, no `I`/`1`).
   A private sector never appears in the list and refuses a join with the wrong code.
4. **`GET /api/lobbies`.** Public sectors only: id, pilot count, cap. Rate-limited like every other
   endpoint via the existing `allow()` at `server/server.js:303`.
5. **Skirmish scores do not enter the global board.** They are not comparable to a solo run and the
   relay cannot verify a single number in them. `postScore()` (`index.html:3891`) must not fire in
   skirmish, and the API should reject a submission that claims one.

Sizing: ~150 lines on top of the existing module, no new concepts.

## Client work

In the order it should be built, because each item is testable before the next exists.

### 1. The net layer — `net.js`, not `index.html`

One module owning the socket: connect, `join`, reconnect with backoff, send `state` at 20 Hz,
decode and queue inbound messages. It exposes a snapshot buffer and nothing else. The game loop
reads that buffer; it never touches a socket.

The URL is `wss://sortiethegame.com/ws` from both hosts, because GitHub Pages is a different origin
and cannot be relative — which is the whole reason the relay checks `Origin` against the allowlist
`server.js` already keeps.

Deliberately a separate file. `docs/workflow.md` says one writer on `index.html` at a time, and
the netcode is the part most likely to need a second pair of eyes.

**~250 lines. Testable headlessly against a local server with no rendering at all.**

### 2. Peers on screen

A `peers` Map, one `buildFriendly()` ship each, driven by `tick` snapshots. The two things that
make or break this:

- **Interpolation.** The relay ticks at 20 Hz; the game renders at 60+. Drawing raw snapshots
  gives 20 Hz stutter on every other ship. Render each peer ~100 ms in the past and interpolate
  between the two snapshots bracketing that time. This is the single highest-risk item in the
  sprint and the one most likely to need a second pass.
- **Nameplates.** A peer with no callsign over it is unreadable in a dogfight. The HUD canvas
  already draws screen-space text; this is the same projection.

**~300 lines.**

### 3. Shooting each other

`fire` out on every shot, `proj` in replicated through `spawnBolt()` with the shooter's id as
owner. Local hit detection against peer ships, then `hit` up. `damage` / `kill` / `respawn` down
drive flashes, the kill feed and the respawn.

Accept now, and write down in the file, that **this is a relay**: a peer's client decides it hit
you and the server believes it. Fine among people you invited. Not fine for anything ranked, and
the code should say so where someone would otherwise assume otherwise.

**~200 lines.**

### 4. The lobby — a fourth view

Routed at `#play` alongside `#controls` and `#about`, reachable from the title.

- A callsign field, 3–16 chars, persisted in `localStorage` beside the existing arcade initials.
- **Quick match** — one button, no typing: join or create a public sector.
- **Public list** from `/api/lobbies`, with pilot counts, refreshed while the view is open.
- **Private**: create (shows the code, with a copy button) or enter a code.
- A pilot list while in the sector, and a **Leave** that returns to the title.

Mobile matters here more than anywhere: the existing touch layout owns the whole screen, so the
lobby has to be a title-screen view and not an in-flight overlay.

**~350 lines of markup, CSS and wiring.**

### 5. The skirmish mode itself

A `mode` flag beside `state` (`index.html:3661`). In skirmish: no wave spawner, no carrier launch,
no boss, no mission objectives; asteroids and mines stay, because they are the only terrain the
arena has. Scoring is per-kill and shown in the sector, never posted. Death respawns on the
relay's four-second timer instead of consuming a life.

The risk here is not the new code, it is the old code: the wave machinery is threaded through
`update()`, and gating it has to be done by reading those call sites rather than by guessing at
them. Expect the gate itself to be bigger than it sounds.

**~250 lines, mostly `if (mode === 'solo')` at sites that must each be read first.**

## What this sprint is not

- **Not co-op against the Swarm.** That is sprint 2 and it needs host authority.
- **Not voice, text chat or friend lists.**
- **Not ranked.** Nothing from skirmish touches the global board.
- **Not a second deployment target.** The relay runs inside the existing `sortie-api` unit; the
  only infra change is the `/ws` block in the live nginx, which stays out until there is a client.

## What will actually bite

1. **Interpolation is the hard part**, not the protocol. Budget a second pass for it after the
   first time it is seen on a real connection rather than over loopback.
2. **Mobile sends `state` at 20 Hz over cellular.** Needs measuring on a real phone, not in a
   headless browser. The message-rate cap is 60/s; 20 Hz of state plus fire reports is close enough
   to that ceiling to want checking.
3. **Reconnect is not optional.** Phones background the tab and the socket dies. A sortie that ends
   because someone looked at a notification is worse than no multiplayer.
4. **Cheating is possible by construction** and we are choosing to accept it. Write it down in the
   client as well as the server, so nobody later builds a ranked mode on it by mistake.
5. **`index.html` grows again.** It is 7,138 lines. The net layer goes in its own file for that
   reason; if items 2–5 add another 1,100 lines inline, splitting the game out of the HTML stops
   being optional and becomes its own sprint.

## Order, and how each piece is proven

| # | Item | Proven by |
|---|---|---|
| 0 | Sectors, lobby API, skirmish score rejection | socket tests like the ones in PR #8, plus `curl /api/lobbies` |
| 1 | `net.js` | headless: two Node clients join, exchange state, reconnect after a kill |
| 2 | Peers on screen | two headless browsers in one sector, screenshot each showing the other's ship and nameplate |
| 3 | Shooting | one browser kills the other; kill feed and respawn verified on both |
| 4 | Lobby view | quick match, private code round trip, list refresh, leave — on desktop and at phone width |
| 5 | Skirmish mode | a full two-player skirmish with no AI entity present and no score posted |

Items 0 and 1 are worth doing and reviewing on their own before 2–5 start, because everything
after them is unprovable if the transport is wrong.

## Merge posture

`feature/multiplayer-support` stays unmerged until item 3 works, because merging a reachable
endpoint that no player uses is surface without benefit. When it merges, `/ws` goes into the live
nginx in the same change, and `docs/workflow.md` gains the deploy step for `server/multiplayer.js`
— already written there as of `b6fe2c8`.
