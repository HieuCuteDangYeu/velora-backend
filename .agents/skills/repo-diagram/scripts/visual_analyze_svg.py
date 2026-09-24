#!/usr/bin/env python3
"""Geometry-aware visual analyzer for rendered SVG diagrams.

The analyzer understands Repo Diagrammer native SVG metadata and common Mermaid/
Graphviz group conventions. It checks geometry defects that source validation cannot:
node overlap, edge/node crossings, edge/edge crossings, tiny gaps, extreme canvas
ratios, and suspiciously long routes.

It is intentionally conservative: native renderer metadata yields blocking defects;
heuristically discovered geometry yields warnings unless --strict-heuristic is used.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from pathlib import Path

EPS = 1e-6


@dataclass
class Box:
    id: str
    x: float
    y: float
    w: float
    h: float
    confidence: str = "native"

    @property
    def left(self): return self.x
    @property
    def right(self): return self.x + self.w
    @property
    def top(self): return self.y
    @property
    def bottom(self): return self.y + self.h


@dataclass
class Region:
    id: str
    box: Box
    kind: str
    members: set[str]


@dataclass
class Edge:
    id: str
    points: list[tuple[float, float]]
    source: str = ""
    target: str = ""
    confidence: str = "native"


@dataclass
class Finding:
    severity: str
    code: str
    message: str
    ids: list[str]


def n(v: str | None, default=0.0) -> float:
    if not v:
        return default
    m = re.search(r"-?\d+(?:\.\d+)?", v)
    return float(m.group()) if m else default


def parse_transform(value: str | None) -> tuple[float, float]:
    if not value:
        return 0.0, 0.0
    tx = ty = 0.0
    for _, args in re.findall(r"(translate)\s*\(([^)]*)\)", value):
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", args)]
        if nums:
            tx += nums[0]
            if len(nums) > 1:
                ty += nums[1]
    return tx, ty


def tag(el):
    return el.tag.rsplit("}", 1)[-1]


def classes(el) -> set[str]:
    return set((el.attrib.get("class") or "").split())


def walk(root):
    stack = [(root, 0.0, 0.0)]
    while stack:
        el, ox, oy = stack.pop()
        tx, ty = parse_transform(el.attrib.get("transform"))
        ox2, oy2 = ox + tx, oy + ty
        yield el, ox2, oy2
        for ch in reversed(list(el)):
            stack.append((ch, ox2, oy2))


def rect_from_group(group, ox, oy, node_id, confidence):
    candidates: list[Box] = []
    for el, ex, ey in walk(group):
        t = tag(el)
        if t == "rect":
            candidates.append(Box(node_id, ex+n(el.attrib.get("x")), ey+n(el.attrib.get("y")),
                                  n(el.attrib.get("width")), n(el.attrib.get("height")), confidence))
        elif t == "ellipse":
            rx, ry = n(el.attrib.get("rx")), n(el.attrib.get("ry"))
            cx, cy = ex+n(el.attrib.get("cx")), ey+n(el.attrib.get("cy"))
            candidates.append(Box(node_id, cx-rx, cy-ry, rx*2, ry*2, confidence))
        elif t == "circle":
            r = n(el.attrib.get("r"))
            cx, cy = ex+n(el.attrib.get("cx")), ey+n(el.attrib.get("cy"))
            candidates.append(Box(node_id, cx-r, cy-r, r*2, r*2, confidence))
        elif t in {"polygon", "polyline"}:
            pts = [(float(a), float(b)) for a, b in re.findall(
                r"(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", el.attrib.get("points") or "")]
            if pts:
                xs = [ex+p[0] for p in pts]
                ys = [ey+p[1] for p in pts]
                candidates.append(Box(node_id, min(xs), min(ys), max(xs)-min(xs), max(ys)-min(ys), confidence))
    candidates = [b for b in candidates if b.w > 2 and b.h > 2]
    return max(candidates, key=lambda b: b.w*b.h) if candidates else None


def path_points(d: str, ox=0.0, oy=0.0) -> list[tuple[float, float]]:
    """Flatten common SVG path commands to significant endpoints/control points."""
    toks = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", d or "")
    pts = []
    i = 0
    cmd = ""
    cx = cy = 0.0
    sx = sy = 0.0
    param_counts = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2}
    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]
            i += 1
            if cmd.upper() == "Z":
                pts.append((sx+ox, sy+oy))
                cx, cy = sx, sy
                continue
        if not cmd or cmd.upper() not in param_counts:
            break
        k = param_counts[cmd.upper()]
        if i+k > len(toks) or any(x.isalpha() for x in toks[i:i+k]):
            continue
        vals = list(map(float, toks[i:i+k]))
        i += k
        rel = cmd.islower()
        u = cmd.upper()
        if u in {"M", "L", "T"}:
            x, y = vals[-2:]
            if rel:
                x += cx
                y += cy
            cx, cy = x, y
            if u == "M":
                sx, sy = cx, cy
                cmd = "l" if rel else "L"
            pts.append((cx+ox, cy+oy))
        elif u == "H":
            cx = vals[0] + (cx if rel else 0)
            pts.append((cx+ox, cy+oy))
        elif u == "V":
            cy = vals[0] + (cy if rel else 0)
            pts.append((cx+ox, cy+oy))
        elif u in {"C", "S", "Q"}:
            pairs = [vals[j:j+2] for j in range(0, len(vals), 2)]
            base_x, base_y = cx, cy
            for x, y in pairs:
                if rel:
                    x += base_x
                    y += base_y
                pts.append((x+ox, y+oy))
            cx, cy = pairs[-1]
            if rel:
                cx += base_x
                cy += base_y
    out = []
    for p in pts:
        if not out or math.dist(out[-1], p) > EPS:
            out.append(p)
    return out


def dedupe_boxes(boxes):
    out = []
    for b in boxes:
        if not any(abs(b.x-a.x) < 1 and abs(b.y-a.y) < 1 and abs(b.w-a.w) < 1 and abs(b.h-a.h) < 1 for a in out):
            out.append(b)
    return out


def extract(root):
    boxes = []
    labels = []
    regions = []
    edges = []
    native = False
    for el, ox, oy in walk(root):
        if tag(el) != "g":
            continue
        node_id = el.attrib.get("data-node-id")
        if node_id:
            b = rect_from_group(el, ox, oy, node_id, "native")
            if b:
                boxes.append(b)
                native = True
        region_kind = el.attrib.get("data-region-kind")
        if region_kind:
            rid = el.attrib.get("data-boundary-id") or el.attrib.get("data-group-id") or "region"
            b = rect_from_group(el, ox, oy, rid, "native")
            if b:
                members = {x for x in (el.attrib.get("data-members") or "").split(",") if x}
                regions.append(Region(rid, b, region_kind, members))
                native = True
        label_id = el.attrib.get("data-edge-label-id")
        if label_id:
            b = rect_from_group(el, ox, oy, label_id, "native")
            if b:
                labels.append(b)
                native = True
        edge_id = el.attrib.get("data-edge-id")
        if edge_id:
            pts = []
            for ch, cx, cy in walk(el):
                if tag(ch) == "path":
                    pts = path_points(ch.attrib.get("d") or "", cx, cy)
                    break
                if tag(ch) == "polyline":
                    pts = [(cx+float(a), cy+float(b)) for a, b in re.findall(
                        r"(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)", ch.attrib.get("points") or "")]
            if len(pts) >= 2:
                edges.append(Edge(edge_id, pts, el.attrib.get("data-source-id", ""),
                                  el.attrib.get("data-target-id", ""), "native"))
                native = True
    if native:
        return boxes, labels, regions, edges, True

    # Common Mermaid / Graphviz group conventions. These are warnings by default
    # because third-party renderer DOMs change between versions.
    idxn = idxe = 0
    for el, ox, oy in walk(root):
        if tag(el) != "g":
            continue
        cls = classes(el)
        is_node = "node" in cls
        is_edge = bool(cls & {"edgePath", "edge"})
        if is_node:
            node_id = el.attrib.get("id") or f"node-{idxn}"
            idxn += 1
            b = rect_from_group(el, ox, oy, node_id, "heuristic")
            if b:
                boxes.append(b)
        if is_edge:
            pts = []
            for ch, cx, cy in walk(el):
                if tag(ch) == "path":
                    pts = path_points(ch.attrib.get("d") or "", cx, cy)
                    break
            if len(pts) >= 2:
                edges.append(Edge(el.attrib.get("id") or f"edge-{idxe}", pts, confidence="heuristic"))
                idxe += 1
    return dedupe_boxes(boxes), labels, regions, edges, False


def overlap(a: Box, b: Box, pad=0.0):
    return min(a.right, b.right)-max(a.left, b.left) > pad and min(a.bottom, b.bottom)-max(a.top, b.top) > pad


def point_in_box(p, b: Box, margin=1.0):
    return b.left+margin < p[0] < b.right-margin and b.top+margin < p[1] < b.bottom-margin


def orient(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def seg_intersect(a, b, c, d):
    """Proper intersection only; touching endpoints is not a crossing."""
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return ((o1 > EPS and o2 < -EPS) or (o1 < -EPS and o2 > EPS)) and            ((o3 > EPS and o4 < -EPS) or (o3 < -EPS and o4 > EPS))


def segment_rect_cross(a, b, r: Box):
    if point_in_box(a, r) or point_in_box(b, r):
        return True
    q = [(r.left, r.top), (r.right, r.top), (r.right, r.bottom), (r.left, r.bottom)]
    return any(seg_intersect(a, b, q[i], q[(i+1) % 4]) for i in range(4))


def collinear_overlap(a, b, c, d):
    """Overlap length for axis-aligned collinear segments."""
    if abs(a[0]-b[0]) < EPS and abs(c[0]-d[0]) < EPS and abs(a[0]-c[0]) < EPS:
        lo = max(min(a[1], b[1]), min(c[1], d[1]))
        hi = min(max(a[1], b[1]), max(c[1], d[1]))
        return max(0.0, hi-lo)
    if abs(a[1]-b[1]) < EPS and abs(c[1]-d[1]) < EPS and abs(a[1]-c[1]) < EPS:
        lo = max(min(a[0], b[0]), min(c[0], d[0]))
        hi = min(max(a[0], b[0]), max(c[0], d[0]))
        return max(0.0, hi-lo)
    return 0.0


def route_len(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def canvas_size(root):
    vb = root.attrib.get("viewBox")
    if vb:
        p = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", vb)]
        if len(p) == 4:
            return p[2], p[3]
    return n(root.attrib.get("width")), n(root.attrib.get("height"))


def contains(outer: Box, inner: Box, margin=0.0):
    return (
        outer.left-margin <= inner.left
        and outer.right+margin >= inner.right
        and outer.top-margin <= inner.top
        and outer.bottom+margin >= inner.bottom
    )


def analyze(root, boxes, labels, regions, edges, native, strict_heuristic=False):
    findings = []

    def sev(block=True):
        return "blocking" if block and (native or strict_heuristic) else "warning"

    w, h = canvas_size(root)
    if w and h:
        ratio = w/h
        if ratio > 3.0 or ratio < 0.38:
            findings.append(Finding("warning", "EXTREME_ASPECT",
                                    f"canvas aspect ratio {ratio:.2f}:1 is hard to scan", []))

        if boxes:
            left = min(b.left for b in boxes)
            right = max(b.right for b in boxes)
            top = min(b.top for b in boxes)
            bottom = max(b.bottom for b in boxes)
            left_margin = max(0.0, left)
            right_margin = max(0.0, w-right)
            bottom_margin = max(0.0, h-bottom)
            occupied_w = max(1.0, right-left)
            occupied_h = max(1.0, bottom-top)

            if abs(left_margin-right_margin) > max(80.0, w*0.16):
                findings.append(Finding(
                    "warning", "HORIZONTAL_IMBALANCE",
                    f"content margins differ by {abs(left_margin-right_margin):.1f}px",
                    []
                ))

            if bottom_margin > max(180.0, h*0.38):
                findings.append(Finding(
                    "warning", "EXCESS_BOTTOM_WHITESPACE",
                    f"bottom whitespace is {bottom_margin:.1f}px ({bottom_margin/h:.0%} of canvas)",
                    []
                ))

            content_density = (occupied_w*occupied_h)/(w*h)
            if len(boxes) >= 4 and content_density < 0.18:
                findings.append(Finding(
                    "warning", "SPARSE_COMPOSITION",
                    f"node content occupies only {content_density:.0%} of canvas bounding area",
                    []
                ))

    # Region geometry should clarify ownership, never accidentally capture unrelated nodes.
    for region in regions:
        header = Box(region.id + "-header", region.box.x, region.box.y, region.box.w, min(24.0, region.box.h))
        for node in boxes:
            if node.id in region.members:
                if not contains(region.box, node, 1.0):
                    findings.append(Finding(
                        sev(), "REGION_MEMBER_OUTSIDE",
                        f"{region.kind} region {region.id} does not fully contain member {node.id}",
                        [region.id, node.id]
                    ))
            elif contains(region.box, node, 0.0):
                findings.append(Finding(
                    sev(), "REGION_CAPTURES_UNRELATED_NODE",
                    f"{region.kind} region {region.id} visually captures unrelated node {node.id}",
                    [region.id, node.id]
                ))
            if overlap(header, node, 0):
                findings.append(Finding(
                    sev(), "REGION_HEADER_COLLISION",
                    f"{region.kind} region {region.id} header overlaps node {node.id}",
                    [region.id, node.id]
                ))

        for label in labels:
            if overlap(header, label, 0):
                findings.append(Finding(
                    sev(), "REGION_HEADER_COLLISION",
                    f"{region.kind} region {region.id} header overlaps edge label {label.id}",
                    [region.id, label.id]
                ))

    for i, r1 in enumerate(regions):
        for r2 in regions[i+1:]:
            if not overlap(r1.box, r2.box, 0):
                continue
            nested = contains(r1.box, r2.box, 0) or contains(r2.box, r1.box, 0)
            if not nested:
                findings.append(Finding(
                    sev(), "AMBIGUOUS_REGION_OVERLAP",
                    f"regions {r1.id} and {r2.id} partially overlap without nesting",
                    [r1.id, r2.id]
                ))

    for i, a in enumerate(boxes):
        for b in boxes[i+1:]:
            if overlap(a, b, 0):
                findings.append(Finding(sev(), "NODE_OVERLAP",
                                        f"nodes {a.id} and {b.id} overlap", [a.id, b.id]))
            else:
                dx = max(b.left-a.right, a.left-b.right, 0)
                dy = max(b.top-a.bottom, a.top-b.bottom, 0)
                gap = math.hypot(dx, dy)
                if 0 < gap < 12:
                    findings.append(Finding("warning", "TIGHT_NODE_GAP",
                                            f"nodes {a.id} and {b.id} are only {gap:.1f}px apart", [a.id, b.id]))

    for label in labels:
        for b in boxes:
            if overlap(label, b, 0):
                findings.append(Finding(sev(), "LABEL_NODE_COLLISION",
                                        f"edge label {label.id} overlaps node {b.id}", [label.id, b.id]))
        owner = label.id[:-6] if label.id.endswith("-label") else ""
        for e in edges:
            if e.id == owner:
                continue
            if any(segment_rect_cross(a, c, label) for a, c in zip(e.points, e.points[1:])):
                findings.append(Finding(sev(), "LABEL_EDGE_COLLISION",
                                        f"edge label {label.id} overlaps edge {e.id}", [label.id, e.id]))
    for i, a in enumerate(labels):
        for b in labels[i+1:]:
            if overlap(a, b, 0):
                findings.append(Finding(sev(), "LABEL_LABEL_COLLISION",
                                        f"edge labels {a.id} and {b.id} overlap", [a.id, b.id]))

    for e in edges:
        if native:
            for a, c in zip(e.points, e.points[1:]):
                if abs(a[0]-c[0]) > EPS and abs(a[1]-c[1]) > EPS:
                    findings.append(Finding(sev(), "NON_ORTHOGONAL_ROUTE",
                                            f"native edge {e.id} contains a diagonal segment", [e.id]))
                    break
        for b in boxes:
            if b.id in {e.source, e.target}:
                continue
            if any(segment_rect_cross(a, c, b) for a, c in zip(e.points, e.points[1:])):
                findings.append(Finding(sev(), "EDGE_NODE_CROSSING",
                                        f"edge {e.id} crosses node {b.id}", [e.id, b.id]))
        direct = math.dist(e.points[0], e.points[-1])
        length = route_len(e.points)
        if direct > 20 and length/direct > 2.75:
            findings.append(Finding("warning", "LONG_ROUTE",
                                    f"edge {e.id} route is {length/direct:.1f}× direct distance", [e.id]))

    # Native high-degree nodes should not funnel many edges through one identical port.
    if native:
        attachments = {}
        for e in edges:
            if e.source and e.points:
                attachments.setdefault(e.source, []).append((e.id, e.points[0]))
            if e.target and e.points:
                attachments.setdefault(e.target, []).append((e.id, e.points[-1]))
        for nid, items in attachments.items():
            buckets = {}
            for eid, point in items:
                key = (round(point[0], 1), round(point[1], 1))
                buckets.setdefault(key, []).append(eid)
            for point, eids in buckets.items():
                if len(eids) > 2:
                    findings.append(Finding(
                        sev(), "PORT_CONGESTION",
                        f"node {nid} funnels {len(eids)} edges through port {point}",
                        [nid] + eids
                    ))

    crossing_pairs = set()
    overlap_pairs = set()
    for i, e1 in enumerate(edges):
        for e2 in edges[i+1:]:
            shared_endpoint = bool(
                e1.source and e2.source and ({e1.source, e1.target} & {e2.source, e2.target})
            )
            hit = any(seg_intersect(a, b, c, d)
                      for a, b in zip(e1.points, e1.points[1:])
                      for c, d in zip(e2.points, e2.points[1:]))
            if hit and not shared_endpoint:
                key = tuple(sorted((e1.id, e2.id)))
                if key not in crossing_pairs:
                    crossing_pairs.add(key)
                    findings.append(Finding(sev(), "EDGE_EDGE_CROSSING",
                                            f"edges {e1.id} and {e2.id} cross", list(key)))
            max_overlap = max(
                [collinear_overlap(a, b, c, d)
                 for a, b in zip(e1.points, e1.points[1:])
                 for c, d in zip(e2.points, e2.points[1:])] or [0.0]
            )
            # A tiny shared port stub is normal. Long shared corridors are ambiguous.
            threshold = 28.0 if shared_endpoint else 8.0
            if max_overlap > threshold:
                key = tuple(sorted((e1.id, e2.id)))
                if key not in overlap_pairs:
                    overlap_pairs.add(key)
                    findings.append(Finding(sev(), "EDGE_EDGE_OVERLAP",
                                            f"edges {e1.id} and {e2.id} share {max_overlap:.1f}px of route",
                                            list(key)))
    return findings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("svg", type=Path)
    ap.add_argument("--json", dest="json_path", type=Path)
    ap.add_argument("--strict", action="store_true", help="exit non-zero when blocking findings exist")
    ap.add_argument("--strict-heuristic", action="store_true",
                    help="allow heuristic third-party geometry findings to block")
    ap.add_argument("--max-crossings", type=int, default=None)
    args = ap.parse_args()
    try:
        root = ET.parse(args.svg).getroot()
    except Exception as exc:
        print(f"VISUAL-ANALYZER ERROR: {exc}", file=sys.stderr)
        return 2

    boxes, labels, regions, edges, native = extract(root)
    findings = analyze(root, boxes, labels, regions, edges, native, args.strict_heuristic)
    crossings = sum(1 for f in findings if f.code == "EDGE_EDGE_CROSSING")
    if args.max_crossings is not None and crossings > args.max_crossings:
        findings.append(Finding("blocking" if native or args.strict_heuristic else "warning",
                                "CROSSING_BUDGET",
                                f"{crossings} edge crossings exceeds budget {args.max_crossings}", []))

    report = {
        "file": str(args.svg),
        "geometry": "native" if native else "heuristic",
        "nodes": len(boxes),
        "labels": len(labels),
        "regions": len(regions),
        "edges": len(edges),
        "crossings": crossings,
        "findings": [asdict(f) for f in findings],
    }
    print(f"VISUAL-ANALYZER: {args.svg.name} — {len(boxes)} nodes, {len(labels)} labels, {len(regions)} regions, {len(edges)} edges, geometry={report['geometry']}")
    for f in findings:
        print(f"  {f.severity.upper()} {f.code}: {f.message}")
    if not findings:
        print("  PASS: no measured geometry defects")

    if args.json_path:
        args.json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.strict and any(f.severity == "blocking" for f in findings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
