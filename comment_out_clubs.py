"""
Run from repo root: python3 comment_out_clubs.py index.html
Comments out the club functions extracted to src/clubs.js (Step 6).
Adds // to each line in the specified ranges. Safe to re-run (idempotent).
"""
import sys

RANGES = [
    (1558, 1560),   # getVariantDefault
    (2034, 2037),   # getYardLabel
    (2079, 2088),   # getTypeLabel
    (2670, 2957),   # clubDetailMode through addClub
    (3125, 3134),   # _clubRange
    (5610, 5616),   # calcVizMaxRange
]

path = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
lines = open(path, 'r', encoding='utf-8').readlines()

to_comment = set()
for start, end in RANGES:
    for i in range(start - 1, end):   # convert to 0-based
        to_comment.add(i)

out = []
for i, line in enumerate(lines):
    if i in to_comment and not line.lstrip().startswith('//'):
        out.append('// ' + line)
    else:
        out.append(line)

open(path, 'w', encoding='utf-8').writelines(out)
print(f'Done. Commented out {len(to_comment)} lines in {path}.')
