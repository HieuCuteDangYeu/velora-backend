#!/usr/bin/env python3
"""Move `backend:path:start-end` / `mobile:path:start-end` evidence references to the current line numbers.

The diagram pages cite bounded source ranges. After the code moves, a range that is still inside the file
can point at unrelated lines, so this maps every cited range from the commit the suite was last audited
against (--backend-base / --mobile-base) to HEAD through the git diff of that file, and reports which
ranges touch changed lines (those cited behaviours must be re-read by a person).

    python3 scripts/diagrams/reanchor_evidence.py --report            # list touched references per page
    python3 scripts/diagrams/reanchor_evidence.py --apply             # rewrite generator + master file
"""
from pathlib import Path
import argparse
import collections
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]
MOBILE = Path(os.environ.get('VELORA_MOBILE_ROOT', '/home/hieucutedangyeu/Velora-Mobile'))
GENERATOR = REPO / 'scripts/diagrams/build_and_modernize_all_diagrams.py'
MASTER = REPO / 'docs/diagrams/velora-current/velora-architecture.drawio'
TOKEN = re.compile(r'\b(backend|mobile):([A-Za-z0-9_./\[\]()@-]+):(\d+)-(\d+)')


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True).stdout


class FileMap:
    def __init__(self, repo, base, path):
        self.hunks = []  # (old_start, old_len, new_start, new_len)
        self.exists = (repo / path).is_file()
        self.length = len((repo / path).read_text(errors='replace').splitlines()) if self.exists else 0
        for line in git(repo, 'diff', '-U0', base, 'HEAD', '--', path).splitlines():
            match = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', line)
            if match:
                a, b, c, d = match.groups()
                self.hunks.append((int(a), 1 if b is None else int(b), int(c), 1 if d is None else int(d)))

    def map_line(self, n, end):
        offset = 0
        for a, b, c, d in self.hunks:
            if b == 0:  # insertion after old line a
                if n > a:
                    offset += d
                continue
            if n < a:
                break
            if n < a + b:  # changed old line
                return (c + d - 1 if end else c) if d else c
            offset += d - b
        return n + offset

    def touched(self, s, e):
        for a, b, c, d in self.hunks:
            if b == 0:
                if s <= a < e:
                    return True
            elif a <= e and s <= a + b - 1:
                return True
        return False

    def remap(self, s, e):
        ns, ne = self.map_line(s, False), self.map_line(e, True)
        if self.length:
            ne = min(ne, self.length)
            ns = min(ns, ne)
        return max(ns, 1), max(ne, 1)


def collect_generator():
    sys.path.insert(0, str(REPO / 'scripts/diagrams'))
    import importlib.util
    spec = importlib.util.spec_from_file_location('gen', GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def walk(value, found):
        if isinstance(value, dict):
            for v in value.values():
                walk(v, found)
        elif isinstance(value, (list, tuple)):
            for v in value:
                walk(v, found)
        elif isinstance(value, str):
            for m in TOKEN.finditer(value):
                found.add(m.group(0))
    pages = {}
    for model in module.SPLIT_MODELS:
        found = set()
        walk(model, found)
        pages[model['id']] = found
    return pages


def collect_master():
    root = ET.parse(MASTER).getroot()
    pages = {}
    for page in root.findall('diagram'):
        found = set()
        for node in page.iter():
            for value in node.attrib.values():
                for m in TOKEN.finditer(value):
                    found.add(m.group(0))
        pages[page.attrib['id']] = found
    return pages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend-base', default='48428793')
    parser.add_argument('--mobile-base', default='3c06fc2')
    parser.add_argument('--report', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--pages', help='comma-separated page ids to restrict the report')
    args = parser.parse_args()
    generated = collect_generator()
    master = collect_master()
    pages = {k: set(v) | generated.get(k, set()) for k, v in master.items()}
    for k, v in generated.items():
        pages.setdefault(k, set()).update(v)
    cache, mapping, touched = {}, {}, collections.defaultdict(list)
    missing = collections.defaultdict(list)
    for page, tokens in sorted(pages.items()):
        if args.pages and page not in args.pages.split(','):
            continue
        for token in sorted(tokens):
            kind, path, s, e = TOKEN.fullmatch(token).groups()
            repo, base = (REPO, args.backend_base) if kind == 'backend' else (MOBILE, args.mobile_base)
            key = (kind, path)
            if key not in cache:
                cache[key] = FileMap(repo, base, path)
            fm = cache[key]
            if not fm.exists:
                missing[page].append(token)
                continue
            ns, ne = fm.remap(int(s), int(e))
            mapping[token] = f'{kind}:{path}:{ns}-{ne}'
            if fm.touched(int(s), int(e)):
                touched[page].append((token, mapping[token]))
    total = sum(len(v) for v in pages.values())
    print(f'{total} references across {len(pages)} pages; {sum(len(v) for v in touched.values())} touch changed lines; {sum(len(v) for v in missing.values())} point at deleted files')
    if args.report:
        for page in sorted(set(touched) | set(missing)):
            print(f'\n## {page}: {len(touched.get(page, []))} touched, {len(missing.get(page, []))} deleted')
            for old, new in touched.get(page, []):
                print(f'   {old}  ->  {new}')
            for old in missing.get(page, []):
                print(f'   MISSING {old}')
    if args.apply:
        def sub(text):
            return TOKEN.sub(lambda m: mapping.get(m.group(0), m.group(0)), text)
        for file in (GENERATOR, MASTER):
            file.write_text(sub(file.read_text()))
        print('rewrote', GENERATOR.name, 'and', MASTER.name)


if __name__ == '__main__':
    main()
