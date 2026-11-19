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
from diagram_summaries import DFD_SUMMARIES, ER_SUMMARIES  # noqa: E402
import re  # noqa: E402

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
    """The context DFD has no push provider: notification delivery is outside the design."""
    root = page.find('mxGraphModel/root')
    for node in list(root):
        if node.attrib.get('id') in ('push', 'push-label', '03-dfd-context-push', '03-dfd-context-push-background', '03-dfd-context-push-label'):
            root.remove(node)
    import re
    legend = cell(page, 'legend')
    legend.set('value', re.sub(r'Operational monitoring.*$', 'Operational monitoring is outside this logical DFD; see 02c and 42. Velora-Mobile is the only client.', legend.attrib['value']))


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


INK = '#1F2937'
OWNER_STYLE = {  # entity header colour by owning service
    'Auth': ('#F5F0FF', '#8B5CF6'), 'User': ('#ECFDF5', '#34A853'), 'Friend': ('#EAF3FF', '#2F80ED'),
    'Content': ('#FFF7E6', '#F59E0B'), 'AI': ('#FDF4FF', '#C026D3'), 'Indexing': ('#EFF6FF', '#3B82F6'),
    'Conversation': ('#FFF1F2', '#E11D48'),
}


def set_style(node, **updates):
    parts = [p for p in node.attrib.get('style', '').split(';') if p]
    keys = {p.split('=')[0]: i for i, p in enumerate(parts) if '=' in p}
    for key, value in updates.items():
        entry = f'{key}={value}'
        if key in keys:
            parts[keys[key]] = entry
        else:
            parts.append(entry)
    node.set('style', ';'.join(parts) + ';')


