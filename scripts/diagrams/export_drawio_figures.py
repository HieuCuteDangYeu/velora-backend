#!/usr/bin/env python3
"""Export every page of the master draw.io file with native draw.io figures and exact editable payloads."""
from pathlib import Path
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]
DIRECTORY = REPO / 'docs/diagrams/velora-current'


def embed(svg, payload):
    match = re.search(r'<svg\b[^>]*>', svg, re.S)
    assert match, 'native exporter returned no SVG root'
    opening = re.sub(r'\scontent="[^"]*"', '', match.group(0))
    opening = opening[:-1] + f' content="{html.escape(payload, quote=True)}">'
    return svg[:match.start()] + opening + svg[match.end():]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--png-dir', type=Path)
    args = parser.parse_args()
    binary = os.environ.get('DRAWIO_BIN') or shutil.which('drawio')
    if not binary:
        raise SystemExit('Set DRAWIO_BIN to the native draw.io desktop executable')
    launcher = ['xvfb-run', '-a'] if os.name == 'posix' and not os.environ.get('DISPLAY') and shutil.which('xvfb-run') else []
    document = (DIRECTORY / 'velora-architecture.drawio').read_text()
    root = ET.fromstring(document)
    payloads = {}
    with tempfile.TemporaryDirectory(prefix='velora-drawio-native-') as directory:
        temp = Path(directory)
        inputs = temp / 'sources'
        outputs = temp / 'svg'
        inputs.mkdir()
        outputs.mkdir()
        for page in root.findall('diagram'):
            name = page.attrib['id']
            payload = '<mxfile host="app.diagrams.net" type="device">' + ET.tostring(page, encoding='unicode') + '</mxfile>'
            payloads[name] = payload
            (inputs / f'{name}.drawio').write_text(payload)
        stale = {path.name[:-len('.drawio.svg')] for path in (DIRECTORY / 'importable-svg').glob('*.drawio.svg')} - set(payloads)
        for name in stale:
            (DIRECTORY / 'importable-svg' / f'{name}.drawio.svg').unlink()
        common = launcher + [binary, '--no-sandbox', '--disable-update', '--export', '--theme', 'light', '--border', '20', '--timeout', '60']
        subprocess.run(common + ['--format', 'svg', '--embed-diagram', '--uncompressed', '--embed-svg-fonts', 'false', '--output', str(outputs), str(inputs)], check=True)
        for name, payload in payloads.items():
            svg = (outputs / f'{name}.svg').read_text()
            (DIRECTORY / 'importable-svg' / f'{name}.drawio.svg').write_text(embed(svg, payload))
        first = (outputs / '01-microservices-architecture.svg').read_text()
        (DIRECTORY / 'velora-diagrams.drawio.svg').write_text(embed(first, document))
        if args.png_dir:
            args.png_dir.mkdir(parents=True, exist_ok=True)
            subprocess.run(common + ['--format', 'png', '--output', str(args.png_dir), str(inputs)], check=True)
    index = ['# Velora diagrams', '',
             'Master file: `velora-architecture.drawio` (one page per diagram, in the order below). Each page is exported natively by draw.io to `importable-svg/<id>.drawio.svg` with its editable XML embedded; `velora-diagrams.drawio.svg` embeds the complete multi-page file.',
             'Regenerate with `DRAWIO_BIN=<draw.io desktop> python3 scripts/diagrams/export_drawio_figures.py` and check with `python3 scripts/diagrams/validate_reel_exports.py`.', '',
             '| # | Diagram | Export |', '|---|---|---|']
    for number, page in enumerate(root.findall('diagram'), 1):
        name = page.attrib['id']
        index.append(f"| {number} | {page.attrib['name']} | [`{name}.drawio.svg`](importable-svg/{name}.drawio.svg) |")
    (DIRECTORY / 'README.md').write_text('\n'.join(index) + '\n')
    print(f'Exported {len(payloads)} pages with native draw.io figures and editable XML')


if __name__ == '__main__':
    main()
