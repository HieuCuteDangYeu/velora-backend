#!/usr/bin/env python3
"""Deterministic high-level architecture SVG renderer for Repo Diagrammer.

Reads an evidence spec and produces a geometry-owned SVG. The renderer optimizes
layer ordering with barycentric sweeps, emits orthogonal routes, and includes native
metadata consumed by visual_analyze_svg.py.
"""
from __future__ import annotations

import argparse
import html
import math
import sys
from pathlib import Path

from geometry_router import place_label, route_edge
from text_metrics import estimate_text_width, fit_font_size, wrap_text

try:
    import yaml
except ImportError:
    print("ARCH-RENDERER unavailable: install PyYAML", file=sys.stderr)
    raise SystemExit(2)

ROLE_ORDER = ["clients", "ingress", "api", "realtime", "messaging",
              "processing", "domain", "data", "observability", "external"]
PALETTE = {
    "clients": ("#EAF3FF", "#2F80ED"),
    "ingress": ("#EAF3FF", "#2F80ED"),
    "api": ("#F5F0FF", "#8B5CF6"),
    "realtime": ("#FFF1F2", "#F87171"),
    "messaging": ("#FFF7E6", "#F59E0B"),
    "processing": ("#EFF6FF", "#3B82F6"),
    "domain": ("#ECFDF5", "#34A853"),
    "observability": ("#ECFDF9", "#14B8A6"),
    "data": ("#F8FAFC", "#64748B"),
    "external": ("#FFF5F5", "#EF4444"),
}


def esc(s):
    return html.escape(str(s or ""))


def node_role(n):
    return str(n.get("semantic_role") or n.get("kind") or "domain")


def display_parts(n):
    vals = [n.get("display_label") or n.get("label") or n.get("id"),
            n.get("tech"), n.get("responsibility")]
    return [str(v).strip() for v in vals if str(v or "").strip()][:3]


def width_for(n):
    parts = display_parts(n)
    if not parts:
        return 160
    title_w = estimate_text_width(parts[0], 13, "700") + 28
    tech_w = estimate_text_width(parts[1], 10.5) + 28 if len(parts) > 1 else 0
    # Responsibilities should wrap rather than forcing poster-width nodes.
    responsibility_target = min(
        300,
        estimate_text_width(parts[2], 10.5) + 28 if len(parts) > 2 else 0,
    )
    return max(160, min(340, max(title_w, tech_w, responsibility_target, 160)))


def node_lines(n, width):
    parts = display_parts(n)
    if not parts:
        return []
    inner = max(40, width-28)
    title_size = fit_font_size(parts[0], inner, 13, 9.5)
    result = [("title", parts[0], title_size)]
    if len(parts) > 1:
        tech_size = fit_font_size(parts[1], inner, 10.5, 8.5)
        result.append(("detail", parts[1], tech_size))
    if len(parts) > 2:
        wrapped = wrap_text(parts[2], inner, 10.5, max_lines=3) or [parts[2]]
        for line in wrapped:
            size = fit_font_size(line, inner, 10.5, 8.5)
            result.append(("detail", line, size))
    return result


def height_for(n, width):
    return max(88, 34 + 18*len(node_lines(n, width)))


def parse_rows(doc, nodes):
    ids = {n["id"] for n in nodes}
    rows = (doc.get("layout") or {}).get("rows") or []
    out = []
    used = set()
    for row in rows:
        if isinstance(row, dict):
            members = [x for x in (row.get("nodes") or row.get("contains") or [])
                       if x in ids and x not in used]
            label = str(row.get("label") or row.get("id") or "")
        elif isinstance(row, list):
            members = [x for x in row if x in ids and x not in used]
            label = ""
        else:
            continue
        if members:
            out.append({"label": label, "nodes": members})
            used.update(members)

    leftovers = [n for n in nodes if n["id"] not in used]
    by = {}
    for n in leftovers:
        by.setdefault(node_role(n), []).append(n["id"])
    for role in ROLE_ORDER:
        if by.get(role):
            out.append({"label": role.replace("-", " ").title(), "nodes": by.pop(role)})
    for role, members in by.items():
        out.append({"label": role.replace("-", " ").title(), "nodes": members})
    return out