def add_summary(page, text, anchors):
    """Insert an 'In plain words' box under the title cells and push the diagram down to make room."""
    root = page.find('mxGraphModel/root')
    existing = [n for n in root if n.attrib.get('id') == 'summary-box']
    anchor_cells = [cell(page, a) for a in anchors]
    base = max(float(c.find('mxGeometry').attrib['y']) + float(c.find('mxGeometry').attrib['height']) for c in anchor_cells)
    width = min(1300, float(anchor_cells[0].find('mxGeometry').attrib['width']))
    lines = sum(max(1, -(-len(part) // int((width - 40) / 7.6))) for part in text.split('\n'))
    height = 44 + lines * 22
    if existing:
        cell(page, 'summary-text').set('value', html.escape(text))
        return
    dy = height + 25
    skip = {'title', 'subtitle'}
    for node in root:
        if node.attrib.get('parent') != '1' or node.attrib.get('id') in skip:
            continue
        geometry = node.find('mxGeometry')
        if geometry is None:
            continue
        if node.attrib.get('edge') == '1':
            for point in geometry.iter('mxPoint'):
                if point.attrib.get('as') == 'offset':
                    continue
                if 'y' in point.attrib:
                    point.set('y', str(round(float(point.attrib['y']) + dy, 3)))
        elif 'y' in geometry.attrib:
            geometry.set('y', str(round(float(geometry.attrib['y']) + dy, 3)))
    x = anchor_cells[0].find('mxGeometry').attrib['x']
    box = ET.Element('mxCell', id='summary-box', value='In plain words', vertex='1', parent='1',
                     style='rounded=1;arcSize=6;html=1;whiteSpace=wrap;fontFamily=Helvetica;fontSize=15;fontStyle=1;fontColor=#B45309;fillColor=#FFFBEB;strokeColor=#F59E0B;strokeWidth=1.6;align=left;verticalAlign=top;spacingLeft=16;spacingTop=10;')
    ET.SubElement(box, 'mxGeometry', {'as': 'geometry', 'x': x, 'y': str(round(base + 10, 1)), 'width': str(width), 'height': str(height)})
    body = ET.Element('mxCell', id='summary-text', value=html.escape(text), vertex='1', parent='1',
                      style=f'text;html=1;whiteSpace=wrap;fontFamily=Helvetica;fontSize=15;fontColor={INK};align=left;verticalAlign=top;strokeColor=none;fillColor=none;')
    ET.SubElement(body, 'mxGeometry', {'as': 'geometry', 'x': str(float(x) + 16), 'y': str(round(base + 42, 1)), 'width': str(width - 32), 'height': str(lines * 22 + 6)})
    index = max(list(root).index(c) for c in anchor_cells) + 1
    root.insert(index, box)
    root.insert(index + 1, body)
    model = page.find('mxGraphModel')
    model.set('pageHeight', str(round(float(model.attrib.get('pageHeight', '1000')) + dy, 1)))


def restyle_dfd(page):
    for node in page.iter('mxCell'):
        style = node.attrib.get('style', '')
        if not style:
            continue
        style = style.replace('fontFamily=Arial', 'fontFamily=Helvetica')
        node.set('style', style)
        if 'fillColor=#315875' in style:  # process
            set_style(node, fillColor='#ECFDF5', strokeColor='#34A853', strokeWidth='2', arcSize='16')
        elif 'fillColor=#f0ad64' in style:  # external participant
            set_style(node, fillColor='#EAF3FF', strokeColor='#2F80ED', strokeWidth='2', rounded='1', arcSize='12')
        elif 'fillColor=#f2f7ed' in style:  # data store
            set_style(node, fillColor='#F1F5F9', strokeColor='#475569', strokeWidth='2')
        elif 'strokeColor=#687782' in style:  # data flow
            set_style(node, strokeColor='#475569', strokeWidth='1.8')
        if node.attrib.get('vertex') == '1' and 'text;' in style:
            if 'fontColor=white' in style:
                set_style(node, fontColor='#047857')
            elif 'fontColor=#579539' in style:
                set_style(node, fontColor='#475569')
            elif 'fontColor=#253849' in style:
                set_style(node, fontColor=INK)
    legend = [n for n in page.iter('mxCell') if n.attrib.get('id') == 'legend']
    if legend:
        value = legend[0].attrib['value']
        value = value.replace('Orange: external participant. Navy: transformation. Green open-ended symbol: retained data.',
                              'Blue box: outside participant. Green box: process. Grey open-ended box: stored data.')
        value = value.replace('Orange: external participant. Navy: transformation. Green: retained data.',
                              'Blue box: outside participant. Green box: process. Grey open-ended box: stored data.')
        legend[0].set('value', value)


def restyle_er(page):
    model = page.find('mxGraphModel')
    model.set('adaptiveColors', 'none')
    for node in page.iter('mxCell'):
        style = node.attrib.get('style', '')
        if not style:
            continue
        style = style.replace('light-dark(#202020,#eeeeee)', INK).replace('light-dark(#ffffff,#181818)', '#ffffff').replace('fontFamily=Arial', 'fontFamily=Helvetica')
        node.set('style', style)
        if node.attrib.get('domainRole') == 'entity':
            owner = re.sub('<[^>]+>', ' ', node.attrib['value']).split()[-1]
            fill, stroke = OWNER_STYLE.get(owner, ('#F1F5F9', '#475569'))
            set_style(node, fillColor=fill, strokeColor=stroke, strokeWidth='2', rounded='1', arcSize='5', swimlaneFillColor='#ffffff', fontStyle='1')
        elif node.attrib.get('edge') == '1':
            set_style(node, strokeColor='#475569', strokeWidth='1.6')


def relayout_identity(page):
    """Page 12: Auth entities on the left, Friend entities on the right, User in the middle, so no line crosses another."""
    summary = cell(page, 'summary-box').find('mxGeometry')
    y0 = float(summary.attrib['y']) + float(summary.attrib['height']) + 35
    spots = {'RefreshToken': (100, 0), 'UserRole': (100, 300), 'Role': (100, 560), 'Friendship': (1900, 0), 'UserBlock': (1900, 300), 'User': (1000, 240)}
    for name, (x, dy) in spots.items():
        geometry = cell(page, name).find('mxGeometry')
        geometry.set('x', str(x))
        geometry.set('y', str(round(y0 + dy, 1)))
    cell(page, 'User').find('mxGeometry').set('height', '260')
    ports = {'E01-identity-social-e1': ((0.5, 1), (0.5, 0)), 'E01-identity-social-e2': ((1, 0.5), (0, 0.8)), 'E01-identity-social-e3': ((1, 0.9), (0, 0.2)),
             'E01-identity-social-e4': ((0, 0.25), (1, 0.1)), 'E01-identity-social-e4_second': ((0, 0.75), (1, 0.3)),
             'E01-identity-social-e5': ((0, 0.25), (1, 0.7)), 'E01-identity-social-e5_second': ((0, 0.75), (1, 0.9))}
    for edge_id, (out, into) in ports.items():
        edge = cell(page, edge_id)
        for array in edge.findall('mxGeometry/Array'):
            array.clear()
            array.set('as', 'points')
        parts = [q for q in edge.attrib['style'].split(';') if q and not q.startswith(('exit', 'entry', 'edgeStyle', 'noEdgeStyle', 'rounded'))]
        parts += ['edgeStyle=orthogonalEdgeStyle', 'rounded=1', f'exitX={out[0]}', f'exitY={out[1]}', f'entryX={into[0]}', f'entryY={into[1]}']
        edge.set('style', ';'.join(parts) + ';')
    loop = cell(page, 'E01-identity-social-e6')
    for array in loop.findall('mxGeometry/Array'):
        array.clear()
        array.set('as', 'points')
        ET.SubElement(array, 'mxPoint', x='620', y=str(round(y0 + 40, 1)))
        ET.SubElement(array, 'mxPoint', x='620', y=str(round(y0 + 120, 1)))
    parts = [q for q in loop.attrib['style'].split(';') if q and not q.startswith(('exit', 'entry', 'edgeStyle', 'noEdgeStyle', 'rounded'))]
    loop.set('style', ';'.join(parts + ['edgeStyle=orthogonalEdgeStyle', 'rounded=1', 'exitX=1', 'exitY=0.2', 'entryX=1', 'entryY=0.65']) + ';')
    model = page.find('mxGraphModel')
    model.set('pageWidth', '2500')
    note = cell(page, 'notes').find('mxGeometry')
    note.set('y', str(round(y0 + 780, 1)))
    model.set('pageHeight', str(round(y0 + 900, 1)))


def restyle_all(root):
    pages = {p.attrib['id']: p for p in root.findall('diagram')}
    for pid, page in pages.items():
        if '-dfd-' in pid:
            restyle_dfd(page)
            add_summary(page, DFD_SUMMARIES[pid], ['title', 'subtitle'])
    for pid in ER_SUMMARIES:
        restyle_er(pages[pid])
        add_summary(pages[pid], ER_SUMMARIES[pid], ['title'])
    relayout_identity(pages['12-identity-social'])


def main():
    tree = ET.parse(MASTER)
    root = tree.getroot()
    pages = {p.attrib['id']: p for p in root.findall('diagram')}
    patch_context(pages['03-dfd-context'])
    patch_dfd_notes(root)
    patch_content_er(pages['13-content'])
    restyle_all(root)
    MASTER.write_text(ET.tostring(root, encoding='unicode'))
    print('patched hand-maintained pages')


if __name__ == '__main__':
    main()
