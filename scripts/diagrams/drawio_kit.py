#!/usr/bin/env python3
"""Small builder for the hand-laid-out architecture pages of the Velora draw.io suite.

It only emits standard draw.io symbols (UML component / node / actor, cylinder3 data store, cloud,
phone, queue stencil) so every page stays editable in the draw.io desktop and web editors.
Every node and edge can carry source evidence (`backend:path:start-end`), and `ev()` resolves a
regular expression to the real line range, so the references never drift into the middle of a file.
"""
from pathlib import Path
import html
import json
import re
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]
MOBILE = Path('/home/hieucutedangyeu/Velora-Mobile')

# Semantic role palette (fill, stroke). Colour encodes the architectural role only.
ROLE = {
    'client': ('#EAF3FF', '#2F80ED'),
    'edge': ('#EAF3FF', '#2F80ED'),
    'api': ('#F5F0FF', '#8B5CF6'),
    'realtime': ('#FFF1F2', '#E11D48'),
    'messaging': ('#FFF7E6', '#F59E0B'),
    'processing': ('#EFF6FF', '#3B82F6'),
    'domain': ('#ECFDF5', '#34A853'),
    'ai': ('#FDF4FF', '#C026D3'),
    'ops': ('#ECFDF9', '#14B8A6'),
    'data': ('#F1F5F9', '#475569'),
    'external': ('#FFF5F5', '#EF4444'),
    'node': ('#F8FAFC', '#64748B'),
}
INK = '#1F2937'
MUTED = '#475569'
FONT = 'fontFamily=Helvetica;'

EDGE = {
    'sync': 'endArrow=block;endFill=1;strokeColor=#475569;strokeWidth=1.8;',
    'async': 'endArrow=open;endFill=0;dashed=1;dashPattern=8 4;strokeColor=#D97706;strokeWidth=1.8;',
    'data': 'endArrow=block;endFill=1;strokeColor=#64748B;strokeWidth=1.4;',
    'media': 'endArrow=block;endFill=1;strokeColor=#E11D48;strokeWidth=2.2;',
    'external': 'endArrow=open;endFill=0;dashed=1;dashPattern=3 3;strokeColor=#EF4444;strokeWidth=1.5;',
    'ops': 'endArrow=open;endFill=0;dashed=1;dashPattern=3 3;strokeColor=#0F766E;strokeWidth=1.4;',
    'link': 'endArrow=none;startArrow=none;strokeColor=#94A3B8;strokeWidth=1.2;dashed=1;',
}


def ev(path, pattern=None, span=24, root='backend'):
    """Return a bounded evidence reference; with a pattern the range starts at the first matching line."""
    base = REPO if root == 'backend' else MOBILE
    file = base / path
    assert file.is_file(), f'missing evidence file {root}:{path}'
    lines = file.read_text(errors='replace').splitlines()
    start = 1
    if pattern:
        for number, line in enumerate(lines, 1):
            if re.search(pattern, line):
                start = number
                break
        else:
            raise AssertionError(f'{root}:{path}: no line matches {pattern!r}')
    return f'{root}:{path}:{start}-{min(len(lines), start + span)}'


def mev(path, pattern=None, span=24):
    return ev(path, pattern, span, 'mobile')


def label(title, detail=None, size=13, detail_size=11):
    text = f'<b style="font-size:{size}px">{html.escape(title)}</b>'
    if detail:
        text += f'<br><span style="font-size:{detail_size}px;color:{MUTED}">' + '<br>'.join(html.escape(part) for part in detail.split('\n')) + '</span>'
    return text


