# Sortie roadmap

Drafted 2026-11-11 from a read-only evaluation of the repo, the live copies and the
running units. Every `file:line` below was read in that pass; claims marked
*inferred* were not reproduced. Spot-checked again on 2026-11-11 before writing:
the judge order and ceilings (`server/server.js:256-273`), the clamp in the POST
handler (`:499-512`), `SORTIE_TELEMETRY=dev` in the unit, no backup timer, and the
graph's stale `diff` line.

Items tagged **[numbers]**, **[state]**, **[protocol]** or **[anti-cheat]** need an
advisor review before anyone edits, per CLAUDE.md § Model Routing.

## Summary

The deployed copies, the repo and the unit are in sync (`CACHE = 'sortie-v34'`, no
unpushed commits). `node --check` passes on all eight JavaScript files, and
`tools/relay-test.js` against a fresh server prints `33 passed, 0 failed`. The server
is already defensively written: route guard, origin allowlist, token bucket,
scrypt-plus-HMAC admin. The weaknesses are in the leaderboard plausibility check,
the verification tooling and operations.

Top three risks:

1. **The solo judge refuses nothing that matters.** On a throwaway server one POST
   put a 50,000,000-point run at rank 1. `kills` is unbounded by wave or time, and
   the score clamp at `server.js:505` runs before the range check at `:261`.
2. **Nothing guards balance or the score contract.** `diff()` feeds seven callers,
   `ramp` lands twice through `fireScale()`, and `DIFFS[].score` must equal
   `LEVEL_SCORE` by hand. The only automated test is the relay.
3. **Operations run on memory.** No scheduled backup of `scores.db`. Production
   runs with `SORTIE_TELEMETRY=dev` set in the unit file. Three stale dev servers
   still listen, and the knowledge graph is four days behind the code.

## Evaluation

### 1. Correctness and anti-cheat

- **High: the solo ceiling cannot refuse anything.** `server/server.js:261,268`
  computes `ceiling = (2000 + wave*14000 + kills*1200 + rocks*150) * LEVEL_SCORE`,
  with `kills` clamped only to `1e6` (`:508`). A post of `{wave:400, kills:1e6,
  shots:1e6, hits:1e6, seconds:0}` was accepted (HTTP 201, rank 1, stored score
  50,000,000, soft flag `no-clock`). The same post with `seconds:3200` was accepted
  with no flag. *Observed* on a throwaway server, stopped afterwards. The README
  claim that forging "cost them an afternoon rather than a curl command"
  (`server/README.md`, "Keeping forged scores out") is false today.
- **High: the pace floor is opt-out.** `server.js:266` checks
  `if (r.seconds > 0 && r.seconds < r.wave * 8)`. A client that sends `seconds: 0`
  skips it and gets only the soft flag. `judgeCoop` has the same shape at `:291`.
- **Medium: dead range checks, and clamps that launder input.** `int()`
  (`server.js:248-251`) clamps to `[lo, hi]`, so `score > 50e6` (`:261`),
  `wave > WAVE_MAX` (`:262`), co-op `score > 200e6` (`:283`) and `pilots > 4`
  (`:282`) can never fire. The clamp rewrites the lie into a legal value: `wave:2000`
  was stored as wave 400, co-op `pilots:9` as 4. *Observed.* The previous session's
  lead on the `int()` clamp is confirmed.
- **Medium: the co-op judge compares mixed quantities.** `postCoop` sends
  `runTelemetry(name, team, …)` (`index.html:4049-4053`, `:6752-6753`). The `score` is
  the team total, made of the poster's score plus each peer's relayed `p.score`. The
  `kills/shots/hits/seconds` are the poster's own. `judgeCoop` (`server.js:292-294`)
  scales the ceiling by `pilots` and compares it with the poster's kills. A guest who
  fired little gets a `no-shots` soft flag, or a refusal if the host had a low-wave,
  high-kill run. A forger gets the pilots multiplier free. *Confirmed by reading; not
  reproduced in a browser.*
