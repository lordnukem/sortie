# Sortie!

## The knowledge graph

There is a graphify knowledge graph in `graphify-out/` (gitignored, rebuild it
yourself). Query it before grepping or reading source for a "where does this live
and what calls it" question — that is the step it genuinely replaces:

```bash
graphify explain "diff"            # a symbol, its callers and its community
graphify affected "diff"           # blast radius, two hops out
./tools/graph.sh                   # rebuild after changing code
```

`explain` and `affected` are the two that earn their place here. **`query` and
`path` do not, in this project:** `path` degenerates, because in a single-file game
every symbol is a sibling under one `contains` edge, so it answers
`gameOver <--contains-- index.js --contains--> postScore`, which says nothing. And
`query` returned 67 nodes and ~8,000 tokens for a question two greps answer in ten
lines — the opposite of the saving. Reach for `explain`/`affected` by name rather
than following generic "query before you grep" advice.

Node locations point at real files: `index.js L5024` **is** `index.html` L5024.

### Rebuild with `./tools/graph.sh`, never `graphify update .`

The game lives in an inline `<script type="module">` inside `index.html`, and
graphify classifies `.html` as a document — it never runs tree-sitter on it, so
plain `graphify extract .` sees none of the game. A `.graphifyrc`
`language.html=.js` override makes it worse, not better: tree-sitter fails on the
markup at line 1 and recovers ~23 incidental symbols instead of 430, so the graph
looks populated while every real symbol is missing.

So `tools/graphify-prep.py` writes a line-aligned `.js` view of each HTML file's
inline script to `~/.cache/sortie-graphify/src`, and `tools/graph.sh` scans that as
its own corpus and merges it with the repo's real `.js`/`.py` files. The derived
view lives outside the repo on purpose: graphify honors `.gitignore` *and*
`.git/info/exclude`, so an ignored path inside the repo is skipped by the very scan
that needs it, and committing a derived copy of the game would only rot.

`graphify update .` rebuilds the repo corpus alone and **silently drops all 430
game nodes** (626 -> 248, measured). Queries still answer; they just answer about
the server and the audio tools. Always rebuild with `./tools/graph.sh`.

### What it is and is not good for

It replaces the *locating* step, not the *comprehension* step: it tells you which
functions call what, at which line, deduplicated to function granularity, which is
better than a raw grep line list. You still read the code you are about to change,
so treat it as a better grep rather than as a way to avoid reading.

Everything is deterministic tree-sitter AST — no LLM, no API key, no quota. (The
README's section headings also land in the graph; those come from markdown parsing,
not a semantic pass.) `docs/workflow.md` has where this sits in the per-sprint loop.