def barycentric_order(rows, edges):
    pos = {nid: i for row in rows for i, nid in enumerate(row["nodes"])}
    adj = {nid: [] for row in rows for nid in row["nodes"]}
    for e in edges:
        a, b = e.get("from"), e.get("to")
        if a in adj and b in adj:
            adj[a].append(b)
            adj[b].append(a)

    for _ in range(5):
        for forward in (True, False):
            seq = range(1, len(rows)) if forward else range(len(rows)-2, -1, -1)
            for ri in seq:
                target = ri-1 if forward else ri+1
                target_set = set(rows[target]["nodes"])
                old = {nid: i for i, nid in enumerate(rows[ri]["nodes"])}

                def score(nid):
                    vals = [pos.get(x, 0) for x in adj[nid] if x in target_set]
                    return (sum(vals)/len(vals) if vals else old[nid], old[nid])

                rows[ri]["nodes"].sort(key=score)
                for i, nid in enumerate(rows[ri]["nodes"]):
                    pos[nid] = i
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--spacing-scale", type=float, default=1.0,
                    help="presentation-only spacing multiplier used by auto-repair")
    args = ap.parse_args()
    spacing_scale = max(0.85, min(1.8, args.spacing_scale))
    doc = yaml.safe_load(args.spec.read_text(encoding="utf-8"))

    dtype = str(doc.get("type") or "")
    if dtype not in {"c4-landscape", "c4-context", "c4-container", "c4-component"}:
        print(f"ARCH-RENDERER: unsupported type {dtype!r}; native renderer is only for static architecture views",
              file=sys.stderr)
        return 2

    nodes = [n for n in (doc.get("nodes") or []) if isinstance(n, dict) and n.get("id")]
    edges = [e for e in (doc.get("edges") or []) if isinstance(e, dict) and e.get("from") and e.get("to")]
    if not nodes:
        print("ARCH-RENDERER: no nodes", file=sys.stderr)
        return 1

    rows = barycentric_order(parse_rows(doc, nodes), edges)
    nmap = {n["id"]: n for n in nodes}

    margin = 70
    row_gap = 105 * spacing_scale
    node_gap = 34 * spacing_scale
    header = 112
    node_dims = {}
    row_widths = []
    row_heights = []
    for row in rows:
        dims = []
        for nid in row["nodes"]:
            w = width_for(nmap[nid])
            h = height_for(nmap[nid], w)
            node_dims[nid] = (w, h)
            dims.append((w, h))
        row_widths.append(sum(w for w, _ in dims)+node_gap*max(0, len(dims)-1))
        row_heights.append(max([h for _, h in dims] or [88]))

    canvas_w = max(760, max(row_widths, default=0)+margin*2)
    y = header
    boxes = {}
    row_index = {}
    for ri, row in enumerate(rows):
        total = row_widths[ri]
        row_h = row_heights[ri]
        x = (canvas_w-total)/2
        for nid in row["nodes"]:
            w, h = node_dims[nid]
            ny = y + (row_h-h)/2
            boxes[nid] = (x, ny, w, h)
            row_index[nid] = ri
            x += w+node_gap
        y += row_h+row_gap

    legend_h = 70 if ((doc.get("presentation") or {}).get("legend") or {}).get("show") else 20
    canvas_h = max(420, y-row_gap+margin+legend_h)
    title = (doc.get("presentation") or {}).get("title") or "Architecture overview"
    subtitle = (doc.get("presentation") or {}).get("subtitle") or doc.get("scope") or ""

    out = []
    out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_w:.0f}" height="{canvas_h:.0f}" '
               f'viewBox="0 0 {canvas_w:.0f} {canvas_h:.0f}" role="img">')
    out.append('<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">'
               '<path d="M0,0 L8,4 L0,8 z" fill="#475569"/></marker></defs>')
    out.append('<rect width="100%" height="100%" fill="#FFFFFF"/>')
    out.append(f'<text x="{margin}" y="46" font-family="Inter,Arial,sans-serif" font-size="26" '
               f'font-weight="700" fill="#0F172A">{esc(title)}</text>')
    if subtitle:
        out.append(f'<text x="{margin}" y="72" font-family="Inter,Arial,sans-serif" font-size="13" '
                   f'fill="#64748B">{esc(subtitle)}</text>')

    # Edge labels must avoid not only nodes but also region header strips.
    label_obstacles = dict(boxes)

    # Regions are visual containers only. Real boundaries come from evidence-backed
    # boundaries; presentation groups remain softer and never become edge endpoints.
    def region_rect(member_ids, pad=18):
        rs = [boxes[x] for x in member_ids if x in boxes]
        if not rs:
            return None
        left = min(x for x, y0, w, h in rs)-pad
        top = min(y0 for x, y0, w, h in rs)-pad-14
        right = max(x+w for x, y0, w, h in rs)+pad
        bottom = max(y0+h for x, y0, w, h in rs)+pad
        return left, top, right-left, bottom-top

    for boundary in doc.get("boundaries") or []:
        if not isinstance(boundary, dict):
            continue
        rr = region_rect(boundary.get("contains") or [], 24)
        if not rr:
            continue
        bx, by, bw, bh = rr
        bid = str(boundary.get("id") or "")
        name = str(boundary.get("name") or bid)
        members = ",".join(str(x) for x in (boundary.get("contains") or []))
        label_obstacles[f"boundary:{bid}:header"] = (bx, by, bw, min(24.0, bh))
        out.append(f'<g class="boundary" data-boundary-id="{esc(bid)}" data-region-kind="boundary" '
                   f'data-members="{esc(members)}"><rect x="{bx:.1f}" y="{by:.1f}" '
                   f'width="{bw:.1f}" height="{bh:.1f}" rx="16" fill="none" stroke="#64748B" '
                   'stroke-width="1.4" stroke-dasharray="8 6"/>'
                   f'<text x="{bx+12:.1f}" y="{by+16:.1f}" font-family="Inter,Arial,sans-serif" '
                   f'font-size="10.5" font-weight="700" fill="#475569">{esc(name)}</text></g>')

    groups = ((doc.get("presentation") or {}).get("groups") or [])
    for group in groups:
        if not isinstance(group, dict):
            continue
        rr = region_rect(group.get("contains") or [], 16)
        if not rr:
            continue
        gx, gy, gw, gh = rr
        gid = str(group.get("id") or "")
        name = str(group.get("label") or group.get("name") or gid)
        members = ",".join(str(x) for x in (group.get("contains") or []))
        label_obstacles[f"group:{gid}:header"] = (gx, gy, gw, min(24.0, gh))
        out.append(f'<g class="presentation-group" data-group-id="{esc(gid)}" data-region-kind="presentation" '
                   f'data-members="{esc(members)}"><rect x="{gx:.1f}" y="{gy:.1f}" '
                   f'width="{gw:.1f}" height="{gh:.1f}" rx="14" fill="#F8FAFC" fill-opacity="0.55" '
                   'stroke="#CBD5E1" stroke-width="1"/>'
                   f'<text x="{gx+12:.1f}" y="{gy+15:.1f}" font-family="Inter,Arial,sans-serif" '
                   f'font-size="10" font-weight="600" fill="#64748B">{esc(name)}</text></g>')

    for row in rows:
        if not row.get("label") or not row["nodes"]:
            continue
        ry = boxes[row["nodes"][0]][1]-18
        out.append(f'<text x="{margin}" y="{ry:.1f}" font-family="Inter,Arial,sans-serif" font-size="11" '
                   f'font-weight="600" fill="#94A3B8" letter-spacing="0.6">{esc(row["label"].upper())}</text>')

    primary_path = [str(x) for x in ((doc.get("view") or {}).get("primary_path") or [])]
    primary_pairs = set(zip(primary_path, primary_path[1:]))
    primary_ids = set(primary_path)

    def is_primary(edge):
        eid = str(edge.get("id") or "")
        pair = (str(edge.get("from") or ""), str(edge.get("to") or ""))
        return eid in primary_ids or pair in primary_pairs

    ordered_edges = sorted(enumerate(edges), key=lambda item: (not is_primary(item[1]), item[0]))
    incident = {nid: [] for nid in boxes}
    for original_index, edge in ordered_edges:
        eid = str(edge.get("id") or f"edge-{original_index}")
        for nid in (edge.get("from"), edge.get("to")):
            if nid in incident:
                incident[nid].append(eid)

    def port_slot(nid, eid):
        ids = incident.get(nid) or []
        if len(ids) <= 1:
            return 0.0
        idx = ids.index(eid)
        return (idx/(len(ids)-1))*2.0 - 1.0

    route_lane_count = {}
    existing_routes = []
    routed_edges = []

    # Phase 1: route every edge. Labels are deliberately deferred because a label
    # cannot avoid an edge that has not been routed yet.
    for ei, e in ordered_edges:
        sid, tid = e["from"], e["to"]
        if sid not in boxes or tid not in boxes:
            continue
        sri, tri = row_index[sid], row_index[tid]
        key = (min(sri, tri), max(sri, tri))
        lane_index = route_lane_count.get(key, 0)
        route_lane_count[key] = lane_index + 1
        eid = str(e.get("id") or f"edge-{ei}")
        pts = route_edge(
            boxes, row_index, sid, tid, canvas_w, existing_routes, lane_index,
            port_slot(sid, eid), port_slot(tid, eid)
        )
        if len(pts) < 2:
            continue
        record = {"id": eid, "source": sid, "target": tid, "points": pts, "edge": e}
        existing_routes.append(record)
        routed_edges.append(record)

    # Phase 2: render all routed edges now that global route geometry is known.
    for record in routed_edges:
        e = record["edge"]
        eid = record["id"]
        sid, tid = record["source"], record["target"]
        pts = record["points"]
        dashed = (e.get("sync") is False) or e.get("relation") in {
            "publishes", "emits", "consumes", "async", "event"
        }
        dash = ' stroke-dasharray="7 6"' if dashed else ""
        d = "M " + " L ".join(f"{x:.1f},{yy:.1f}" for x, yy in pts)
        primary = is_primary(e)
        stroke = "#1E293B" if primary else "#475569"
        stroke_width = "2.8" if primary else "1.7"
        primary_attr = ' data-primary="true"' if primary else ""
        out.append(f'<g class="edge" data-edge-id="{esc(eid)}" data-source-id="{esc(sid)}" '
                   f'data-target-id="{esc(tid)}"{primary_attr}><path d="{d}" fill="none" stroke="{stroke}" '
                   f'stroke-width="{stroke_width}"{dash} marker-end="url(#arrow)"/></g>')

    # Phase 3: place labels against the complete edge set.
    placed_labels = []
    for record in routed_edges:
        e = record["edge"]
        eid = record["id"]
        pts = record["points"]
        label = str(e.get("label") or e.get("protocol") or "").strip()
        if not label:
            continue
        lw = max(34, min(240, 14+estimate_text_width(label, 10.5)))
        lh = 20
        lx, ly, _, _ = place_label(
            pts, lw, lh, label_obstacles, placed_labels, existing_routes, eid, canvas_w, canvas_h
        )
        placed_labels.append((lx, ly, lw, lh))
        out.append(f'<g class="edge-label" data-edge-label-id="{esc(eid)}-label">'
                   f'<rect x="{lx:.1f}" y="{ly:.1f}" width="{lw:.1f}" height="{lh}" rx="5" '
                   'fill="#FFFFFF" fill-opacity="0.94"/>'
                   f'<text x="{lx+7:.1f}" y="{ly+13.5:.1f}" font-family="Inter,Arial,sans-serif" '
                   f'font-size="10.5" fill="#64748B">{esc(label)}</text></g>')

    for nid, (x, yy, w, h) in boxes.items():
        node = nmap[nid]
        role = node_role(node)
        fill, stroke = PALETTE.get(role, ("#F8FAFC", "#64748B"))
        lines = node_lines(node, w)
        out.append(f'<g class="node" data-node-id="{esc(nid)}" data-row-index="{row_index[nid]}"><rect x="{x:.1f}" y="{yy:.1f}" '
                   f'width="{w:.1f}" height="{h:.1f}" rx="12" fill="{fill}" stroke="{stroke}" '
                   f'stroke-width="1.5"/>')
        base = yy+27
        for li, (kind, line, size) in enumerate(lines):
            weight = "700" if kind == "title" else "400"
            color = "#0F172A" if kind == "title" else "#475569"
            out.append(f'<text x="{x+14:.1f}" y="{base+li*18:.1f}" font-family="Inter,Arial,sans-serif" '
                       f'font-size="{size}" font-weight="{weight}" fill="{color}">{esc(line)}</text>')
        out.append("</g>")

    if ((doc.get("presentation") or {}).get("legend") or {}).get("show"):
        ly = canvas_h-34
        out.append(f'<g class="legend"><line x1="{margin}" y1="{ly}" x2="{margin+34}" y2="{ly}" '
                   'stroke="#475569" stroke-width="1.7"/>'
                   f'<text x="{margin+42}" y="{ly+4}" font-family="Inter,Arial,sans-serif" '
                   'font-size="10.5" fill="#64748B">sync</text>')
        out.append(f'<line x1="{margin+100}" y1="{ly}" x2="{margin+134}" y2="{ly}" '
                   'stroke="#475569" stroke-width="1.7" stroke-dasharray="7 6"/>'
                   f'<text x="{margin+142}" y="{ly+4}" font-family="Inter,Arial,sans-serif" '
                   'font-size="10.5" fill="#64748B">async/event</text></g>')

    out.append("</svg>")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(out), encoding="utf-8")
    print(f"rendered: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
