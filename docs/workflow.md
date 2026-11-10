# How this project gets built

Written 2026-10-31, after measuring one sprint that was delegated to agy against
three comparable sprints done inline. Extended 2026-11-02 with two server-side
sprints, one inline and one run with haiku surveys. The numbers are in the last
section; the short version is that delegating the *implementation* of a small
change saved nothing, because the cost of this project is reading and verifying,
not typing — but delegating the *reading* measurably did, and the two should
never have shared one rule.

## What shapes the workflow

**The game is one 5,700-line `index.html`.** A delegate can read it — in its own
context, which is the point — but two delegates can never edit it at once. Fan-out
on the game file is off the table. The satellites are different: `server/server.js`,
`stats.html`, `admin.html`, `assets/*.js` and `tools/*.py` are self-contained, have
a clear contract (the API's JSON shape), and can be worked on in parallel safely.

**Taste is the gate, not correctness.** Every audio and art decision so far was
settled by ear, not by reasoning: the composed voice lines were rejected, the
sampled reward sounds lost to the synthesised ones, `weak` won the radio-link
audition. No model tier changes that, so spend the cheapest resource generating
candidates and none of the most expensive predicting which one wins.

## Who does what

| Work | Tier |
|---|---|
| Gameplay sprints in `index.html` — mechanics, balance, numbers, feel | Opus, inline |
| "Where does this live, what calls it" surveys | Haiku, parallel, read-only |
| Satellite files against a known contract | Sonnet subagent |
| Verification harnesses — the script and the verdict | Opus, inline (measured 2026-11-02) |
| Image and asset generation | agy (Imagen) |
| Audio, art and feel judgment | Fadzly |
| Deploy, commit, infra, security | Opus, never delegated |

Keep haiku off numeric tuning and game feel. This codebase's bugs have been the
subtle-arithmetic kind — frame `dt` where `performance.now()` was needed, a divisor
mistaken for a multiplier, an unreflected angle — which is exactly where the
weakest reasoner fails and where failure costs a whole sprint. When something
subtle needs context isolation, that's sonnet, not haiku.

## Main session: Opus

Opus as the default, with the savings coming from delegation rather than from
downgrading the seat where judgment lives. The highest-value act of the difficulty
sprint was noticing, before any code changed, that `diff()` is a divisor for enemy
fire cooldowns as well as a multiplier on damage — so halving it naively would have
cut enemy pressure to a quarter rather than a half. Shipping that would have cost
another full sprint. One avoided iteration pays for the tier difference many times
over, and the opus-to-sonnet gap is about 1.67x per token, not the 5x people assume.

Sonnet main is right for sprints that are mechanical up front: README sweeps,
cosmetic UI, asset-pipeline runs, version bumps. Also during quota peak, when
sonnet beats stalling. `/model` switches mid-session.

Because surveys and harnesses move to haiku under this workflow, Opus-as-main is
cheaper than it was in the sprint that prompted this document.

## When Haiku drives (added 2026-11-10)

Haiku is now the daily driver, so the "Opus, inline" rows above no longer describe
the seat. Read them as two roles. **The main session does the legwork**: the
follow-up reading, the edit, the harness, the verification, the ship. **The
`advisor` subagent (Fable, read-only) does what the Opus seat was there for**: it
is asked before any numeric, balance, feel or co-op-state change, and again after
two failed fixes. It returns the decision, the exact code for the subtle part, and
the command that proves each step; the main session carries that out and runs it.
The rule above still holds — haiku does not decide numeric tuning or game feel on
its own. Triggers and the brief format are in `~/.claude/CLAUDE.md` § Model Routing.

Two baseline probes (2026-11-10, plan only) had Haiku find that `bite` is the clean
lever for "half as dangerous" and that `score` must match the server's
`LEVEL_SCORE`; one of the two also found that `ramp` lands twice. That is one miss
in two on the exact trap described above, which is why the advisor call stays.

For a sprint that is mostly judgment, `/model opus` for that sprint is still the
cheaper path than many advisor calls.

## The per-sprint loop

1. **Survey** — haiku, parallel, read-only. One agent per independent question,
   each returning `file:line` anchors and call sites, no prose. This is the step
   that pays, and not mainly in tokens: a fresh reader of unfamiliar code finds
   what you did not know to look for. The co-op sprint's survey turned up
   `judge()` in `server/server.js`, an anti-cheat layer nobody had mentioned,
   which is why the co-op board's ceiling and pace floor scale with the flight
   instead of rejecting every legitimate four-pilot run.
2. **Decide and implement** — Opus, inline. `index.html` and anything numeric.
3. **Satellites** — sonnet subagent, only when the sprint touches them. Give it
   the contract and the command that proves it works.
4. **Harness** — write it yourself. Delegating one was measured and did not pay:
   the brief for a harness *is* a protocol spec, which is the same understanding
   as writing the thing, and the returned script was discarded and rewritten
   anyway. Commit the harness when it guards something that breaks quietly —
   `tools/relay-test.js` is 33 checks over real sockets.
5. **Verify** — by execution, in the main session. Every real defect so far fell
   out of *running* something: the content-type curl, three runs each ended by
   clicking the button rather than pressing Enter, driving the difficulty lever in
   a browser, `PRAGMA table_info` after a migration. Reading diffs caught
   cosmetics; running things caught defects. Budget accordingly.
6. **Ship** — commit, push, deploy, bump the service worker, merge `main`, confirm
   live on both hosts.

## Guardrails learned the hard way

- **One writer on `index.html` at a time.** Never fan out edits to it.
- **Deploying is a copy, not a checkout.** `/var/www/sortie/` and
  `/home/ubuntu/sortie-api/server.js` are separate copies of the repo files.
  Restarting `sortie-api` does *not* pick up changes in `server/server.js` — the
  `level` column migration appeared to fail for exactly this reason. The API is
  now more than one file: `server/multiplayer.js` has to be copied beside
  `server.js`, or the service will not start at all.
- **`server/nginx-sortie.conf` is a reference copy, not the live file.** The live
  vhost is `/etc/nginx/sites-available/sortie`; it also carries an unrelated
  service, and certbot rewrites its `listen`/`ssl_*` lines. Never `cp` the repo
  copy over it. It drifted for a week and nearly reverted the cache-header fix.
- **`sudo` for `/var/www`, and never suppress stderr on the copy.** A deploy that
  hid its permission errors looked like it had succeeded and had done nothing.
- **Bump `CACHE` in `sw.js`** on any client change, or installed copies stay stale.
- **A changed asset needs a changed URL.** Bumping `CACHE` is not enough on its own:
  the page is network-first and assets are cache-first, so a fresh `index.html`
  can be handed a stale asset from the generation before. Eleven ships shipped
  under the five-ship bundle's URL, `objs['Executioner']` was undefined, and
  every ship in the game fell back to primitives for anyone who had played
  before. `tools/build-ships.py` now stamps the bundle's `?v=` with a hash of its
  own contents, in both `index.html` and `sw.js`. nginx was also silent on
  `Cache-Control` for this vhost, so browsers invented their own freshness;
  HTML now revalidates and `/assets/` caches for a week.
- **Pages serves `main`.** Work on a feature branch does not ship; the carrier art
  sat unmerged and unshipped for four days.
- **No delegate commits.** agy's three carrier commits used one-line messages
  against this repo's convention and shipped unreviewed.
- **agy needs a hard timeout, triggered on report-written rather than process
  exit.** It finished a brief in about ten minutes and then idled for 53.

## The measurement

Per-item figures, from the session transcript's own usage records. Cache read is
the term that dominates Claude Pro consumption.

| Sprint | Items | ins/del | Turns | Output | Cache read | Wall | Turns/item | CacheR/item |
|---|---|---|---|---|---|---|---|---|
| Auto-fire, mines, crates, Warden (inline) | 5 | 358/19 | 107 | 91K | 33.2M | 47 min | 21.4 | 6.6M |
| Radar, pilots, save (inline) | 3 | 147/21 | 65 | 65K | 24.4M | 23 min | 21.7 | 8.1M |
| Objectives, hold-out, ace boss (inline) | 7 | 505/130 | 209 | 199K | 50.9M | 153 min | 29.9 | 7.3M |
| **Difficulty (delegated to agy)** | 3 | 103/33 | 113 | 68K | 18.8M | 71 min | **37.7** | 6.3M |
| PR #8 relay rewrite (inline) | 5 | 540/372 | 69 | 60K | 13.0M | 10 min | 13.8 | 2.6M |
| **Co-op items 0+1 (haiku surveys + harness)** | 2 | 950/77 | 59 | 106K | 16.6M | 13 min | 29.5 | 8.3M |

Cache read per item barely moved — 6.3M delegated against 6.6–8.1M inline — while
turns per item rose by about half and wall clock tripled against the closest
comparable sprint. The brief ran 167 lines for 103 lines of shipped code.

## Why the last two rows need a different denominator

Per *item* makes the co-op sprint look like the worst run in the table. Per item is
the wrong unit once the items stop being the same size: its two items were 950
lines, against 103 for the agy sprint and 147 for the radar one. Normalised by what
was actually shipped:

| Sprint | ins | turns / 100 ln | cache read / 100 ln |
|---|---|---|---|
| Auto-fire, mines, crates, Warden (inline) | 358 | 29.9 | 9.3M |
| Radar, pilots, save (inline) | 147 | 44.2 | 16.6M |
| Objectives, hold-out, ace boss (inline) | 505 | 41.4 | 10.1M |
| Difficulty (delegated to agy) | 103 | 109.7 | 18.3M |
| PR #8 relay rewrite (inline) | 540 | 12.8 | 2.4M |
| **Co-op items 0+1 (surveys + harness)** | 950 | **6.2** | **1.7M** |

**Only the last two rows may be compared with each other.** Everything above them is
gameplay work inside `index.html`, which is inherently dearer per line — a 7,000-line
file re-read across every turn, and numeric changes that need a browser to judge. A
server-side sprint being four times cheaper per line than a gameplay one says nothing
about delegation; it says the two kinds of work are not alike. The agy row stays worst
even against its own category, which is the finding that still holds.

Against the one fair comparison — PR #8, the same week, the same files, no
delegation — the agentic run was **51% fewer turns and 27% less cache read** than
that run's own rate extrapolated to 950 lines, for 178K haiku tokens that never
entered the main context. Delegation added about a minute of wall clock across three
agents, most of it parallel, against the 3x the agy sprint cost.

**One confound, named rather than buried:** `net.js` is 345 of those 950 lines and is
greenfield, so it required reading nothing at all. Charging every one of the 59 turns
against only the 605 lines that touched existing files still gives 9.8 turns/100 ln
against PR #8's 12.8 — the advantage shrinks from roughly 2x to 1.3x, but it does not
invert.

## Two tests, not one

The single brief-shorter-than-the-code test was right about implementation and wrong
to be applied to everything. Split it:

**Surveys — delegate always, and not to save typing.** A fresh reader of code you have
not read finds what you do not know to look for. Two surveys of 20-odd lines each
covered 668 and 7,550 lines; one of them returned `judge()`, an anti-cheat layer whose
existence changed the design of the co-op board. A grep cannot find what you would
never have thought to grep for.

**Harnesses — write them yourself.** The delegated one cost 63K tokens, took a 45-line
brief, and its output was discarded and replaced with 272 lines written here. It fails
the brief-shorter-than-the-code test for the same reason agy's implement step did: a
brief precise enough to delegate safely takes the same understanding as writing the
thing.

And the point that outlives both: **the delegated harness did not catch the
sector-reaping bug. Running something caught it**, and running something was going to
happen either way. Delegation moved reading off the main context. It did not find a
single defect that execution would not have found.

Two findings worth keeping:

**The one real bug in the delegated work was a defect in the brief, not the
implementation.** The brief specified the locked lever's label as
`` `${LEVEL.name} · locked until this run ends` ``, using the stored preference;
the run's own level is what should show, and the two differ whenever the preference
changed after the run was saved. agy reproduced the spec faithfully. Delegated
quality is bounded by brief quality, and a brief precise enough to delegate safely
takes the same understanding as writing the code.

**The test, then: is the brief shorter than the code?** If not, implement it
inline. Delegate the reading, not the typing, and keep the judgment.
