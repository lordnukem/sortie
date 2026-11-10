# Sortie!

## Working here

A browser game with no build step, no package.json and no test suite. The client
is one `index.html` (about 8,600 lines, an inline `<script type="module">`) plus
`net.js` (co-op), `sw.js`, `stats.html` and `admin.html`. The API is
`server/server.js` + `server/multiplayer.js`: Node's own `http` and `sqlite`, no
dependencies, run by the `sortie-api` unit. `docs/workflow.md` has the per-sprint
loop and the measurements behind these rules; Read it before a sprint.

**Never read `index.html` whole.** Locate with `graphify explain <symbol>` or
`rg -n`, then Read the range. A wider question goes to a `surveyor`.

**Who does what when Haiku drives.** I do the edits, the harness and the
verification. The `advisor` decides anything numeric or judged by
feel, and anything in co-op state, before I edit. The subtle bugs here have been
arithmetic: frame `dt` where `performance.now()` was needed, a divisor mistaken for
a multiplier. `diff()` (`index.html`, `const diff =`) multiplies damage *and*
divides enemy fire cooldowns through `fireScale()`, so one change to it lands
twice. Client `DIFFS[].score` and the server's `LEVEL_SCORE` (`judge()`, the
anti-cheat ceiling) must change together.

**Run it locally** (the two halves only meet behind a proxy). Pick ports nothing is
listening on: a server left running by an earlier session answers on the same port
with *old code*, and a test that passes against it proves nothing. On 2026-11-10
ports 8795, 8796 and 8777 were held by servers started a week before.

```bash
ss -ltn | grep -E ':(8896|8877) '                           # must print nothing
DB_PATH=/tmp/t.db PORT=8896 GEO=0 node server/server.js &   # throwaway API; note its PID
node tools/relay-test.js 8896                               # co-op relay: "33 passed, 0 failed"
node tools/devserve.js 8877 8896                            # then http://127.0.0.1:8877/
node tools/ghost-pilot.js --port 8896 --sector ABCD --callsign WINGMAN   # a second pilot
kill <PID>                                                  # stop what I started, nothing else
```

**Done means run, not read.** Server or `net.js` changed: the relay test above
passes against a server started *after* the edit. Client changed: load it through
`devserve` and drive the change, and say so if I could not (no browser, judged by
feel) instead of calling it done.

**Is it live?** Deploying is a copy, not a checkout, so compare the copies:

```bash
cd /home/ubuntu/sortie
for f in index.html sw.js net.js stats.html admin.html manifest.webmanifest favicon.ico; do cmp "$f" "/var/www/sortie/$f"; done
diff -rq assets /var/www/sortie/assets
for f in server.js multiplayer.js; do cmp "server/$f" "/home/ubuntu/sortie-api/$f"; done
systemctl show sortie-api -p ActiveState -p ActiveEnterTimestamp   # started after the copy?
grep -n "const CACHE" sw.js
curl -fsS --max-time 15 https://sortiethegame.com/sw.js | grep "const CACHE"
curl -fsS --max-time 15 https://lordnukem.github.io/sortie/sw.js | grep "const CACHE"
curl -fsS --max-time 15 https://sortiethegame.com/api/health
git status -sb | head -1; git log --oneline origin/main..HEAD      # dirty or unpushed?
```

Silence from `cmp`/`diff`, the same `CACHE` in all three places and an empty
`git log` mean the working tree is what players get.

**Ship — only when Fadzly asks, and I do it myself.** No deploy script exists; this
is assembled from the paths above (2026-11-10), so the live check is the proof.
1. Client changed: bump `CACHE` in `sw.js`. A changed asset also needs a changed URL.
2. Commit on `main` (Pages serves `main`; a feature branch does not ship). Messages
   here open with why, in several paragraphs — see `git log -3`.
3. `git push`, then `sudo cp index.html sw.js net.js stats.html admin.html manifest.webmanifest /var/www/sortie/`
   and `sudo cp -r assets/. /var/www/sortie/assets/`. Never hide stderr on these.
4. Server changed: `cp server/server.js server/multiplayer.js /home/ubuntu/sortie-api/`
   then `sudo systemctl restart sortie-api`. A restart alone picks up nothing.
5. Run the live check above.

**Never:** two writers on `index.html`; `cp server/nginx-sortie.conf` over
`/etc/nginx/sites-available/sortie` (the live vhost differs); a subagent or agy
committing.

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