class Page:
    def __init__(self, page_id, title, width, height, subtitle=None, scope=''):
        self.id = page_id
        self.title = title
        self.width = width
        self.height = height
        self.cells = []
        self.nodes = []
        self.edges = []
        self.n = 0
        self.scope = scope
        self.text(title, 40, 18, width - 80, 34, size=24, bold=True)
        if subtitle:
            self.text(subtitle, 40, 54, width - 80, 24, size=13, color=MUTED)

    def _id(self, name=None):
        self.n += 1
        return name or f'c{self.n}'

    def _cell(self, cid, value, style, x, y, w, h, evidence=(), vertex=True, parent='1', **attrs):
        self.cells.append(dict(id=cid, value=value, style=style, x=x, y=y, w=w, h=h, ev=list(evidence), parent=parent, attrs=attrs))
        return cid

    def text(self, value, x, y, w, h, size=12, bold=False, color=INK, align='left', wrap=True, raw=False):
        style = f'text;html=1;{FONT}fontSize={size};fontColor={color};align={align};verticalAlign=middle;whiteSpace=wrap;strokeColor=none;fillColor=none;' + ('fontStyle=1;' if bold else '')
        return self._cell(self._id(), value if raw else html.escape(value).replace('\n', '<br>'), style, x, y, w, h)

    def zone(self, zid, x, y, w, h, title, role='node', dashed=True, evidence=(), fill=True):
        f, s = ROLE[role]
        style = (f'rounded=1;arcSize=2;html=1;whiteSpace=wrap;{FONT}fontSize=13;fontStyle=1;fontColor={s};align=left;verticalAlign=top;spacingLeft=12;spacingTop=6;'
                 f'strokeColor={s};strokeWidth=1.5;' + (f'fillColor={f};opacity=60;' if fill else 'fillColor=none;') + ('dashed=1;dashPattern=8 4;' if dashed else ''))
        # opacity applies to text too, so keep the fill separate from the label
        if fill:
            self._cell(zid + '-bg', '', f'rounded=1;arcSize=2;html=1;strokeColor={s};strokeWidth=1.5;fillColor={f};opacity=45;' + ('dashed=1;dashPattern=8 4;' if dashed else ''), x, y, w, h, evidence)
            self._cell(zid, html.escape(title), f'text;html=1;{FONT}fontSize=13;fontStyle=1;fontColor={s};align=left;verticalAlign=top;spacingLeft=12;spacingTop=6;strokeColor=none;fillColor=none;', x, y, w, 30)
        else:
            self._cell(zid, html.escape(title), style, x, y, w, h, evidence)
        return zid

    def _register(self, nid, kind, title, detail, evidence):
        self.nodes.append(dict(id=nid, kind=kind, label=title, detail=detail or '', evidence=list(evidence)))

    def service(self, nid, x, y, w, h, title, detail=None, role='domain', evidence=()):
        f, s = ROLE[role]
        style = (f'shape=module;jettyWidth=18;jettyHeight=9;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.6;fontColor={INK};'
                 'align=center;verticalAlign=middle;spacingLeft=14;spacingRight=4;')
        self._register(nid, 'service', title, detail, evidence)
        return self._cell(nid, label(title, detail), style, x, y, w, h, evidence)

    def store(self, nid, x, y, w, h, title, detail=None, evidence=(), role='data'):
        f, s = ROLE[role]
        style = (f'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.6;fontColor={INK};verticalAlign=middle;')
        self._register(nid, 'data store', title, detail, evidence)
        return self._cell(nid, label(title, detail, 12, 10), style, x, y, w, h, evidence)

    def bucket(self, nid, x, y, w, h, title, detail=None, evidence=()):
        f, s = ROLE['data']
        style = (f'shape=mxgraph.networks.storage;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.6;fontColor={INK};'
                 'verticalLabelPosition=bottom;verticalAlign=top;labelPosition=center;align=center;')
        self._register(nid, 'object storage', title, detail, evidence)
        return self._cell(nid, label(title, detail, 12, 10), style, x, y, w, h, evidence)

    def cloud(self, nid, x, y, w, h, title, detail=None, evidence=(), role='external'):
        f, s = ROLE[role]
        style = (f'shape=cloud;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.6;fontColor={INK};align=center;verticalAlign=middle;')
        self._register(nid, 'external system', title, detail, evidence)
        return self._cell(nid, label(title, detail, 12, 10), style, x, y, w, h, evidence)

    def actor(self, nid, x, y, w, h, title, evidence=()):
        f, s = ROLE['client']
        style = (f'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.8;fontColor={INK};')
        self._register(nid, 'actor', title, '', evidence)
        return self._cell(nid, label(title, None, 13), style, x, y, w, h, evidence)

    def phone(self, nid, x, y, w, h, title, detail=None, evidence=()):
        f, s = ROLE['client']
        style = (f'shape=mxgraph.office.devices.cell_phone_iphone_standalone;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.6;fontColor={INK};'
                 'verticalLabelPosition=bottom;verticalAlign=top;labelPosition=center;align=center;')
        self._register(nid, 'client application', title, detail, evidence)
        return self._cell(nid, '', style, x, y, w, h, evidence)

    def queue(self, nid, x, y, w, h, title, detail=None, evidence=()):
        """A wide message-bus bar: rounded box plus the standard queue stencil as its icon."""
        f, s = ROLE['messaging']
        self._register(nid, 'message broker', title, detail, evidence)
        self._cell(nid, label(title, detail, 14, 11), f'rounded=1;arcSize=18;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=2;fontColor={INK};align=center;verticalAlign=middle;spacingLeft=56;', x, y, w, h, evidence)
        self._cell(nid + '-icon', '', f'shape=mxgraph.aws4.queue;html=1;fillColor={s};strokeColor=none;', x + 14, y + (h - 34) / 2, 48, 34)
        return nid

    def qbox(self, nid, x, y, w, h, title, detail=None, evidence=(), dashed=False):
        """A single queue: amber box with the standard queue stencil."""
        f, s = ROLE['messaging']
        self._register(nid, 'queue', title, detail, evidence)
        self._cell(nid, label(title, detail, 11, 10), f'rounded=1;arcSize=14;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.5;fontColor={INK};align=left;verticalAlign=middle;spacingLeft=48;spacingRight=4;' + ('dashed=1;dashPattern=6 3;' if dashed else ''), x, y, w, h, evidence)
        self._cell(nid + '-icon', '', f'shape=mxgraph.aws4.queue;html=1;fillColor={s};strokeColor=none;', x + 8, y + (h - 22) / 2, 32, 22)
        return nid

    def exchange(self, nid, x, y, w, h, title, detail=None, evidence=()):
        f, s = ROLE['messaging']
        self._register(nid, 'exchange', title, detail, evidence)
        return self._cell(nid, label(title, detail, 11, 10), f'shape=hexagon;perimeter=hexagonPerimeter2;size=0.18;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=2;fontColor={INK};align=center;verticalAlign=middle;', x, y, w, h, evidence)

    def node(self, nid, x, y, w, h, title, detail=None, evidence=(), align='left'):
        """UML deployment node (3-D box) used for hosts."""
        f, s = ROLE['node']
        style = (f'shape=cube;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;darkOpacity=0.04;darkOpacity2=0.08;size=16;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.6;'
                 f'fontColor={INK};align={align};verticalAlign=top;spacingLeft=12;spacingRight=24;spacingTop=14;')
        self._register(nid, 'deployment node', title, detail, evidence)
        return self._cell(nid, label(title, detail, 14, 11), style, x, y, w, h, evidence)

    def box(self, nid, x, y, w, h, title, detail=None, role='processing', evidence=(), rounded=True, dashed=False):
        f, s = ROLE[role]
        style = (f'rounded={1 if rounded else 0};arcSize=10;html=1;whiteSpace=wrap;{FONT}fillColor={f};strokeColor={s};strokeWidth=1.6;fontColor={INK};align=center;verticalAlign=middle;'
                 + ('dashed=1;dashPattern=6 3;' if dashed else ''))
        self._register(nid, 'component', title, detail, evidence)
        return self._cell(nid, label(title, detail, 12, 10), style, x, y, w, h, evidence)

    def step(self, nid, x, y, num, text, w=34):
        """Numbered circle used for an ordered story on a topology page."""
        return self._cell(nid, str(num), f'ellipse;html=1;{FONT}fontSize=12;fontStyle=1;fontColor=#ffffff;fillColor=#1F2937;strokeColor=none;align=center;verticalAlign=middle;', x, y, w, w)

    def edge(self, src, dst, text='', kind='sync', exit=None, entry=None, points=None, evidence=(), label_offset=None, bidirectional=False):
        eid = self._id('e' + str(self.n + 1))
        style = ('edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;jumpStyle=arc;jumpSize=8;'
                 f'{FONT}fontSize=11;fontColor={INK};labelBackgroundColor=#ffffff;' + EDGE[kind])
        if bidirectional:
            style += 'startArrow=block;startFill=1;'
        if exit:
            style += f'exitX={exit[0]};exitY={exit[1]};exitDx=0;exitDy=0;'
        if entry:
            style += f'entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;'
        self.edges.append(dict(id=eid, source=src, target=dst, label=text, kind=kind, evidence=list(evidence)))
        self.cells.append(dict(id=eid, value=html.escape(text).replace('\n', '<br>'), style=style, edge=True, source=src, target=dst, points=points or [], ev=list(evidence), parent='1', attrs={}))
        return eid

    def legend(self, x, y, items, title='Legend'):
        """items: list of (kind, text) where kind is an EDGE key or a ROLE key."""
        self.text(title, x, y, 200, 22, size=12, bold=True)
        row = 0
        for kind, text in items:
            ry = y + 28 + row * 26
            if kind in EDGE:
                self._cell(self._id(), '', 'endArrow=none;html=1;' + EDGE[kind].replace('endArrow=block', 'endArrow=none').replace('endArrow=open', 'endArrow=none'), x, ry + 11, 44, 0, vertex=False)
                self.cells[-1]['legend_line'] = (x, ry + 11, x + 44, ry + 11)
                self.cells[-1]['edge'] = True
            else:
                f, s = ROLE[kind]
                self._cell(self._id(), '', f'rounded=1;arcSize=20;html=1;fillColor={f};strokeColor={s};strokeWidth=1.5;', x, ry + 3, 44, 16)
            self.text(text, x + 54, ry, 330, 22, size=11)
            row += 1

    def element(self):
        diagram = ET.Element('diagram', id=self.id, name=self.title)
        model = ET.SubElement(diagram, 'mxGraphModel', dx='0', dy='0', grid='1', gridSize='10', guides='1', tooltips='1', connect='1', arrows='1', fold='1',
                              page='1', pageScale='1', pageWidth=str(self.width), pageHeight=str(self.height), background='#ffffff', adaptiveColors='none',
                              conformance='Practical architecture view; standard draw.io UML, data-store, cloud and queue symbols', scopeDescription=self.title)
        root = ET.SubElement(model, 'root')
        ET.SubElement(root, 'mxCell', id='0')
        ET.SubElement(root, 'mxCell', id='1', parent='0')
        for c in self.cells:
            if c.get('edge'):
                attrs = dict(id=c['id'], value=c['value'], style=c['style'], edge='1', parent='1')
                if c.get('source'):
                    attrs.update(source=c['source'], target=c['target'])
                if c['ev']:
                    attrs['sourceEvidence'] = json.dumps(c['ev'])
                cell = ET.SubElement(root, 'mxCell', **attrs)
                geom = ET.SubElement(cell, 'mxGeometry', relative='1', **{'as': 'geometry'})
                if c.get('legend_line'):
                    x1, y1, x2, y2 = c['legend_line']
                    ET.SubElement(geom, 'mxPoint', x=str(x1), y=str(y1), **{'as': 'sourcePoint'})
                    ET.SubElement(geom, 'mxPoint', x=str(x2), y=str(y2), **{'as': 'targetPoint'})
                if c.get('points'):
                    array = ET.SubElement(geom, 'Array', **{'as': 'points'})
                    for px, py in c['points']:
                        ET.SubElement(array, 'mxPoint', x=str(px), y=str(py))
            else:
                attrs = dict(id=c['id'], value=c['value'], style=c['style'], vertex='1', parent='1')
                if c['ev']:
                    attrs['sourceEvidence'] = json.dumps(c['ev'])
                cell = ET.SubElement(root, 'mxCell', **attrs)
                ET.SubElement(cell, 'mxGeometry', x=str(c['x']), y=str(c['y']), width=str(c['w']), height=str(c['h']), **{'as': 'geometry'})
        model.set('semanticModel', json.dumps(dict(id=self.id, title=self.title, type='architecture view', scope=self.scope, nodes=self.nodes, edges=self.edges), ensure_ascii=False, separators=(',', ':')))
        return diagram


def page_order_key(page_id):
    return (int(re.match(r'\d+', page_id).group()), page_id)


def install(pages):
    """Insert or replace the given <diagram> elements in the master file, keeping the numeric page order."""
    master = REPO / 'docs/diagrams/velora-current/velora-architecture.drawio'
    tree = ET.parse(master)
    root = tree.getroot()
    existing = {d.attrib['id']: d for d in root.findall('diagram')}
    for p in pages:
        existing[p.attrib['id']] = p
    for child in list(root):
        root.remove(child)
    for page_id in sorted(existing, key=page_order_key):
        root.append(existing[page_id])
    master.write_text(ET.tostring(root, encoding='unicode'))
