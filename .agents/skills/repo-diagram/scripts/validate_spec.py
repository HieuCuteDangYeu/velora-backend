#!/usr/bin/env python3
"""Validate Repo Diagrammer evidence IR and documented standards subset."""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("SPEC-VALIDATOR unavailable: install PyYAML (python3 -m pip install pyyaml)", file=sys.stderr)
    raise SystemExit(2)

if len(sys.argv) != 2:
    print("usage: validate_spec.py <diagram.spec.yaml>", file=sys.stderr)
    raise SystemExit(2)

path = Path(sys.argv[1])
try:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
except Exception as exc:
    print(f"SPEC INVALID: cannot parse YAML: {exc}", file=sys.stderr)
    raise SystemExit(1)

if not isinstance(doc, dict):
    print("SPEC INVALID: root must be a mapping", file=sys.stderr)
    raise SystemExit(1)

errors: list[str] = []
warnings: list[str] = []

def nonempty(value) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(nonempty(v) for v in value)
    if isinstance(value, dict):
        return bool(value)
    return value is not None and value != ""

def mapping_list(name: str):
    value = doc.get(name, [])
    if value is None:
        return []
    if not isinstance(value, list):
        errors.append(f"{name}: must be a list")
        return []
    return value

def as_map(value, name: str):
    if value is None:
        return {}
    if not isinstance(value, dict):
        errors.append(f"{name}: must be a mapping")
        return {}
    return value

nodes = mapping_list("nodes")
edges = mapping_list("edges")
boundaries = mapping_list("boundaries")
fragments = mapping_list("interaction_fragments")
gaps = doc.get("gaps") or []
view = as_map(doc.get("view"), "view")
presentation = as_map(doc.get("presentation"), "presentation")
conformance = as_map(doc.get("conformance"), "conformance")
architecture_description = as_map(doc.get("architecture_description"), "architecture_description")

node_ids: set[str] = set()
node_by_id: dict[str, dict] = {}
for i, node in enumerate(nodes):
    prefix = f"nodes[{i}]"
    if not isinstance(node, dict):
        errors.append(f"{prefix}: must be a mapping")
        continue
    node_id = str(node.get("id") or "").strip()
    if not node_id:
        errors.append(f"{prefix}.id: required")
        continue
    if node_id in node_ids:
        errors.append(f"{prefix}.id: duplicate id {node_id!r}")
    node_ids.add(node_id)
    node_by_id[node_id] = node
    if not nonempty(node.get("label")):
        errors.append(f"{prefix}.label: required")
    if not nonempty(node.get("evidence")):
        errors.append(f"{prefix}.evidence: No evidence, no element")

edge_ids: set[str] = set()
partial = []
for i, edge in enumerate(edges):
    prefix = f"edges[{i}]"
    if not isinstance(edge, dict):
        errors.append(f"{prefix}: must be a mapping")
        continue
    edge_id = str(edge.get("id") or "").strip()
    if not edge_id:
        errors.append(f"{prefix}.id: required")
    elif edge_id in edge_ids:
        errors.append(f"{prefix}.id: duplicate id {edge_id!r}")
    else:
        edge_ids.add(edge_id)
    src, dst = edge.get("from"), edge.get("to")
    if src not in node_ids:
        errors.append(f"{prefix}.from: unknown node {src!r}")
    if dst not in node_ids:
        errors.append(f"{prefix}.to: unknown node {dst!r}")
    if not nonempty(edge.get("relation")):
        errors.append(f"{prefix}.relation: required renderer-neutral semantic")
    if not nonempty(edge.get("evidence")):
        errors.append(f"{prefix}.evidence: No evidence, no relation")
    if edge.get("confidence") == "partial":
        partial.append(prefix)

boundary_ids: set[str] = set()
for i, boundary in enumerate(boundaries):
    prefix = f"boundaries[{i}]"
    if not isinstance(boundary, dict):
        errors.append(f"{prefix}: must be a mapping")
        continue
    bid = str(boundary.get("id") or "").strip()
    if not bid:
        errors.append(f"{prefix}.id: required")
    elif bid in boundary_ids:
        errors.append(f"{prefix}.id: duplicate id {bid!r}")
    else:
        boundary_ids.add(bid)
    if not nonempty(boundary.get("evidence")):
        errors.append(f"{prefix}.evidence: real boundary requires evidence")
    for member in boundary.get("contains") or []:
        if member not in node_ids:
            errors.append(f"{prefix}.contains: unknown node {member!r}")

