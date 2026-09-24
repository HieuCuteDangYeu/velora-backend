#!/usr/bin/env bash
# Cheap repository self-test for plugin structure and script syntax.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
core="$root/skills/repo-diagram"

required=(
  "$core/SKILL.md"
  "$core/assets/spec.template.yaml"
  "$core/references/semantic-ir.md"
  "$core/references/renderer-strategy.md"
  "$core/references/visual-compiler.md"
  "$core/references/profiles/architecture.md"
  "$core/references/profiles/sequence.md"
  "$core/references/profiles/class.md"
  "$core/references/profiles/er.md"
  "$core/references/profiles/state.md"
  "$core/references/profiles/dataflow.md"
  "$core/references/profiles/deployment.md"
  "$core/references/profiles/callgraph.md"
  "$core/references/profiles/usecase.md"
  "$core/references/profiles/flowchart.md"
  "$core/references/standards/README.md"
  "$core/references/standards/uml-2.5.1.md"
  "$core/references/standards/architecture.md"
  "$core/references/standards/erd.md"
  "$core/references/standards/coverage-matrix.md"
)

for f in "${required[@]}"; do
  [ -s "$f" ] || { echo "missing required file: $f" >&2; exit 1; }
done

for f in "$core"/scripts/*.sh; do bash -n "$f"; done
python3 -m py_compile "$core/scripts/geometry_router.py" "$core/scripts/text_metrics.py" "$core/scripts/visual_lint_svg.py" "$core/scripts/visual_analyze_svg.py" "$core/scripts/render_architecture_svg.py" "$core/scripts/render_polished.py" "$core/scripts/validate_spec.py"

if python3 -c 'import yaml' >/dev/null 2>&1; then
  expect_pass() {
    local fixture="$1"
    echo "EXPECT PASS: $(basename "$fixture")"
    if ! python3 "$core/scripts/validate_spec.py" "$fixture"; then
      echo "expected valid fixture failed: $fixture" >&2
      exit 1
    fi
  }

  expect_fail() {
    local fixture="$1"
    echo "EXPECT FAIL: $(basename "$fixture")"
    if python3 "$core/scripts/validate_spec.py" "$fixture"; then
      echo "expected invalid fixture passed: $fixture" >&2
      exit 1
    fi
  }

  expect_pass "$core/tests/fixtures/valid-sequence.spec.yaml"
  expect_pass "$core/tests/fixtures/valid-strict-usecase.spec.yaml"
  expect_pass "$core/tests/fixtures/valid-strict-c4.spec.yaml"
  expect_pass "$core/tests/fixtures/valid-strict-sequence.spec.yaml"
  expect_pass "$core/tests/fixtures/valid-strict-class.spec.yaml"
  expect_pass "$core/tests/fixtures/valid-strict-chen.spec.yaml"
  expect_pass "$core/tests/fixtures/valid-strict-iso42010.spec.yaml"

  expect_fail "$core/tests/fixtures/invalid-missing-evidence.spec.yaml"
  expect_fail "$core/tests/fixtures/invalid-strict-usecase.spec.yaml"
  expect_fail "$core/tests/fixtures/invalid-strict-er.spec.yaml"
  expect_fail "$core/tests/fixtures/invalid-strict-iso42010.spec.yaml"
fi

if python3 -c 'import yaml' >/dev/null 2>&1; then
  tmp_visual="$(mktemp -d)"

  visual_expect_pass() {
    local svg="$1"
    local output
    shift
    if ! output="$(python3 "$core/scripts/visual_analyze_svg.py" "$svg" --strict "$@" 2>&1)"; then
      echo "expected visual pass failed: $svg" >&2
      echo "$output" >&2
      exit 1
    fi
  }
  cat > "$tmp_visual/architecture.spec.yaml" <<'YAML'
question: smoke
type: c4-container
scope: self-test
nodes:
  - {id: client, label: Client, semantic_role: clients, evidence: ["test"]}
  - {id: api, label: API, semantic_role: api, evidence: ["test"]}
  - {id: broker, label: Broker, semantic_role: messaging, evidence: ["test"]}
  - {id: db, label: DB, semantic_role: data, evidence: ["test"]}
edges:
  - {id: e1, from: client, to: api, relation: calls, label: HTTPS, sync: true, evidence: ["test"]}
  - {id: e2, from: api, to: db, relation: writes, label: SQL, sync: true, evidence: ["test"]}
  - {id: e3, from: api, to: broker, relation: publishes, label: event, sync: false, evidence: ["test"]}
presentation:
  style: polished-overview
  title: Smoke Architecture
  legend: {show: true}
layout:
  crossing_target: 0
YAML
  python3 "$core/scripts/render_architecture_svg.py" "$tmp_visual/architecture.spec.yaml" "$tmp_visual/architecture.svg" >/dev/null
  visual_expect_pass "$tmp_visual/architecture.svg" --max-crossings 0
  python3 "$core/scripts/render_polished.py" "$tmp_visual/architecture.spec.yaml" "$tmp_visual/architecture-auto.svg" --max-passes 3 >/dev/null
  [ -s "$tmp_visual/architecture-auto.svg" ]
  bash "$core/scripts/render_any.sh" "$tmp_visual/architecture.spec.yaml" "$tmp_visual/architecture-any.svg" >/dev/null
  [ -s "$tmp_visual/architecture-any.svg" ]

  cat > "$tmp_visual/same-row.spec.yaml" <<'YAML'
question: same-row routing
type: c4-container
scope: self-test
nodes:
  - {id: a, label: Service A, semantic_role: domain, responsibility: "Processes a deliberately long responsibility sentence so adaptive node copy is exercised without clipping.", evidence: ["test"]}
  - {id: b, label: Service B, semantic_role: domain, evidence: ["test"]}
edges:
  - {id: same, from: a, to: b, relation: calls, label: HTTP, sync: true, evidence: ["test"]}
view:
  primary_path: [a, b]
presentation:
  style: polished-overview
  title: Same Row
layout:
  crossing_target: 0
YAML
  python3 "$core/scripts/render_architecture_svg.py" "$tmp_visual/same-row.spec.yaml" "$tmp_visual/same-row.svg" >/dev/null
  visual_expect_pass "$tmp_visual/same-row.svg" --max-crossings 0
  grep -q 'data-primary="true"' "$tmp_visual/same-row.svg"

  cat > "$tmp_visual/regions.spec.yaml" <<'YAML'
question: region geometry
type: c4-container
scope: self-test
nodes:
  - {id: a, label: "IIIIIIIIIIII", semantic_role: domain, evidence: ["test"]}
  - {id: b, label: "WWWWWWWWWWWW", semantic_role: domain, evidence: ["test"]}
edges:
  - {id: ab, from: a, to: b, relation: calls, label: "HTTP / internal", sync: true, evidence: ["test"]}
boundaries:
  - {id: runtime, name: Runtime, contains: [a, b], kind: process, evidence: ["test"]}
presentation:
  style: polished-overview
  title: Region Geometry
  groups:
    - {id: pair, label: Core Pair, contains: [a, b]}
layout:
  rows:
    - {id: core, label: Core, nodes: [a, b]}
  crossing_target: 0
YAML
  python3 "$core/scripts/render_architecture_svg.py" "$tmp_visual/regions.spec.yaml" "$tmp_visual/regions.svg" >/dev/null
  visual_expect_pass "$tmp_visual/regions.svg" --max-crossings 0
  grep -q 'data-region-kind="boundary"' "$tmp_visual/regions.svg"
  grep -q 'data-region-kind="presentation"' "$tmp_visual/regions.svg"

  cat > "$tmp_visual/bad.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 180">
  <g data-node-id="a"><rect x="20" y="20" width="80" height="50"/></g>
  <g data-node-id="b"><rect x="110" y="65" width="80" height="50"/></g>
  <g data-node-id="c"><rect x="200" y="110" width="80" height="50"/></g>
  <g data-edge-id="e" data-source-id="a" data-target-id="c"><path d="M 60,45 L 240,135"/></g>
</svg>
SVG
  if python3 "$core/scripts/visual_analyze_svg.py" "$tmp_visual/bad.svg" --strict >/dev/null 2>&1; then
    echo "expected geometry defect was not detected" >&2
    exit 1
  fi

  cat > "$tmp_visual/overlap.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 220">
  <g data-node-id="a"><rect x="20" y="20" width="60" height="40"/></g>
  <g data-node-id="b"><rect x="320" y="20" width="60" height="40"/></g>
  <g data-node-id="c"><rect x="20" y="160" width="60" height="40"/></g>
  <g data-node-id="d"><rect x="320" y="160" width="60" height="40"/></g>
  <g data-edge-id="e1" data-source-id="a" data-target-id="b"><path d="M 80,40 L 200,40 L 200,90 L 320,90"/></g>
  <g data-edge-id="e2" data-source-id="c" data-target-id="d"><path d="M 80,180 L 200,180 L 200,90 L 320,90"/></g>
</svg>
SVG
  if python3 "$core/scripts/visual_analyze_svg.py" "$tmp_visual/overlap.svg" --strict >/dev/null 2>&1; then
    echo "expected overlapping-edge defect was not detected" >&2
    exit 1
  fi

  cat > "$tmp_visual/congestion.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 260">
  <g data-node-id="hub"><rect x="160" y="20" width="100" height="50"/></g>
  <g data-node-id="a"><rect x="20" y="190" width="70" height="40"/></g>
  <g data-node-id="b"><rect x="120" y="190" width="70" height="40"/></g>
  <g data-node-id="c"><rect x="220" y="190" width="70" height="40"/></g>
  <g data-edge-id="p1" data-source-id="hub" data-target-id="a"><path d="M 210,70 L 210,120 L 55,120 L 55,190"/></g>
  <g data-edge-id="p2" data-source-id="hub" data-target-id="b"><path d="M 210,70 L 210,140 L 155,140 L 155,190"/></g>
  <g data-edge-id="p3" data-source-id="hub" data-target-id="c"><path d="M 210,70 L 210,160 L 255,160 L 255,190"/></g>
</svg>
SVG
  if python3 "$core/scripts/visual_analyze_svg.py" "$tmp_visual/congestion.svg" --strict >/dev/null 2>&1; then
    echo "expected port-congestion defect was not detected" >&2
    exit 1
  fi

  cat > "$tmp_visual/bad-region.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 260">
  <g data-region-kind="presentation" data-group-id="g" data-members="a">
    <rect x="20" y="20" width="420" height="160"/>
  </g>
  <g data-node-id="a"><rect x="60" y="70" width="100" height="50"/></g>
  <g data-node-id="b"><rect x="260" y="70" width="100" height="50"/></g>
</svg>
SVG
  if python3 "$core/scripts/visual_analyze_svg.py" "$tmp_visual/bad-region.svg" --strict >/dev/null 2>&1; then
    echo "expected unrelated-node region capture was not detected" >&2
    exit 1
  fi

  cat > "$tmp_visual/sparse.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 900">
  <g data-node-id="a"><rect x="420" y="100" width="100" height="50"/></g>
  <g data-node-id="b"><rect x="420" y="200" width="100" height="50"/></g>
  <g data-node-id="c"><rect x="420" y="300" width="100" height="50"/></g>
  <g data-node-id="d"><rect x="420" y="400" width="100" height="50"/></g>
</svg>
SVG
  python3 "$core/scripts/visual_analyze_svg.py" "$tmp_visual/sparse.svg" > "$tmp_visual/sparse.out"
  grep -Eq 'EXCESS_BOTTOM_WHITESPACE|SPARSE_COMPOSITION' "$tmp_visual/sparse.out"

  cat > "$tmp_visual/nonrepairable.spec.yaml" <<'YAML'
question: nonrepairable grouping
type: c4-container
scope: self-test
nodes:
  - {id: a, label: A, semantic_role: domain, evidence: ["test"]}
  - {id: b, label: B, semantic_role: domain, evidence: ["test"]}
  - {id: c, label: C, semantic_role: domain, evidence: ["test"]}
edges: []
presentation:
  style: polished-overview
  groups:
    - {id: bad, label: Bad Group, contains: [a, c]}
layout:
  rows:
    - {id: row, nodes: [a, b, c]}
  crossing_target: 0
YAML
  if python3 "$core/scripts/render_polished.py" "$tmp_visual/nonrepairable.spec.yaml" "$tmp_visual/nonrepairable.svg" --max-passes 3 >"$tmp_visual/nonrepairable.out" 2>&1; then
    echo "expected non-repairable grouping to fail auto-repair" >&2
    exit 1
  fi
  grep -q 'AUTO-REPAIR STOP' "$tmp_visual/nonrepairable.out"
  grep -q 'REGION_CAPTURES_UNRELATED_NODE' "$tmp_visual/nonrepairable.out"

  rm -rf "$tmp_visual"
fi

if command -v dot >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  printf 'digraph G { A -> B; }\n' > "$tmp/smoke.dot"
  bash "$core/scripts/render_any.sh" "$tmp/smoke.dot" "$tmp/smoke.svg" >/dev/null
  [ -s "$tmp/smoke.svg" ]
fi

grep -q "No evidence, no element" "$core/SKILL.md"
grep -q "semantic-ir.md" "$core/SKILL.md"
grep -q "renderer-strategy.md" "$core/SKILL.md"
grep -q "visual-compiler.md" "$core/SKILL.md"
grep -q "validate_spec.py" "$core/SKILL.md"
grep -q "visual review" "$core/references/diagram-reviewer-procedure.md"
grep -q "textbook-strict" "$core/SKILL.md"
grep -q "documented-subset" "$core/references/standards/README.md"

echo "repo-diagrammer self-test: PASS"