- **Medium: peer scores are self-reported and summed unverified.**
  `server/multiplayer.js:377` accepts any `score <= 50e6` in a `state` message, and the
  host adds it into the team total it posts (`index.html:6753`). That is by design for a
  friends-only co-op (`multiplayer.js:6-7`), but the co-op board inherits every
  weakness above, times four. *Observed by reading.*
- **Medium (inferred): a silently dropped guest cannot rejoin a full sector for 10 s.**
  On a silent drop the server keeps the old entry until `PLAYER_TIMEOUT_MS` (10 s), and
  the sector reads `full()` (`multiplayer.js:425-428,507`). The reconnecting client
  gets 1008 `sector full`, which `net.js:198` treats as final (`_fail`, no retry). A
  clean TCP close frees the slot at once (`multiplayer.js:350`), so this only bites on
  phones and NAT.
- **Low (inferred): host reconnect can never succeed.** A host drop sends `run_end` to
  everyone, clears the players and reaps the sector (`multiplayer.js:286-294`). The
  host's own backoff in `net.js` then asks for a sector that no longer exists ("no such
  sector"). This is intended ("nothing hands it on", `:317-319`), but the client spends
  up to eight retries learning it.
- **Low: one write bucket for both boards.** The key `'w:'+ip` is shared, so solo and
  co-op posts together get 20 per hour (`server.js:500,544`). Harmless, undocumented.
- **Low: a dead origin entry.** `server.js:29` lists `http://72.62.196.152`. nginx
  redirects port 80 to https (live vhost lines 109-124), so this entry never matches a
  real origin. It is not a hole.
- **OK: admin auth.** scrypt N=16384 with `timingSafeEqual` (`:393-398`), an HMAC
  token with expiry (`:401-413`), eight attempts per 15 minutes plus a 400-700 ms delay
  (`:634-637`), the token kept in `sessionStorage` (`admin.html:112-116`), and
  `admin.json` at mode 600 outside the repo. Nothing to fix. One note: the token signs
  `exp` alone, so a password rotation invalidates tokens issued before it, as
  documented.
- **OK: input validation.** `readBody` caps requests (4 KiB for pings, 16 KiB, 1 KiB
  for login; `:468,593,636`). `NAME_OK` is a regex. The flight id is sanitised and used
  for idempotency (`:549-552`). Solo posts have no idempotency key, so a timed-out
  response followed by a retry would double-post. `postGlobal`
  (`index.html:4090-4102`) does not retry, so this is latent only.

### 2. Gameplay and balance

- **Medium: `ramp` lands twice, as CLAUDE.md warns, and the numbers show it.** Computed
  with Node from `DIFFS` (`index.html:5660-5665`), `diff()`, `fireScale()` and
  `threat()` (`:5719`). The per-bolt damage index is `diff*bite*threat`, and the fire
  index is `fireScale`:
  - Normal: wave 1 0.13 / 0.25; wave 5 0.64 / 0.56; wave 9 1.28 / 1.00; wave 20 1.50 / 1.00
  - Ace: wave 1 0.32 / 0.38; wave 5 1.64 / 1.14; wave 9 2.43 / 1.50; wave 20 2.85 / 1.50

  Ace on wave 1 already fires 1.5 times as often as Normal (0.38 against 0.25), because
  `ramp` 1.35 multiplies inside `diff()` before `rate` 1.5 multiplies outside it. Whether
  that is wanted is a feel call for the advisor. It is currently tuned without any
  table to look at.
- **Medium: two hand-synchronised copies of the score multipliers.**
  `index.html:5661-5664` and `server.js:256` both say 0.6 / 1 / 1.6 / 2.4 today. Nothing
  checks that they stay equal.
- **Low: numbers that feed more than one place** (recorded for whoever tunes them):
  `diff()` feeds `makeEnemy`, `updateEnemy`, `enemyFire`, `updateBoss`, `updateRocks`,
  `fireScale` and `captureTime` (seven callers, per `graphify explain`).
  `LEVEL.bite` is read at `:4418, :4508, :4872, :5259`. `threat()` at `:4508, :4872`.
  `WAVE_MAX = 400` and the `wave * 8` seconds are server-only constants with no client
  counterpart. The `nextExtra` thresholds (`:4220-4222`) and rank thresholds (`:6794`)
  are literals.
