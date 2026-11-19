#!/usr/bin/env python3
"""Idempotent edits to the hand-maintained pages (DFD context, DFD notes, ER, authorization sequence).

Run after build_and_modernize_all_diagrams.py and architecture_pages.py, before export_drawio_figures.py.
Each edit asserts that the text it replaces is present (or already replaced), so a drifting page fails loudly.
"""
from pathlib import Path
import copy
import html
import json
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drawio_kit import ev  # noqa: E402

MASTER = Path(__file__).resolve().parents[2] / 'docs/diagrams/velora-current/velora-architecture.drawio'


def cell(page, cell_id):
    for node in page.iter('mxCell'):
        if node.attrib.get('id') == cell_id:
            return node
    raise KeyError(f'{page.attrib["id"]}: no cell {cell_id}')


def replace_value(page, cell_id, old, new):
    node = cell(page, cell_id)
    value = node.attrib['value']
    if new in value:
        return
    assert old in value, f'{page.attrib["id"]}/{cell_id}: expected {old!r} in {value!r}'
    node.set('value', value.replace(old, new))


def evidence(*refs):
    return json.dumps(list(refs))


def patch_context(page):
    if any(n.attrib.get('id') == 'push' for n in page.iter('mxCell')):
        return
    root = page.find('mxGraphModel/root')
    p1 = cell(page, 'p1')
    mail = cell(page, 'mail')
    # external participant: push notification provider, drawn like the email provider
    push = copy.deepcopy(mail)
    push.set('id', 'push')
    push.set('sourceEvidence', evidence(ev('apps/notification-service/src/infrastructure/gateways/firebase-admin.gateway.ts', None, 30),
                                        ev('apps/notification-service/src/infrastructure/gateways/apns-voip.gateway.ts', None, 30)))
    geom = push.find('mxGeometry')
    geom.set('x', '1090')
    geom.set('y', '600')
    label = copy.deepcopy(cell(page, 'mail-label'))
    label.set('id', 'push-label')
    label.set('parent', 'push')
    label.set('value', 'Push notification<br>provider')
    flow = copy.deepcopy(cell(page, '03-dfd-context-mail'))
    flow.set('id', '03-dfd-context-push')
    flow.set('target', 'push')
    flow.set('dataset', 'Push message')
    flow.set('sourceEvidence', evidence(ev('apps/notification-service/src/application/use-cases/process-notification-job.use-case.ts', r'processVisibleNotificationJob'),
                                        ev('apps/call-service/src/infrastructure/publishers/rabbit-call-event.publisher.ts', r'withDeclineToken')))
    style = flow.attrib['style'].replace('exitX=0.5;exitY=1.0;entryX=0.5;entryY=0.0;', 'exitX=0.9;exitY=1.0;entryX=0.5;entryY=0.0;')
    flow.set('style', style)
    flow.find('mxGeometry/Array').append(ET.Element('mxPoint', x='842', y='490'))
    flow.find('mxGeometry/Array').append(ET.Element('mxPoint', x='1220', y='490'))
    background = copy.deepcopy(cell(page, '03-dfd-context-mail-background'))
    background.set('id', '03-dfd-context-push-background')
    flow_label = copy.deepcopy(cell(page, '03-dfd-context-mail-label'))
    flow_label.set('id', '03-dfd-context-push-label')
    flow_label.set('value', 'Push message')
    for node in (background, flow_label):
        g = node.find('mxGeometry')
        g.set('x', '1160')
        g.set('y', '505')
        g.set('width', '104')
    anchor = list(root).index(cell(page, '03-dfd-context-mail-label')) + 1
    for offset, node in enumerate((push, label, flow, background, flow_label)):
        root.insert(anchor + offset, node)
    replace_value(page, 'legend', 'Operational monitoring is outside this logical DFD; see 42.',
                  'Operational monitoring is outside this logical DFD; see 02c and 42. Push delivery is the same D0 process (45a); Velora-Mobile is the only client.')


