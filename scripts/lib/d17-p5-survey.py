# -*- coding: utf-8 -*-
"""D17/P5 只读测绘辅助：列出入口的 HTTP 调用与顶层动作定义。

用法：python scripts/lib/d17-p5-survey.py [api|defs|writes NAME]
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

INDEX = 'src/client/index.tsx'
src = open(INDEX, encoding='utf-8', newline='').read().replace('\r\n', '\n')
lines = src.split('\n')

mode = sys.argv[1] if len(sys.argv) > 1 else 'api'

if mode == 'api':
    for i, l in enumerate(lines, 1):
        if re.search(r'\bapi[<(]|\bfetch\(', l):
            m = re.search(r"['\"`](/api/[^'\"`]+)", l)
            print('L%-5d %s' % (i, m.group(1) if m else l.strip()[:100]))
elif mode == 'defs':
    for i, l in enumerate(lines, 1):
        if re.match(r'^  (const|function) [A-Za-z_$][\w$]*\s*(:|=)', l):
            print('L%-5d %s' % (i, l.strip()[:120]))
elif mode == 'writes':
    name = sys.argv[2]
    setter = 'set' + name[0].upper() + name[1:]
    for i, l in enumerate(lines, 1):
        if re.search(r'\b%s\b' % re.escape(setter), l) or re.search(
            r'\b%sRef\.current\s*=' % re.escape(name), l
        ):
            print('L%-5d %s' % (i, l.strip()[:130]))
else:
    print('unknown mode', mode)