groups = presentation.get("groups") or []
group_ids: set[str] = set()
if not isinstance(groups, list):
    errors.append("presentation.groups: must be a list")
    groups = []
for i, group in enumerate(groups):
    prefix = f"presentation.groups[{i}]"
    if not isinstance(group, dict):
        errors.append(f"{prefix}: must be a mapping")
        continue
    gid = str(group.get("id") or "").strip()
    if gid:
        if gid in node_ids:
            errors.append(f"{prefix}.id: presentation group collides with real node {gid!r}")
        if gid in group_ids:
            errors.append(f"{prefix}.id: duplicate presentation group {gid!r}")
        group_ids.add(gid)
    for member in group.get("contains") or []:
        if member not in node_ids:
            errors.append(f"{prefix}.contains: unknown real node {member!r}")

diagram_type = str(doc.get("type") or "").strip()
profile_for = {
    "c4-landscape": "architecture",
    "c4-context": "architecture",
    "c4-container": "architecture",
    "c4-component": "architecture",
    "c4-dynamic": "architecture",
    "sequence": "sequence",
    "class": "class",
    "er": "er",
    "state": "state",
    "dataflow": "dataflow",
    "deployment": "deployment",
    "callgraph": "callgraph",
    "usecase": "usecase",
    "flowchart": "flowchart",
    "swimlane": "flowchart",
}
expected_profile = profile_for.get(diagram_type)
if not expected_profile:
    errors.append(f"type: unsupported or missing diagram type {diagram_type!r}")
elif view.get("profile") != expected_profile:
    errors.append(
        f"view.profile: expected {expected_profile!r} for type {diagram_type!r}, "
        f"got {view.get('profile')!r}"
    )

if view.get("renderer", "auto") not in {"auto", "mermaid", "plantuml", "graphviz"}:
    errors.append(f"view.renderer: unsupported {view.get('renderer')!r}")
if view.get("fallback_renderer", "auto") not in {"auto", "mermaid", "plantuml", "graphviz"}:
    errors.append(f"view.fallback_renderer: unsupported {view.get('fallback_renderer')!r}")

relations = [e.get("relation") for e in edges if isinstance(e, dict)]
if diagram_type == "class":
    allowed = {"extends", "implements", "composes", "aggregates", "associates", "depends-on"}
    for i, rel in enumerate(relations):
        if rel not in allowed:
            errors.append(f"edges[{i}].relation: {rel!r} is not a class relation")
elif diagram_type == "er":
    er_mode = (view.get("options") or {}).get("er_mode") if isinstance(view.get("options") or {}, dict) else ""
    if er_mode != "conceptual-chen":
        for i, edge in enumerate(edges):
            if not nonempty(edge.get("cardinality_from")) or not nonempty(edge.get("cardinality_to")):
                errors.append(f"edges[{i}]: Crow's Foot ER relation requires cardinality_from and cardinality_to")
elif diagram_type == "state":
    for i, edge in enumerate(edges):
        if edge.get("relation") != "transitions":
            errors.append(f"edges[{i}].relation: state edges must be 'transitions'")
        if not nonempty(edge.get("label")):
            errors.append(f"edges[{i}].label: state transition requires a trigger")
elif diagram_type in {"sequence", "c4-dynamic"}:
    orders = []
    for i, edge in enumerate(edges):
        order = edge.get("order")
        if not isinstance(order, int):
            errors.append(f"edges[{i}].order: runtime-ordered view requires integer order")
        else:
            orders.append(order)
    if len(orders) != len(set(orders)):
        errors.append("edges.order: duplicate message order")
elif diagram_type == "dataflow":
    for i, edge in enumerate(edges):
        if edge.get("relation") == "flows" and not nonempty(edge.get("data")):
            errors.append(f"edges[{i}].data: dataflow edge must name its dataset/event")
elif diagram_type == "usecase":
    allowed = {"associates", "includes", "extends", "generalizes"}
    for i, edge in enumerate(edges):
        if edge.get("relation") not in allowed:
            errors.append(f"edges[{i}].relation: invalid use-case relation {edge.get('relation')!r}")

for i, edge in enumerate(edges):
    if edge.get("crosses_network") and not nonempty(edge.get("protocol")):
        errors.append(f"edges[{i}].protocol: network edge requires protocol")

if partial and not nonempty(gaps):
    errors.append("gaps: partial-confidence facts exist but uncertainty is not disclosed")