def patch_dfd_notes(root_page):
    pages = {p.attrib['id']: p for p in root_page.findall('diagram')}
    rag = pages['11-dfd-rag']
    replace_value(rag, 'p1-label', 'Resolve question context', 'Screen question and<br>resolve context')
    replace_value(rag, 'p3-label', 'Produce grounded answer', 'Produce, screen and<br>cite grounded answer')
    replace_value(rag, 'legend', 'Answer production', 'Guardrails screen the question, retrieved evidence and answer (43b); a photo is first turned into text (43a); a question about the conversation also searches older messages (43c). Answer production')
    memory = pages['11a-dfd-memory']
    replace_value(memory, 'p2-label', 'Derive durable memory', 'Derive and screen<br>durable memory')
    replace_value(memory, 'legend', 'Memory updates are', 'Text with a high-severity guardrail finding is never stored (43b). Memory updates are')
    content = pages['07-dfd-content']
    replace_value(content, 'legend', 'Series ordering,', 'Subtitle tracks per language are produced after indexing and served with the Reel (44a). Series ordering,')
    media = pages['08-dfd-media']
    replace_value(media, 'legend', 'Accept-original includes', 'Evidence is built after the encode on the same worker, with a queued fallback (28b). Accept-original includes')


def patch_content_er(page):
    if any(n.attrib.get('id') == 'ReelSubtitleTrack' for n in page.iter('mxCell')):
        return
    root = page.find('mxGraphModel/root')
    reel = cell(page, 'Reel')
    fields = cell(page, 'Reel_fields')
    fields.set('value', fields.attrib['value'].replace('visibility: String', 'searchTags: String [0..*]<br>visibility: String'))
    reel.find('mxGeometry').set('height', '269')
    fields.find('mxGeometry').set('height', '217')
    # the Series association leaves the bottom edge of Reel; keep its bend below the taller box
    series = cell(page, 'E02-content-e1')
    for point in series.iter('mxPoint'):
        if point.attrib.get('y') == '1198.390944':
            point.set('y', '1222.390944')

    entity_style = reel.attrib['style']
    field_style = fields.attrib['style']
    anchor = list(root).index(cell(page, 'Reel_fields')) + 1

    def entity(entity_id, title, owner, x, y, w, lines, refs):
        height = 52 + 24 + 22 * len(lines)
        box = ET.Element('mxCell', id=entity_id, value=f'<b>{title}</b><br>{owner}', vertex='1', parent='1', style=entity_style,
                         sourceEvidence=json.dumps(refs), semanticId=entity_id, domainRole='entity', tooltip=f'{title}   content service · PostgreSQL schema')
        ET.SubElement(box, 'mxGeometry', {'as': 'geometry', 'x': str(x), 'y': str(y), 'width': str(w), 'height': str(height)})
        body = ET.Element('mxCell', id=f'{entity_id}_fields', value='<br>'.join(lines), vertex='1', parent=entity_id, style=field_style)
        ET.SubElement(body, 'mxGeometry', {'as': 'geometry', 'x': '0', 'y': '52', 'width': str(w), 'height': str(24 + 22 * len(lines))})
        return box, body

    schema = 'apps/content-service/prisma/schema.prisma'
    track, track_fields = entity('ReelSubtitleTrack', 'ReelSubtitleTrack', 'Content', 1560, 930, 470, [
        'id: String {PK}', 'reelId: String', 'language: String', 'sourceHash: String', 'cues: Json', 'model: String', 'createdAt: DateTime', 'updatedAt: DateTime',
    ], [ev(schema, r'model ReelSubtitleTrack', 14)])
    exposure, exposure_fields = entity('ReelRerankExposure', 'ReelRerankExposure', 'Content', 1560, 1335, 470, [
        'feedSessionId: String {PK}', 'reelId: String {PK}', 'userId: String', 'arm: String', 'baseRank: Int', 'rerankedRank: Int', 'crossScore: Float', 'topK: Int', 'weight: Float', 'createdAt: DateTime',
    ], [ev(schema, r'model ReelRerankExposure', 16)])
    for offset, node in enumerate((track, track_fields, exposure, exposure_fields)):
        root.insert(anchor + offset, node)

    edge_style = cell(page, 'E02-content-e1').attrib['style']
    edge_style = edge_style.replace('exitX=0.43199999999999983;exitY=0.9999999999999994;entryX=0.5;entryY=0.0;', 'exitX=0.0;exitY=0.5;entryX=1.0;entryY=0.5;')
    edge = ET.Element('mxCell', id='E02-content-e8', value='reel', edge='1', parent='1', source='ReelSubtitleTrack', target='Reel', style=edge_style,
                      sourceEvidence=json.dumps([ev(schema, r'model ReelSubtitleTrack', 14)]), relationKind='association', enforcement='declared relation')
    geometry = ET.SubElement(edge, 'mxGeometry', {'as': 'geometry', 'relative': '1', 'x': '0', 'y': '-14'})
    ET.SubElement(geometry, 'Array', {'as': 'points'})
    many = ET.Element('mxCell', id='E02-content-e8_multiplicity0', value='0..*', vertex='1', parent='E02-content-e8', style=cell(page, 'E02-content-e1_multiplicity0').attrib['style'])
    g = ET.SubElement(many, 'mxGeometry', {'as': 'geometry', 'x': '-1', 'y': '0', 'width': '29', 'height': '20', 'relative': '1'})
    ET.SubElement(g, 'mxPoint', {'as': 'offset', 'x': '-34', 'y': '-26'})
    one = ET.Element('mxCell', id='E02-content-e8_multiplicity1', value='1', vertex='1', parent='E02-content-e8', style=cell(page, 'E02-content-e1_multiplicity1').attrib['style'])
    g = ET.SubElement(one, 'mxGeometry', {'as': 'geometry', 'x': '1', 'y': '0', 'width': '20', 'height': '20', 'relative': '1'})
    ET.SubElement(g, 'mxPoint', {'as': 'offset', 'x': '8', 'y': '-26'})
    root.insert(list(root).index(track_fields) + 1, edge)
    root.insert(list(root).index(edge) + 1, many)
    root.insert(list(root).index(many) + 1, one)

    model = page.find('mxGraphModel')
    model.set('pageWidth', '2495.0')
    model.set('schemaConstraints', model.attrib['schemaConstraints'] + ' ReelSubtitleTrack UNIQUE(reelId, language); reel: reelId cascade delete (declared SQL FK); sourceHash ties a track to the transcript it was translated from. ReelRerankExposure PK is (feedSessionId, reelId); its userId and reelId are logical scalar IDs joined to ReelViewEvent, not declared FKs. Reel.searchTags is a normalized copy of tags kept by a database trigger and indexed with GIN.')
    note = cell(page, 'notes')
    note.set('value', note.attrib['value'] + '<br>Subtitle tracks cascade with their Reel. Rerank exposure rows are experiment measurements keyed by feed session and Reel; they are not part of the Reel aggregate.')
    note.find('mxGeometry').set('height', '190')


def patch_authorization(page):
    replace_value(page, 's20', 'friend.can_view_reel_content(viewer,<br>owner,visibility)',
                  'owner and private Reels are decided inside Content;<br>otherwise friend.can_view_reel_content(viewer,<br>owner, visibility), allowed answers cached 15 s')


def main():
    tree = ET.parse(MASTER)
    root = tree.getroot()
    pages = {p.attrib['id']: p for p in root.findall('diagram')}
    patch_context(pages['03-dfd-context'])
    patch_dfd_notes(root)
    patch_content_er(pages['13-content'])
    patch_authorization(pages['21-auth-authorization'])
    MASTER.write_text(ET.tostring(root, encoding='unicode'))
    print('patched hand-maintained pages')


if __name__ == '__main__':
    main()
