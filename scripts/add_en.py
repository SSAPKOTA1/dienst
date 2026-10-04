#!/usr/bin/env python3
"""Append translations to apps/web/src/i18n/extra-en.ts. Usage: add_en.py < file with lines `German => English`."""
import re, sys, json
p = 'apps/web/src/i18n/extra-en.ts'
s = open(p, encoding='utf8').read()
have = set(re.findall(r"^\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_]\w*)):", s, re.M))
have = {(a or b).replace("\\'", "'") for a, b in have}
add = []
for line in sys.stdin:
    line = line.rstrip('\n')
    if ' => ' not in line: continue
    de, en = line.split(' => ', 1)
    de, en = de.strip(), en.strip()
    if de in have: continue
    have.add(de)
    q = lambda x: "'" + x.replace('\\', '\\\\').replace("'", "\\'") + "'"
    add.append(f"  {q(de)}: {q(en)},\n")
idx = s.rstrip().rfind('};')
s = s[:idx] + ''.join(add) + s[idx:]
open(p, 'w', encoding='utf8').write(s)
print(f'added {len(add)}')