mode = conformance.get("mode", "practical")
if mode not in {"practical", "textbook-strict"}:
    errors.append(f"conformance.mode: expected practical or textbook-strict, got {mode!r}")

targets = conformance.get("targets") or []
if not isinstance(targets, list):
    errors.append("conformance.targets: must be a list")
    targets = []

allowed_targets = {
    "omg-uml-2.5.1",
    "c4-model",
    "iso-iec-ieee-42010-2022",
    "chen-1976",
    "ie-crows-foot",
}
for target in targets:
    if target not in allowed_targets:
        errors.append(f"conformance.targets: unsupported target {target!r}")

if conformance.get("claim", "documented-subset") != "documented-subset":
    errors.append("conformance.claim: only documented-subset is allowed; never auto-claim full formal conformance")

def kind(node_id):
    return (node_by_id.get(node_id) or {}).get("kind")

def require_target(target):
    if target not in targets:
        errors.append(f"conformance.targets: textbook-strict {diagram_type!r} requires {target!r}")

multiplicity_re = re.compile(r"^(?:\d+|\*|\d+\.\.(?:\d+|\*))$")
crow_cardinality = {"0..1", "1", "0..*", "1..*"}

def has_generalization_cycle():
    graph = {}
    for edge in edges:
        if isinstance(edge, dict) and edge.get("relation") == "extends":
            graph.setdefault(edge.get("from"), []).append(edge.get("to"))
    visiting, visited = set(), set()
    def dfs(node):
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        for nxt in graph.get(node, []):
            if dfs(nxt):
                return True
        visiting.remove(node)
        visited.add(node)
        return False
    return any(dfs(node) for node in list(graph))

