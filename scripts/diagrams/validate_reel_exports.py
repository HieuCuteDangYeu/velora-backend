#!/usr/bin/env python3
"""Check editable SVG fidelity and bounded source evidence for changed Reel pages."""
from pathlib import Path
import json
import os
import re
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]
DIRECTORY = REPO / 'docs/diagrams/velora-current'
MOBILE = Path(os.environ.get('VELORA_MOBILE_ROOT', '/home/hieucutedangyeu/Velora-Mobile'))
CHANGED = {
    '01-microservices-architecture', '02-application-architecture', '08-dfd-media',
    '08a-dfd-streaming', '09-dfd-index', '13-content',
    '20a-auth-refresh-standard', '20b-auth-refresh-deduplication', '20c-auth-refresh-recovery-theft',
    '27a-reel-upload-flow', '27b-reel-publish-idempotency',
    '28a-media-playback-readiness', '28b-media-evidence-pipeline',
    '29a-index-intake-routing', '29b-index-multimodal-extraction', '29c-index-vectorization-staging',
    '32a-feed-cache-paging', '32b-feed-background-refill',
    '39a-rag-scope-routing', '39b-rag-search-rerank',
    '41a-rag-streamed-generation', '41b-rag-verification-attribution',
    '17a-auth-registration-request', '17b-auth-email-verification',
    '23a-friend-send-request', '23b-friend-accept-request',
    '24a-friend-reject-request', '24b-friend-cancel-request', '24c-friend-unfriend',
    '30a-index-checkpoint-resume', '30b-index-stale-fencing',
    '31a-index-atomic-activation', '31b-index-rollback-recovery',
    '34a-hls-owner-preview', '34b-hls-validated-stream',
    '35a-series-creation-flow', '35b-series-reels-ordering',
    '36a-series-playback-entry', '36b-series-episode-switch',
    '37a-share-to-ai-assistant', '37b-share-to-user-chat',
    '38a-share-link-generation', '38b-share-link-resolution',
    '40a-rag-turn-memory-assembly', '40b-rag-summary-maintenance',
    '42a-observability-trace-capture', '42b-observability-trace-analysis',
}


def canonical(element):
    return ET.canonicalize(ET.tostring(element, encoding='unicode'))


def references(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from references(child)
    elif isinstance(value, list):
        for child in value:
            yield from references(child)
    elif isinstance(value, str) and re.fullmatch(r'(backend|mobile):.+:\d+-\d+', value):
        yield value


def main():
    document = ET.parse(DIRECTORY / 'velora-architecture.drawio').getroot()
    pages = {page.attrib['id']: page for page in document.findall('diagram')}
    assert CHANGED <= pages.keys(), 'missing required Reel pages'
    for page_id, page in pages.items():
        model = page.find('mxGraphModel')
        assert model is not None and model.find('root') is not None, page_id
        assert not model.findall('mxCell'), f'{page_id}: cells must belong to mxGraphModel/root'
        svg = ET.parse(DIRECTORY / 'importable-svg' / f'{page_id}.drawio.svg').getroot()
        embedded = ET.fromstring(svg.attrib['content'])
        assert embedded.tag == 'mxfile' and len(embedded.findall('diagram')) == 1, page_id
        assert canonical(embedded.find('diagram')) == canonical(page), page_id
        if page_id in CHANGED:
            assert sum(node.tag.rsplit('}', 1)[-1] in {'path', 'rect', 'text', 'foreignObject'} for node in svg.iter()) > 10, f'{page_id}: missing visible SVG body'
            for node in svg.iter():
                for attribute in ('fill', 'stroke', 'style'):
                    assert 'light-dark(' not in node.attrib.get(attribute, ''), f'{page_id}: nonportable SVG paint'
    combined = ET.parse(DIRECTORY / 'velora-diagrams.drawio.svg').getroot()
    assert canonical(ET.fromstring(combined.attrib['content'])) == canonical(document), 'combined payload mismatch'
    refs = set()
    for page_id in CHANGED:
        for node in pages[page_id].iter():
            for attribute in ('sourceEvidence', 'semanticModel'):
                if node.attrib.get(attribute):
                    refs.update(references(json.loads(node.attrib[attribute])))
    counts = {}
    for reference in refs:
        match = re.fullmatch(r'(backend|mobile):(.+):(\d+)-(\d+)', reference)
        prefix, filename, start, end = match.groups()
        path = (REPO if prefix == 'backend' else MOBILE) / filename
        assert path.is_file(), reference
        if path not in counts:
            counts[path] = len(path.read_text().splitlines())
        assert 1 <= int(start) <= int(end) <= counts[path], reference
    print(f'PASS: {len(pages)} editable page payloads + combined; {len(CHANGED)} portable visible exports; {len(refs)} distinct bounded evidence references')
    print('Evidence range validity is not semantic or rendered visual acceptance.')


if __name__ == '__main__':
    main()
