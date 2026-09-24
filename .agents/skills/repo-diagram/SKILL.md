---
name: repo-diagram
description: Evidence-backed repository analysis that builds a semantic model and produces senior-quality architecture, sequence, class, ER, state, dataflow, deployment, call graph, use case, flowchart, and swimlane diagrams in Mermaid, PlantUML, or Graphviz.
---

# Repo Diagram

Treat diagramming as repository analysis, not illustration.

The pipeline is:

```text
question → repository evidence → semantic IR → view → type profile → layout plan → renderer → geometry gate → visual/source review
```

## Rules that override everything

1. **No evidence, no element.** Unsupported facts go to Gaps.
2. **Extract before recalling.** Prefer deterministic tools for structure/schema/deps.
3. **Model facts separately from views.** Read `references/semantic-ir.md`.
4. **One question + one abstraction per diagram.**
5. **Every type has its own contract.** Load `references/profiles/<type>.md`.
6. **Renderer follows semantics.** Read `references/renderer-strategy.md`.
7. **Truth and presentation are independent quality gates.** A correct ugly/unreadable
   diagram is unfinished.
8. **Never claim validation/review you could not actually perform.**
9. **Standards claims are explicit and bounded.** Read `references/standards/`.
   Use `practical` by default. If the user asks for OMG/UML/C4/ISO/Chen/Crow's Foot,
   textbook, academic, thesis, or standards-grade output, switch the spec to
   `conformance.mode: textbook-strict` and select the appropriate target(s).
   The plugin may claim only its documented subset, never automatic full formal conformance.

Keep real code identifiers visible. Write prose in the user's language.

## Host portability

The same workflow must work in Claude Code and Codex. Resolve plugin files with
`${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}` where available. Provider-specific subagents
are optional accelerators; when unavailable, run the same scout/reviewer procedure inline.

## Step 0 — Fix the question

If scope/type is clear, proceed. Ask at most one question only when ambiguity would
materially change the view. Audience matters: onboarding, architecture review,
incident/debugging, stakeholder.

## Step 1 — Map and locate

Whole repo:
```bash
bash "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/repo_map.sh" [repo]
```

Feature:
```bash
bash "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/feature_trace.sh" <keyword> [repo]
```

Use 2–3 synonyms. On large repos, use the bounded repo-scout procedure per subsystem.

## Step 2 — Extract deterministic facts

Run:
```bash
bash "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/check_deps.sh"
bash "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/extract_structure.sh" <mode> [path]
```

Use tools for class hierarchy/import graph/schema/routes. Hand-trace only runtime
intent, event wiring, dynamic dispatch and boundaries. Read source ranges, not entire
files. Stop at network/DB/queue/framework boundaries and record the edge.

## Step 3 — Build the evidence IR

Read `references/semantic-ir.md` and fill `assets/spec.template.yaml`.

Every node/relation needs evidence. Record semantics such as async/sync, order,
condition, guard, cardinality, dataset, protocol and confidence when relevant.

For a diagram set, create `docs/diagrams/model.spec.yaml` first and derive views
from stable model IDs.

Run the mechanical traceability gate before rendering:

```bash
python3 "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/validate_spec.py" path/to/<slug>.spec.yaml
```

It rejects missing evidence, broken endpoints, duplicate IDs, false presentation
targets, profile/type mismatches, and type-specific structural violations. If PyYAML
is unavailable, disclose that the mechanical spec gate was not run and perform the
same checks in review.

## Step 4 — Choose type + profile + conformance mode

Use `references/diagram-types.md`. Then load the exact quality profile under
`references/profiles/`.

Choose conformance deliberately:
- `practical`: default for normal engineering work;
- `textbook-strict`: when the user asks for standards/textbook/thesis/formal notation.

For textbook-strict, read `references/standards/README.md` plus the matching standard
file. Select only targets relevant to the requested view. Do not add ISO 42010 metadata
unless architecture-description alignment is actually requested.

The profile defines:
- required semantic facts;
- budget/abstraction;
- visual hierarchy;
- preferred renderer;
- Blocking review defects.

High-level/backend/system architecture also loads
`references/high-level-architecture-style.md` and `references/visual-compiler.md`.

## Step 5 — Choose renderer and write source

Read `references/renderer-strategy.md`, `references/notation.md`, and
`references/visual-compiler.md`. Do not default blindly to Mermaid.

Record preferred/fallback renderer in the spec. A fallback is allowed only if it
preserves semantics.

Plan layout before source:
- primary story/path;
- declaration/participant order;
- real boundaries;
- presentation-only groups;
- direction and crossing target;
- legend semantics.

## Step 6 — Render and visual-review

For source files:
```bash
bash "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/render_any.sh" path/to/diagram.mmd
bash "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/render_any.sh" path/to/diagram.puml
bash "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/render_any.sh" path/to/diagram.dot
```

For static high-level architecture with `presentation.style: polished-overview`,
use the geometry-owned auto-repair renderer:
```bash
python3 "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/repo-diagram/scripts/render_polished.py" path/to/<slug>.spec.yaml path/to/<slug>.svg
```

It renders, runs the strict geometry gate, and retries presentation-only spacing when
the remaining defects are mechanically repairable. It stops instead of mutating the
model when the defect requires grouping/model correction. Never mark visual review
passed while a Blocking geometry defect remains.

For Markdown Mermaid blocks use `validate_mermaid.sh`.

Inspect the **rendered result at 100%** against the selected profile. Iterate on
ordering/grouping/copy/layout until it passes. Static SVG lint is only a pre-check.

## Step 7 — Source-backed reviewer pass

Apply `references/diagram-reviewer-procedure.md` in a clean context when possible.

Blocking categories:
- CONTRADICTED
- UNCITED
- OMITTED
- WRONG-SEMANTICS
- ABSTRACTION
- VISUAL

Fix all Blocking findings before delivery.

## Step 8 — Deliver

Deliver:
- diagram source;
- conformance mode and target(s), including the phrase "documented subset" for strict mode;
- SVG/PNG when rendering is available/useful;
- question/scope/type/commit;
- selected profile and renderer;
- validation + visual-review status;
- evidence table;
- gaps/assumptions;
- tech-lead findings.

Default:
`docs/diagrams/<slug>.md` + `<slug>.spec.yaml`.

For sets, include `model.spec.yaml` and an ordered README.

## References

- `diagram-types.md` — view selection
- `semantic-ir.md` / `spec-schema.md` — model/view IR
- `extraction.md` — deterministic extraction
- `profiles/` — per-type semantic + presentation contracts
- `renderer-strategy.md` — renderer capability matrix
- `notation.md` — syntax/parser traps/templates
- `layout-quality.md` — cross-type readability
- `visual-compiler.md` — geometry ownership, analyzer and repair loop
- `high-level-architecture-style.md` — polished architecture visual system
- `repo-scout-procedure.md` — bounded exploration
- `diagram-reviewer-procedure.md` — final quality gate
- `research-basis.md` — standards/tooling basis
- `standards/` — normative, academic, and textbook sources plus strict subset contracts
