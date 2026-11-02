# The start-up screens, as a cabinet rather than a page

**Written 2026-11-02**, after "make the front page arcade style, not like a project page".

## What is actually wrong with it

The title screen is not ugly. It is a *document*: an eyebrow, a headline, a paragraph of prose,
then four stacked panels of settings and a results table, with navigation links at the bottom.
That is the shape of a product page, and no amount of restyling changes the shape. It reads as
something to *read* rather than something to *play*.

An arcade cabinet does the opposite. It shows you the game running, one loud instruction, and
nothing else until you ask. Settings exist, but behind the prompt rather than in front of it.

## The three decisions this rests on

**The graphics are the engine, not artwork.** Every page frames the 3D scene that is already
running behind the title: the Halcyon for mode select, a slow turntable of the actual fighter you
have chosen for ship select, Swarm ships circling for difficulty. Painted 2D panels beside a 3D
game read as two products, cost a generation round each, and go stale the moment a ship model
changes. The engine cannot drift from the game because it *is* the game.

**The board stays on the landing page, as an attract loop.** It is already the most arcade thing
here — it just looks like a results table in a report. Cycling it with a view of the carrier and
a blinking prompt is what a cabinet does with its high scores, and it is the one thing that makes
somebody want another run.

**PRESS START skips everything.** One loud prompt launches with the settings you had last time;
the four pages sit behind a second, quieter option. Cabinets work exactly this way, and runs here
can end in forty seconds — four screens before every retry would be its own kind of hostile.

## The flow

```
  LANDING  ── press start ─────────────────────────────▶  sortie
     │
     └─ options ──▶ MODE ──▶ HOST/JOIN ──▶ DIFFICULTY ──▶ FIGHTER ──▶ sortie
                   (solo or co-op)   (co-op only)
```

Back steps backwards; Escape returns to the landing page from anywhere. The host/join page is
skipped entirely in solo, because a flow that shows you a page with nothing on it is worse than
one page fewer.

## What each page frames

| Page | What the camera shows | What it asks |
|---|---|---|
| Landing | The Halcyon, slow orbit, Swarm patrol crossing | Nothing. PRESS START, and the board cycling |
| Mode | The carrier's deck, pulled back | Alone, or with a flight |
| Host / join | The deck with the launch tunnel lit | Open one, quick match, or a code |
| Difficulty | A Swarm flight circling, closer and faster per tier | How hard |
| Fighter | The chosen ship on a turntable, lit, filling the frame | Which hull, and how many wingmen |

## What "arcade" means here, concretely

Not a filter applied afterwards. Four specific things:

- **One instruction per screen**, in the largest type on it. Never two competing calls to action.
- **No prose.** The lede paragraph goes. A cabinet does not explain itself; the About page does,
  and it already exists for anyone who wants it.
- **Chrome that admits it is a screen** — scanlines, a faint vignette, the amber/cyan palette the
  HUD already uses, and type at sizes a cabinet would use rather than sizes a document would.
- **It moves.** A blinking prompt, a board that cycles, a ship that turns. A still arcade screen
  is a broken arcade screen.

## What this must not break

- **Solo play is the common case** and must stay one button from the landing page.
- **The difficulty and wingman multipliers** are shown where they are chosen, not buried.
- **Mobile.** The flow is portrait-first; the pages are one column with the 3D behind them.
- **Controller.** A cabinet is a D-pad and two buttons. Every page answers to a stick and A/B.
- **The install prompt and the records link** still have to be reachable, just not first.

## Order of work

1. The page machinery: a `screen` router beside the existing view router, with Back and Escape.
2. The landing page: title card, attract loop, PRESS START, options.
3. Mode and host/join, which is mostly moving the lobby's controls into the flow.
4. Difficulty and fighter, which is mostly moving the existing levers.
5. The camera script per page.
6. The chrome pass: type, scanlines, palette, motion.

Each step keeps the game launchable, so none of them is a point of no return.

## Built 2026-11-02 — what shipped and what did not

Steps 1 to 6 are in. The flow is `scMode -> scDiff -> scShip` solo and gains `scLink` for co-op,
numbering itself from the flow it is actually in. Verified: three steps solo with host/join
skipped, Back stepping backwards, Escape leaving, and the landing page launching straight into
the game.

**Two regroupings the screenshots argued for, not the plan.** The hull page asked two questions at
once — hull *and* wingmen — and at 620x420 it overflowed. Wingmen moved onto the difficulty page,
as a compact pill row rather than four more cards: both multiply the score, so "how hard" is one
question with a modifier. And the big prompt resumes the saved run while the quiet button starts
fresh, which is the way round a cabinet works and was inverted the moment the prompt started
saying CONTINUE RUN.

**The ship turntable is not done.** It was the headline of "graphics ala arcade" and it is the one
thing here that does not work. The ship parks and the camera arrives — measured, not assumed: the
visibility flag is true, the model has its one child, the pose is reached — but the hull renders
black. The scene's lights sit around the carrier, and any anchor far enough from a 760-long ship
to be clear of it is also far enough to be unlit. Two guesses at a position were wasted before
that was understood: one put the camera 140 units from the Halcyon's nose, the other inside what
turned out to be the skybox rather than a world object.

Fixing it means either a light that travels with the turntable, or a parking spot close enough to
the carrier's lighting to be lit and far enough to be clear of its hull. Both are small; neither
is guesswork, and neither belonged in the middle of a flow sprint. The hull page frames the launch
end of the deck until then, which is at least the right subject.