- **Low: the 8 s-per-wave floor is a guess.** No harness measures the fastest legitimate
  clear per level. The number rests on a comment at `server.js:265`.

### 3. Architecture and maintainability

- **Medium: one 8,590-line `index.html`.** `docs/workflow.md:13` says 5,700 lines and
  `:173` says 7,000. The file has grown about 50% since the workflow was written, and
  the per-turn re-read cost the workflow measures has grown with it. The graphify prep
  (`tools/graphify-prep.py`, `tools/graph.sh`) is the right mitigation and works
  (`graphify explain diff` answered), but see §4 on staleness.
- **Medium: a duplicated client/server contract with no shared source.** `LEVEL_SCORE`
  against `DIFFS[].score`. The `runTelemetry` field list (`index.html:4049-4056`)
  against the destructuring (`server.js:503-513`, `:553-565`). The level enum
  `['recruit','normal','veteran','ace']` appears three times in `server.js` (`:507, :559,
  :614`). Each is mechanical, and each is a silent-divergence point.
- **Low: migrations by try/catch on `ALTER TABLE`** (`server.js:153-160`). This works, and
  the `level` column needs the special case at `:158`. It stays fine until a third table
  needs a column.
- **Low: no `package.json`.** The Node version is unpinned, and `node:sqlite` prints an
  `ExperimentalWarning` on every boot (journal, 2026-11-08). There is no `npm test` entry
  point, so "run the test" is a sentence in CLAUDE.md rather than a command.
- **OK: the relay** (`server/multiplayer.js`) is the best-engineered part. It has explicit
  limits (`:35-43`), a host-only message set (`:48-52`), a per-connection token bucket
  (`:192-197`), idle timers, and a 33-check socket harness.

### 4. Operations

- **High: no scheduled backup of `scores.db`.** `crontab -l` and `systemctl list-timers`
  show nothing for sortie. `/home/ubuntu/sortie-api/backups/` holds two hand-made
  directories, `pre-boss-telemetry-20261107-092712` and `pre-telemetry-20261108-011432`.
  The second was reported as `scores.db` alone, without its WAL. A file copy taken
  mid-write can lose rows without any error. *Observed listing; the WAL claim is from the
  evaluation's own inspection and was not re-checked.* The live counts were 14 scores and
  100 sessions.
- **Medium: production runs telemetry in dev mode, on purpose.**
  `/etc/systemd/system/sortie-api.service:15` sets `Environment=SORTIE_TELEMETRY=dev`
  (*observed*). `/api/health` returns `"telemetry":"dev"`. The `dev_sessions` and
  `dev_events` tables hold 7 and 14 rows. Every live client sends debug fields
  (`index.html:4126,4166`), and the tables are never pruned (`server.js:134-152` caps per
  visit only). The previous session's question is answered: this is the unit file, not
  drift.
- **Medium: three leftover dev servers.** PID 1642447 (`node server.js`, cwd
  `/home/ubuntu/sortie-api`, since 26 Oct, port 8795), PID 2907436 (`node
  server/server.js`, cwd the repo, 2 Nov, port 8796), and PID 2907470 (`devserve 8777
  8796`, 2 Nov). The 26 Oct process runs deployed-directory code against a database
  path the evaluation did not inspect. CLAUDE.md already warns about them.
- **Medium: a stale knowledge graph.** `graphify-out/graph.json` is dated 2026-11-07
  09:09. Commits `8069517` (7 Nov) and `5b02168` (8 Nov) touched `index.html` and
  `server.js` after it. `graphify explain diff` reports `index.js L5662`, but the symbol
  is at `index.html:5704` (*observed*, 42-line drift).
- **Low: the nginx reference copy drifts from the live vhost by 31 lines**, all in n8n
  proxy and certbot blocks. The sortie locations (`/api/`, `/ws`, cache headers) match.
  CLAUDE.md's "never cp" rule is correct, and `server/README.md`'s deploy section
  contradicts it.
