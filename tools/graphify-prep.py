#!/usr/bin/env python3
"""Give graphify a parseable view of the JS that lives inside our HTML files.

graphify classifies `.html` as a document and never runs tree-sitter on it, so
the game -- all of index.html's inline module -- is invisible to the graph. A
`.graphifyrc` language override does not help: tree-sitter JS fails on the markup
at line 1 and recovers a couple of dozen incidental symbols, which is worse than
nothing because the graph then looks populated while the real symbols are absent.

So extract each inline <script> block to a real .js file under graphify-src/, padded
with blank lines so that **line numbers match the original HTML exactly**. A graph
location like `index.js L5024` is then also index.html L5024, and survey results
point at the file you actually edit.

Run tools/graph.sh, which does the prep, extracts both corpora and merges them.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Outside the repo on purpose: graphify honors .gitignore *and* .git/info/exclude,
# so an ignored path inside the repo is skipped by the very scan that needs it, and
# committing a derived copy of the game would just rot. ~/.cache survives sessions.
OUT = Path.home() / '.cache' / 'sortie-graphify' / 'src'
# Inline-script blocks only. src= scripts are already real files graphify can read,
# and importmap/JSON blocks are not JavaScript.
OPEN = re.compile(r'<script(?![^>]*\bsrc=)(?![^>]*type="(?:importmap|application/json)")[^>]*>')
CLOSE = re.compile(r'</script>')


def extract(path: Path) -> tuple[str, int]:
    lines = path.read_text(encoding='utf-8').splitlines()
    out, depth, kept = [], 0, 0
    for line in lines:
        if depth == 0 and OPEN.search(line):
            # The opening tag's own line holds no code we want; keep the slot blank.
            depth = 1
            out.append('')
            continue
        if depth == 1 and CLOSE.search(line):
            depth = 0
            out.append('')
            continue
        out.append(line if depth else '')
        kept += 1 if depth else 0
    return '\n'.join(out) + '\n', kept


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for html in sorted(ROOT.glob('*.html')):
        js, kept = extract(html)
        if not kept:
            continue
        dest = OUT / (html.stem + '.js')
        dest.write_text(js, encoding='utf-8')
        print(f'{html.name} -> {dest}  ({kept} lines of JS, line numbers aligned)')


if __name__ == '__main__':
    main()
