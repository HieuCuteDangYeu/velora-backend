# Layout quality

A diagram has two independent jobs:

1. **Tell the truth** — every architectural element and relationship is evidence-backed.
2. **Make the truth easy to see** — hierarchy, proximity, spacing and edge routing let a
   reviewer understand the picture without decoding it.

Do not trade one for the other. A beautiful unsupported diagram is dangerous; an
accurate spaghetti diagram is unfinished.

## 1. Declaration order controls layout

Mermaid uses Dagre and PlantUML uses Sugiyama-style layered layout. Both place
elements largely in the order they appear in the source. Reordering declarations
changes the picture more than most styling directives.

Declare in **reading order**:

- actors and entry points first;
- ingress / edge next;
- core runtime components in call order;
- broker / workers near the components that use them;
- data stores, observability and external systems last.

Declare every real node explicitly before declaring edges. Letting nodes be created
implicitly by edge statements scatters them in edge order.

```
%% bad
flowchart LR
  api --> db
  user --> web
  web --> api

%% good
flowchart LR
  user(["User"])
  web["Web"]
  api["API"]
  db[("DB")]
  user --> web
  web --> api
  api --> db
```

## 2. Edge crossings are the strongest readability signal

Treat crossings as a quantity to minimise.

Practical moves, in order:

1. Reorder declarations so connected nodes are adjacent.
2. Put nodes with the same responsibility near each other.
3. Use a real boundary or a presentation group when appropriate.
4. Flip direction (`LR` ↔ `TB`).
5. Split or zoom out when crossings persist.

Zero crossings is the target for ≤10 nodes. For a medium high-level overview, more
than two avoidable crossings should trigger another layout pass.

For geometry-owned SVG output, this is not merely advisory. Run
`visual_analyze_svg.py --strict` and treat `EDGE_NODE_CROSSING`, `NODE_OVERLAP`, and
crossings above the declared budget as Blocking.

Never insert invisible spacer nodes merely to coerce the renderer. They make the
source brittle. Prefer ordering, grouping and direction.

## 3. Boundaries and presentation groups are different things

A **boundary** claims architecture: process, network, trust boundary or bounded
context. It requires evidence.

A **presentation group** claims only that evidenced nodes are easier to read together.
It is allowed for high-level architecture, but it must obey all of these rules:

- every member is an already evidenced node;
- it does not create a new dependency;
- edges connect the real nodes, not the presentation group;
- it is visually softer than a real system/network boundary;
- its label describes a responsibility already supported by its members;
- if the group could be mistaken for a deployment or trust boundary, do not use it.

This distinction lets a diagram have the visual clarity of a designed architecture
poster without weakening strict traceability.

## 4. Use one meaning per visual channel

Colour is secondary to layout, but a high-level diagram may use a semantic palette
when the mapping is stable and declared.

Recommended channel separation:

- **node fill/stroke** → architectural role (ingress, API, realtime, messaging,
  data, observability, external);
- **edge line pattern** → interaction semantics (solid sync, dashed async/event,
  thick primary media/data path where needed);
- **shape** → node kind (actor, service, datastore, broker).

Do not reuse one colour for unrelated meanings. If more than one edge style or more
than two node roles are used, include a compact legend.

## 5. Visual hierarchy for high-level architecture

Generic "backend architecture" and "system overview" requests should read like a
designed technical poster, not raw graph output.

Default hierarchy:

1. **Clients / actors** at the top.
2. **Ingress / edge** directly below, spanning the system width.
3. **Primary service lane** next: API, realtime, payment or other major runtime groups.
4. **Messaging / async lane** centered near the services it connects.
5. **Supporting service groups** below.
6. **Data layer and observability** at the bottom.
7. **External integrations** on the right or far edge.

Keep the primary path visually straight. Secondary paths should branch away from it,
not cut across it.

Density targets for `polished-overview`:

- 6–12 top-level visual regions;
- actual service node: usually 1–3 text lines;
- presentation group heading: usually ≤4 words;
- responsibility copy: one short phrase, not prose;
- avoid a canvas wider than roughly 2.2:1 or taller than roughly 1.6:1 when a balanced
  landscape layout can represent the same information;
- no literal `\\n` in rendered labels — use `<br/>`.

## 6. Proximity beats colour

Related elements should be near each other even if they share a colour. Unrelated
elements should not be made to look related merely because a palette is convenient.

Data stores and observability belong near the perimeter unless they are the primary
subject. External systems should be visually separated from the owned/runtime system
boundary.

## Quick pre-render check

- Are nodes declared explicitly in reading order?
- Is the primary path obvious from declaration order alone?
- Are real boundaries evidence-backed?
- Are presentation groups clearly non-boundary groupings?
- Does each visual channel encode one consistent meaning?
- Direction: `LR` for true pipelines; `TB` for layered high-level architecture by default?
- Are labels short enough to keep boxes balanced?
- Any hub with >6 edges that should be represented as a broker/group rather than a
  giant central box?

## Machine geometry gate

Before subjective inspection, run the geometry analyzer on the rendered SVG. It can
measure node overlap, edge-through-node defects, edge/edge crossings, tight gaps,
route stretch and canvas aspect. Read `visual-compiler.md` for confidence rules and
repair order.

A machine PASS does not prove good typography or visual hierarchy, but a machine
Blocking finding means the diagram is not deliverable.

## Post-render visual acceptance gate

Look at the actual rendered output, not only source.

A high-level `polished-overview` does **not ship** until:

- the entry point and primary path are identifiable in about two seconds;
- text is readable at 100% zoom;
- there are no truncated labels, overlaps or literal escape sequences;
- spacing is visually balanced — no giant empty quadrant next to a dense cluster;
- service boxes at the same level have comparable visual weight;
- avoidable edge crossings are at or below target;
- data, external and observability regions sit at the perimeter unless central to the question;
- legend semantics match the actual styling;
- presentation groups do not receive architectural edges.

If a renderer is unavailable, mark visual validation as unverified. Do not claim a
polished render passed without seeing a render.