- **Low: logs.** The journal only, with no request log. Since 2026-11-08 it holds only
  the boot messages, so a 422 or 429 is invisible. Fine for now, blind if cheating
  starts.
- **Low: the proxy budget is implicit.** `proxy_read_timeout 10s` on `/api/` (live vhost
  line 77) against a 2.5 s `geolocate` abort (`server.js:331`) and the 0.4-0.7 s login
  delay. It fits. It is noted only because nothing states it.
- **OK: cache-busting.** `sw.js:9,16,17` and `index.html:619,639` agree
  (`ship-models.js?v=bba25dc9`, `net.js?v=5`). nginx sends `no-cache` for html, sw and
  net.js, and a week for `/assets/`.
- **OK: the admin path.** `/admin.html` is public but holds nothing. Every
  `/api/admin/*` call needs the bearer token (`server.js:642-643`).

### 5. Testing and verification

- **What runs today:** `node --check` on eight files (all pass); `node
  tools/relay-test.js <port>` (33 socket checks, pass); `tools/ghost-pilot.js` and
  `tools/devserve.js` for manual co-op; the "is it live" block in CLAUDE.md (silent
  today).
- **What does not exist:** any test of `judge()` or `judgeCoop()`; any check that
  `DIFFS[].score` equals `LEVEL_SCORE`; any balance table; any HTTP-level test of
  `/api/scores` or `/api/coop` (the relay test deliberately checks only that the solo
  board is untouched); a single `npm test`-style entry point.
- **A minimal harness:** the forged posts above are already a test: four `curl`s against
  a throwaway server, each with an expected status. `judge()` and `judgeCoop()` are pure
  functions but not exported (`server.js:258,279`; the file has no `module.exports`), so
  a unit test needs either an export or the HTTP route.

### 6. Documentation accuracy

- **`CLAUDE.md`:** accurate throughout. The line count (about 8,600 against 8,590), the
  `diff()`/`fireScale()` warning (verified at `:5704,5709`), the `DIFFS`/`LEVEL_SCORE`
  pairing, "33 passed", the leftover ports, and the ship steps all match.
- **`docs/workflow.md`:** `:13` ("5,700-line") and `:173` ("7,000-line") are stale. The
  "Who does what" table (`:27-35`) is superseded by the "When Haiku drives" section but
  still reads as current. The measurements are history and are labelled as such.
- **`server/README.md`:** the most out of date. The endpoint table lists only health and
  scores, and omits `/api/coop` GET and POST, `/api/lobbies`, `/api/stats`, `/api/ping`,
  `/api/admin/funnel` and `/api/admin/sessions.csv`. The ceiling formula leaves out the
  `LEVEL_SCORE` multiplier (`server.js:268`). "Deploying" says `sudo cp nginx-sortie.conf
  /etc/nginx/sites-available/sortie`, which CLAUDE.md forbids. The certbot line names
  `sortie.questfor.ge`. "Stores one row per posted score and answers the top twenty"
  ignores `BOARD_KEEP = 100` (`server.js:21`). The anti-cheat section describes a
  defence the forged posts walk straight through.
- **`tools/README.md`:** does document `relay-test.js`, `devserve.js` and `ghost-pilot.js`
  (`:170-238`). It does not mention `set-admin-password.js`, `graph.sh`,
  `graphify-prep.py`, `build-ships.py`, `build-world.py` or `build-icons.py`.

## Improvements

- **R1. Export and unit-test the judges.** *Why:* pure functions, zero coverage. *Change:*
  export `judge`, `judgeCoop`, `int` and `LEVEL_SCORE` from `server/server.js` behind
  `if (require.main !== module)`, so `server.listen` runs only when the file is executed.
  Add `tools/judge-test.js` with about 15 cases: the four forged posts above, one legitimate
  Normal run, one legitimate four-pilot run, and the `seconds:0` bypass. *Effort:* S.
  *Risk:* none to behaviour. *Done when:* `node tools/judge-test.js` prints `N passed, 0
  failed`. Its forged cases are written to expect refusal, so they fail until R2 and R3.
