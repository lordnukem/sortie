#!/usr/bin/env bash
# Build the graphify knowledge graph for this project.
#
# Two corpora, because the game lives inside index.html and graphify treats .html
# as a document: tools/graphify-prep.py writes a line-aligned .js view of each
# HTML file's inline script to ~/.cache/sortie-graphify/src, and that is scanned
# as its own corpus and merged with the repo's real .js/.py files.
#
# Code-only and fully local: tree-sitter AST, no LLM, no API key, no quota.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
SRC="$HOME/.cache/sortie-graphify/src"
OUT="$HOME/.cache/sortie-graphify"

python3 tools/graphify-prep.py

graphify extract "$SRC" --code-only --no-viz >/dev/null
cp "$SRC/graphify-out/graph.json" "$OUT/graph-game.json"

graphify extract "$REPO" --code-only --no-viz >/dev/null
cp "$REPO/graphify-out/graph.json" "$OUT/graph-repo.json"

mkdir -p "$REPO/graphify-out"
graphify merge-graphs "$OUT/graph-game.json" "$OUT/graph-repo.json" \
  --out "$REPO/graphify-out/graph.json" >/dev/null
graphify cluster-only "$REPO" 2>&1 | tail -3

python3 - <<'PY'
import json
from collections import Counter
g = json.load(open('graphify-out/graph.json'))
n = g['nodes']
print(f"\n{len(n)} nodes, {len(g['links'])} edges")
for f, k in Counter(x.get('source_file', '?') for x in n).most_common(8):
    print(f"  {k:>5}  {f}")
PY
