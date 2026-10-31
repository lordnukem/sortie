# How this project gets built

Written 2026-10-31, after measuring one sprint that was delegated to agy against
three comparable sprints done inline. The numbers are in the last section; the
short version is that delegating the *implementation* of a small change saved
nothing, because the cost of this project is reading and verifying, not typing.

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
| Verification harnesses — the script, not the verdict | Haiku |
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

## The per-sprint loop

1. **Survey** — haiku, parallel, read-only. One agent per independent question,
   each returning `file:line` anchors and call sites, no prose. This is the only
   step that meaningfully reduces the main session's reading.
2. **Decide and implement** — Opus, inline. `index.html` and anything numeric.
3. **Satellites** — sonnet subagent, only when the sprint touches them. Give it
   the contract and the command that proves it works.
4. **Harness** — haiku writes the check; the main session reads only pass or fail.
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
  `level` column migration appeared to fail for exactly this reason.
- **`sudo` for `/var/www`, and never suppress stderr on the copy.** A deploy that
  hid its permission errors looked like it had succeeded and had done nothing.
- **Bump `CACHE` in `sw.js`** on any client change, or installed copies stay stale.
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

Cache read per item barely moved — 6.3M delegated against 6.6–8.1M inline — while
turns per item rose by about half and wall clock tripled against the closest
comparable sprint. The brief ran 167 lines for 103 lines of shipped code.

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