- **R2. Make the range checks real.** [anti-cheat] *Why:* `int()` clamps before `judge()`
  sees the value (`server.js:505-511`), so out-of-range input is laundered into a legal
  one. *Change:* parse with a non-clamping `num()` into `r`, and let `judge()` refuse.
  Clamp nothing that `judge()` ranges. *Effort:* S. *Risk:* low; a legitimate client never
  exceeds these ranges. *Done when:* `wave:2000` returns 422 `wave-range` and co-op
  `pilots:9` returns 422 `pilots-range` (R1 cases).
- **R3. Bound kills by time and wave, and make the clock mandatory.** [anti-cheat]
  [numbers] *Why:* the ceiling's `kills*1200` term is unbounded (`server.js:268`), and
  `seconds: 0` skips the pace floor (`:266`). *Change:* `seconds === 0` becomes a hard
  `no-clock` refusal. Add `kills <= seconds*K_PER_SEC + wave*K_PER_WAVE`, with the K values
  set by the advisor from the spawn tables (`queuedShips()`, `index.html:5758`). Cap
  `score <= seconds*MAX_PTS_PER_SEC`. *Effort:* M. *Risk:* a wrong K refuses legitimate
  runs, which is why it needs the advisor and the measurement in R6. *Done when:* the R1
  forged cases return 422, and a legitimate run from the live `scores` table still returns
  201. Update the README formula at the same time.
- **R4. Co-op posts carry team-level stats, or the judge normalises per pilot.** [anti-cheat]
  [protocol] *Why:* `index.html:4049-4053` sends the poster's own stats alongside a team
  score. *Change (advisor to choose):* either the host sums the peers' relayed stats, which
  needs `kills` and `shots` added to the `state` message in `net.js` and
  `multiplayer.js:366-379`, or `judgeCoop` divides the team score by `pilots` before
  comparing it with the poster's own ceiling. *Effort:* M. *Risk:* a protocol change across
  three files. *Done when:* `relay-test.js` still passes 33/33, and an R1 co-op case with a
  low-kill guest poster returns 201.
- **R5. One source for the score multipliers.** *Why:* `DIFFS[].score`
  (`index.html:5661-5664`) and `LEVEL_SCORE` (`server.js:256`). *Change:* the cheapest fix is
  a check, not a refactor: `tools/contract-check.js` greps both tables and compares the four
  numbers. *Effort:* S. *Risk:* none. *Done when:* `node tools/contract-check.js` exits 0,
  and exits 1 after one number is edited.
- **R6. Balance table printer.** [numbers] *Why:* `ramp` lands twice and nobody can see it.
  *Change:* `tools/balance-table.js` evaluates `diff()`, `fireScale()`, `threat()` and
  `bossTier()` for each level and waves 1 to 30. It copies the four formulas with their line
  numbers in a comment, and R5's check catches drift. It prints the table in §2. *Effort:* S.
  *Risk:* none; it changes nothing. *Done when:* `node tools/balance-table.js` prints four
  levels by thirty waves. Any tuning that follows is a separate advisor item.
- **R7. `tools/test.sh`, one command for everything.** *Why:* "run the test" is prose today.
  *Change:* a script that finds a free port with `ss -ltn`, starts a throwaway server with
  `DB_PATH=$(mktemp -d)/t.db GEO=0`, runs `node --check` on every JavaScript file, R1, R5,
  and `relay-test.js`, then kills its own PID. *Effort:* S. *Risk:* none. *Done when:*
  `./tools/test.sh` ends with `ALL PASSED`, and the port is free afterwards.
- **R8. Nightly `scores.db` backup.** *Why:* none exists. *Change:* a daily
  `sortie-backup.timer` that runs `sqlite3 /home/ubuntu/sortie-api/scores.db ".backup
  /home/ubuntu/sortie-api/backups/nightly-$(date +%F).db"`, plus a 14-day prune. `.backup`
  is safe under WAL, unlike `cp`. *Effort:* S. *Risk:* none to the service. *Done when:*
  `systemctl list-timers | grep sortie-backup` shows the timer, and the newest backup's
  `select count(*) from scores` equals the live count.