if mode == "textbook-strict":
    if diagram_type in {"usecase", "sequence", "class"}:
        require_target("omg-uml-2.5.1")

    if diagram_type == "usecase":
        for i, node in enumerate(nodes):
            if isinstance(node, dict) and node.get("kind") not in {"actor", "usecase"}:
                errors.append(f"nodes[{i}].kind: strict use-case node must be actor or usecase")
        for i, edge in enumerate(edges):
            if not isinstance(edge, dict):
                continue
            rel, src, dst = edge.get("relation"), edge.get("from"), edge.get("to")
            sk, dk = kind(src), kind(dst)
            if rel == "associates" and {sk, dk} != {"actor", "usecase"}:
                errors.append(f"edges[{i}]: use-case association must connect actor and usecase")
            elif rel in {"includes", "extends"} and not (sk == dk == "usecase"):
                errors.append(f"edges[{i}]: {rel} must connect usecase to usecase")
            elif rel == "generalizes" and not (sk == dk and sk in {"actor", "usecase"}):
                errors.append(f"edges[{i}]: generalization must connect same-kind actors or usecases")
            if rel == "extends":
                eps = edge.get("extension_points") or []
                if not eps:
                    errors.append(f"edges[{i}].extension_points: strict UML extend requires extension point(s)")
                target_eps = set((node_by_id.get(dst) or {}).get("extension_points") or [])
                for ep in eps:
                    if ep not in target_eps:
                        errors.append(f"edges[{i}].extension_points: {ep!r} is not declared on extended use case {dst!r}")

    if diagram_type == "sequence":
        message_sorts = {"synchCall", "asynchCall", "asynchSignal", "createMessage", "deleteMessage", "reply"}
        for i, edge in enumerate(edges):
            if not isinstance(edge, dict):
                continue
            ms = edge.get("message_sort")
            if ms not in message_sorts:
                errors.append(f"edges[{i}].message_sort: strict UML sequence requires a valid MessageSort")
            if ms == "synchCall" and edge.get("sync") is not True:
                errors.append(f"edges[{i}].sync: synchCall must be synchronous")
            if ms in {"asynchCall", "asynchSignal"} and edge.get("sync") is not False:
                errors.append(f"edges[{i}].sync: {ms} must be asynchronous")
        fragment_kinds = {"alt", "opt", "loop", "break", "par", "seq", "strict", "critical", "neg", "assert", "ignore", "consider"}
        for i, frag in enumerate(fragments):
            if not isinstance(frag, dict):
                errors.append(f"interaction_fragments[{i}]: must be a mapping")
                continue
            if frag.get("kind") not in fragment_kinds:
                errors.append(f"interaction_fragments[{i}].kind: invalid UML InteractionOperatorKind")
            contained = frag.get("edges") or []
            if not isinstance(contained, list) or not contained:
                errors.append(f"interaction_fragments[{i}].edges: fragment must reference message edges")
            else:
                for eid in contained:
                    if eid not in edge_ids:
                        errors.append(f"interaction_fragments[{i}].edges: unknown edge {eid!r}")

    if diagram_type == "class":
        for i, node in enumerate(nodes):
            if isinstance(node, dict) and node.get("kind") not in {"class", "interface", "enum", "abstract-class"}:
                errors.append(f"nodes[{i}].kind: strict class diagram uses classifier kinds only")
        for i, edge in enumerate(edges):
            if not isinstance(edge, dict):
                continue
            rel, src, dst = edge.get("relation"), edge.get("from"), edge.get("to")
            if rel == "implements" and kind(dst) != "interface":
                errors.append(f"edges[{i}]: implements target must be an interface")
            if rel == "extends" and kind(src) == "interface" and kind(dst) != "interface":
                errors.append(f"edges[{i}]: interface generalization target must be interface")
            for field in ("cardinality_from", "cardinality_to"):
                value = edge.get(field)
                if nonempty(value) and not multiplicity_re.match(str(value)):
                    errors.append(f"edges[{i}].{field}: invalid UML multiplicity {value!r}")
            nav = edge.get("navigability")
            if nonempty(nav) and nav not in {"unspecified", "from-to", "to-from", "bidirectional", "none"}:
                errors.append(f"edges[{i}].navigability: invalid value {nav!r}")
        if has_generalization_cycle():
            errors.append("class generalization: cycle detected")

    if diagram_type in {"c4-landscape", "c4-context", "c4-container", "c4-component", "c4-dynamic"}:
        require_target("c4-model")
        if not nonempty(presentation.get("title")):
            errors.append("presentation.title: C4 strict mode requires diagram type + scope title")
        legend = presentation.get("legend") or {}
        if not isinstance(legend, dict) or legend.get("show") is not True:
            errors.append("presentation.legend.show: C4 strict mode requires a key/legend")
        for i, node in enumerate(nodes):
            if not isinstance(node, dict):
                continue
            if not nonempty(node.get("kind")):
                errors.append(f"nodes[{i}].kind: C4 strict mode requires explicit element type")
            if not nonempty(node.get("responsibility")):
                errors.append(f"nodes[{i}].responsibility: C4 element requires short description")
            if diagram_type in {"c4-container", "c4-component"} and node.get("kind") in {"container", "component", "datastore", "queue"}:
                if not nonempty(node.get("tech")):
                    errors.append(f"nodes[{i}].tech: C4 container/component requires technology")
        for i, edge in enumerate(edges):
            if isinstance(edge, dict) and not nonempty(edge.get("label")):
                errors.append(f"edges[{i}].label: C4 relationship must describe intent")

    if "iso-iec-ieee-42010-2022" in targets:
        if expected_profile != "architecture":
            errors.append("ISO 42010 target is supported only for architecture views")
        if not nonempty(architecture_description.get("entity_of_interest")):
            errors.append("architecture_description.entity_of_interest: required for ISO 42010 alignment")
        stakeholders = architecture_description.get("stakeholders") or []
        concerns = architecture_description.get("concerns") or []
        viewpoint = architecture_description.get("viewpoint") or {}
        if not isinstance(stakeholders, list) or not stakeholders:
            errors.append("architecture_description.stakeholders: at least one stakeholder required")
            stakeholders = []
        if not isinstance(concerns, list) or not concerns:
            errors.append("architecture_description.concerns: at least one concern required")
            concerns = []
        stakeholder_ids = {s.get("id") for s in stakeholders if isinstance(s, dict) and s.get("id")}
        concern_ids = {c.get("id") for c in concerns if isinstance(c, dict) and c.get("id")}
        for i, stakeholder in enumerate(stakeholders):
            if not isinstance(stakeholder, dict) or not nonempty(stakeholder.get("name")):
                errors.append(f"architecture_description.stakeholders[{i}].name: required")
            if isinstance(stakeholder, dict) and not nonempty(stakeholder.get("evidence")):
                errors.append(f"architecture_description.stakeholders[{i}].evidence: required")
        for i, concern in enumerate(concerns):
            if not isinstance(concern, dict) or not nonempty(concern.get("name")):
                errors.append(f"architecture_description.concerns[{i}].name: required")
            if isinstance(concern, dict) and not nonempty(concern.get("evidence")):
                errors.append(f"architecture_description.concerns[{i}].evidence: required")
        if not isinstance(viewpoint, dict):
            errors.append("architecture_description.viewpoint: must be a mapping")
        else:
            if not nonempty(viewpoint.get("name")):
                errors.append("architecture_description.viewpoint.name: required")
            viewpoint_stakeholders = viewpoint.get("stakeholders") or []
            viewpoint_concerns = viewpoint.get("concerns") or []
            if not isinstance(viewpoint_stakeholders, list) or not viewpoint_stakeholders:
                errors.append("architecture_description.viewpoint.stakeholders: viewpoint must address at least one known stakeholder")
                viewpoint_stakeholders = []
            if not isinstance(viewpoint_concerns, list) or not viewpoint_concerns:
                errors.append("architecture_description.viewpoint.concerns: viewpoint must frame at least one known concern")
                viewpoint_concerns = []
            for sid in viewpoint_stakeholders:
                if sid not in stakeholder_ids:
                    errors.append(f"architecture_description.viewpoint.stakeholders: unknown stakeholder {sid!r}")
            for cid in viewpoint_concerns:
                if cid not in concern_ids:
                    errors.append(f"architecture_description.viewpoint.concerns: unknown concern {cid!r}")
            model_kinds = viewpoint.get("model_kinds") or []
            if not isinstance(model_kinds, list) or not model_kinds:
                errors.append("architecture_description.viewpoint.model_kinds: at least one model kind required")

    if diagram_type == "er":
        options = view.get("options") or {}
        if not isinstance(options, dict):
            errors.append("view.options: must be a mapping")
            options = {}
        er_mode = options.get("er_mode")
        if er_mode not in {"conceptual-chen", "logical-crows-foot", "physical-crows-foot"}:
            errors.append("view.options.er_mode: strict ER requires conceptual-chen, logical-crows-foot, or physical-crows-foot")
        if er_mode == "conceptual-chen":
            require_target("chen-1976")
            for i, node in enumerate(nodes):
                if isinstance(node, dict) and node.get("kind") not in {"entity", "weak-entity", "relationship", "attribute"}:
                    errors.append(f"nodes[{i}].kind: Chen mode supports entity/weak-entity/relationship/attribute")
            if not any(isinstance(node, dict) and node.get("kind") == "relationship" for node in nodes):
                errors.append("conceptual-chen: relationship must be a first-class relationship node")
            for i, edge in enumerate(edges):
                if not isinstance(edge, dict):
                    continue
                if edge.get("relation") not in {"participates", "identifies", "has-attribute", "isa"}:
                    errors.append(f"edges[{i}].relation: invalid Chen relation {edge.get('relation')!r}")
                participation = edge.get("participation")
                if nonempty(participation) and participation not in {"total", "partial"}:
                    errors.append(f"edges[{i}].participation: Chen participation must be total or partial")
            weak_ids = {n.get("id") for n in nodes if isinstance(n, dict) and n.get("kind") == "weak-entity"}
            for weak_id in weak_ids:
                if not any(isinstance(e, dict) and e.get("relation") == "identifies" and (e.get("from") == weak_id or e.get("to") == weak_id) for e in edges):
                    errors.append(f"weak entity {weak_id!r}: requires identifying relationship evidence")
        elif er_mode in {"logical-crows-foot", "physical-crows-foot"}:
            require_target("ie-crows-foot")
            for i, edge in enumerate(edges):
                if not isinstance(edge, dict):
                    continue
                for field in ("cardinality_from", "cardinality_to"):
                    value = str(edge.get(field) or "")
                    if value not in crow_cardinality:
                        errors.append(f"edges[{i}].{field}: Crow's Foot cardinality must be one of {sorted(crow_cardinality)}")
                if er_mode == "physical-crows-foot" and edge.get("identifying") not in {True, False}:
                    errors.append(f"edges[{i}].identifying: physical Crow's Foot requires true/false")

print(
    f"SPEC CHECK: {path.name} — {len(nodes)} nodes, {len(edges)} relations, "
    f"{len(boundaries)} boundaries — mode={mode}"
)
for warning in warnings:
    print(f"WARNING: {warning}")
if errors:
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    print(f"SPEC INVALID: {len(errors)} error(s)", file=sys.stderr)
    raise SystemExit(1)

print("SPEC VALID: evidence, structural invariants, and requested conformance subset passed")