- **R9. Settle the telemetry mode.** [state] *Why:* the unit hard-codes `dev`, and the dev
  tables never shrink. *Change, once Fadzly decides:* either drop
  `Environment=SORTIE_TELEMETRY=dev` (live mode), or keep dev and prune `dev_events` older
  than 14 days on boot. *Effort:* S. *Risk:* a unit edit needs a restart, which is Fadzly's
  call. *Done when:* `curl -fsS https://sortiethegame.com/api/health` shows the chosen mode.
- **R10. Retire the three leftover servers.** *Why:* they answer old code on 8795, 8796 and
  8777, and CLAUDE.md has to warn about them. *Change:* `kill 1642447 2907436 2907470`, but
  only once Fadzly has confirmed nothing of his uses them. The production unit listens on
  8791, so this does not touch it. *Done when:* `ss -ltn | grep -E ':(8795|8796|8777) '`
  prints nothing.
- **R11. Rebuild the graph and make it part of the ship step.** *Why:* four days stale, with
  a 42-line drift on `diff`. *Change:* run `./tools/graph.sh`, and add it as step 6 of "Ship"
  in CLAUDE.md. *Done when:* `graphify explain diff` reports `L5704`.
- **R12. Rewrite three sections of `server/README.md`.** *Change:* an endpoint table with
  every route and its rate bucket; a ceiling formula that includes `LEVEL_SCORE` and whatever
  R3 adds; "Deploying" replaced by a pointer to CLAUDE.md "Ship", with the nginx `cp` deleted;
  the domain fixed; and a note on `BOARD_KEEP = 100`. *Done when:* `rg -n "questfor|cp
  nginx-sortie" server/README.md` prints nothing, and `rg -c "/api/" server/README.md` is 11
  or more.
- **R13. Doc line counts and tables.** *Change:* `docs/workflow.md:13,173` say 8,600; mark the
  `:27-35` table as superseded; add the six undocumented tools to `tools/README.md`. *Done
  when:* `rg -n "5,700|7,000-line" docs/workflow.md` prints nothing.
- **R14. A reconnect window for a silently dropped guest.** [state] [protocol] *Why:* the
  10 s `sector full` refusal (§1). *Change (advisor):* on `join` with a `rejoin` field naming
  the old pilot id, evict the stale entry before `full()`; or lower `PLAYER_TIMEOUT_MS`
  towards the 20 Hz tick. *Effort:* M. *Risk:* co-op state across a network boundary. *Done
  when:* a new `relay-test.js` case joins four players, drops one socket without a close
  frame, rejoins within 2 s, and gets `welcome`.
- **R15. Log refusals.** *Why:* 422 and 429 responses are invisible. *Change:* one log line per
  422 with the reason, the IP and the numbers (no name). *Effort:* S. *Risk:* none. *Done
  when:* `journalctl -u sortie-api | grep implausible` shows lines after an R1 run against
  the deployed service, once Fadzly approves that deploy.

## Sprint plan

**Sprint 0: decisions and housekeeping. No game code.** Items: R9, R10, R8, R11.
Dependencies: R9 and R10 are Fadzly's actions.
Gate: `curl -fsS https://sortiethegame.com/api/health` shows the decided mode;
`ss -ltn | grep -E ':(8795|8796|8777) '` prints nothing; `systemctl list-timers | grep
sortie-backup` shows the timer; `graphify explain diff | grep L5704` matches.
Must not change: `index.html`, `server.js`, the `CACHE` in `sw.js`.
Needs Fadzly: the telemetry mode (R9); permission to kill the three PIDs (R10); the restart
for the unit edit.

**Sprint 1: a harness that fails today.** Items: R1, R5, R6, R7.
Dependencies: none on Sprint 0.
Gate: `./tools/test.sh` runs `node --check` (8 ok), `judge-test.js` (the forged cases expect
422 and so fail, which is the point), `contract-check.js` (pass), `balance-table.js` (prints),
and `relay-test.js` (33/33), then frees its port.
Must not change: any number in `DIFFS`, `LEVEL_SCORE` or `judge()`; `sw.js`. Nothing ships.
Needs Fadzly: nothing. R1 adds a `require.main` guard to `server.js`, so check that the unit
still boots locally: `PORT=<free> node server/server.js` logs `sortie-api on`.

**Sprint 2: make the judges honest.** Items: R2, R3, R4, R12, R15.
Dependencies: Sprint 1, because the tests must exist first. One advisor brief should cover
R2, R3 and R4 together (anti-cheat, numbers and protocol in one call, not three).
Gate: `./tools/test.sh` fully green, including the formerly failing forged cases. Every row
in the live `scores` and `coop_scores` tables re-judges as accepted, via a `sqlite3 -readonly`
export and `judge-test.js --replay`.
Must not change: the response shapes of `/api/scores` and `/api/coop`, which the client reads
(`rank`, `board`, `why`); `relay-test.js` stays at 33 or grows.
Needs Fadzly: the K constants if the advisor offers a range; the ship (server copy and
restart). R4 also touches `index.html` and `net.js`, so it needs a `CACHE` bump and a Pages
push.

**Sprint 3: balance pass, with the table in hand.** [numbers] Items: whatever the advisor
concludes from `balance-table.js` about `ramp` landing twice (`index.html:5704,5709`),
possibly nothing.
Dependencies: Sprint 1 (R6) and Sprint 2, so that a changed score multiplier cannot desync.
Gate: a before-and-after diff of `balance-table.js` shows only the intended cells;
`contract-check.js` is green; a browser run through `devserve` on a fresh port, judged by
Fadzly.
Must not change: `LEVEL_SCORE` without `DIFFS[].score`; `WAVE_MAX`.
Needs Fadzly: the feel verdict, and whether Ace's wave-1 fire rate (0.38 against Normal's
0.25) is intended.

**Sprint 4: co-op resilience and docs.** Items: R14, R13.
Dependencies: Sprint 1's `relay-test.js` pattern; an advisor brief for R14, since it touches
state across a network boundary.
Gate: `relay-test.js` at 34/34 or more, against a server started after the edit;
`rg -n "5,700|7,000-line" docs/workflow.md` is empty.
Must not change: `MAX_PLAYERS`, `HOST_ONLY`, and the host-migration policy
(`multiplayer.js:317-319`).
Needs Fadzly: whether a 10 s rejoin gap is worth protocol work at all.

## Decisions needed from Fadzly

1. Telemetry: keep production on `SORTIE_TELEMETRY=dev` and add pruning, or switch to `live`?
   The unit file sets it explicitly.
2. May the three leftover node processes be killed (PIDs 1642447, 2907436, 2907470; ports
   8795, 8796, 8777)?
3. Should the live board's 14 existing rows be re-judged under the new rules (R3)? If any
   fail, delete them or keep them?
4. For R4: team-level stats in the protocol (cleaner, three files), or per-pilot
   normalisation in `judgeCoop` (server only)?
5. Is a `package.json` with `"test": "./tools/test.sh"` acceptable? CLAUDE.md currently says
   there is no `package.json`. It adds no dependency.
6. Is the 10 s guest-rejoin gap (R14) worth a protocol change, or is "sector full, try again"
   acceptable for a friends-only mode?

## Not verified

- Anything needing a browser: the co-op post path, reconnect behaviour, and balance feel.
  The reconnect items in §1 and the feel observations in §2 come from reading and arithmetic,
  and are marked *inferred*.
- The database and environment of the 26 Oct leftover server (PID 1642447, cwd
  `/home/ubuntu/sortie-api`). Its `/proc/<pid>/environ` was not read.
- Whether the WAL-less 8 Nov backup lost rows. Its counts are consistent with the live
  timeline, but completeness cannot be proven.
- GitHub Pages beyond the `sw.js` `CACHE` line; only that file was fetched from the mirror.
- The nginx 31-line drift was summarised by filtering out n8n, certbot and proxy lines. Not
  every differing line was read.
- `storeDebug` and `sessions` growth under real traffic. The counts are tiny today: 100
  sessions, 14 dev events.
- `devserve.js` and `ghost-pilot.js` were not run in this pass. `relay-test.js` was run:
  33/33, on a throwaway server that was stopped, with its port confirmed free.
