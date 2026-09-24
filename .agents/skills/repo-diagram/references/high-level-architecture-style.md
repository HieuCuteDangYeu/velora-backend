# Polished high-level architecture style

This profile exists for requests such as:

- "draw the backend architecture"
- "high-level architecture"
- "system overview"
- "vẽ kiến trúc backend"

Use it as the default presentation style unless the user explicitly asks for raw C4,
a monochrome engineering diagram, or a different visual language.

The style is **presentation only**. The evidence spec remains the source of truth.

## Non-negotiable traceability rules

1. Every architectural node still needs evidence.
2. Every architectural edge still needs evidence.
3. A title, subtitle, legend or row hint is decoration, not an architectural claim.
4. A presentation group may contain only evidenced nodes and may not receive edges.
5. Never collapse several services into one visual box when doing so would make an
   edge ambiguous. Keep the services as real nodes inside a presentation group.
6. If a short display label differs from the identifier, render the exact identifier
   somewhere in the node.

The rule is: **beautify the evidence; never beautify by inventing or blurring it.**

## Default composition

Prefer a balanced landscape composition with top-to-bottom layered flow. For
`polished-overview`, prefer the native SVG renderer described in `visual-compiler.md`;
use Mermaid `flowchart TB` when a portable notation source is explicitly preferred.

```text
                         Clients
                            │
                         Ingress
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
     API / REST         Realtime / Call       Other core
        │                   │                   │
        └────────────── Messaging ──────────────┘
                    │            │
             Supporting groups   │
                    │            │
          Data layer         Observability              External systems
```

This is a visual plan, not permission to invent any lane. Omit lanes that the evidence
does not support.

### Placement rules

- Clients: top center.
- Ingress / load balancer / reverse proxy: immediately below clients.
- Major runtime services: one horizontal lane.
- Broker / queue: centered under the services that use it.
- Worker/pipeline/supporting services: below the broker.
- Databases/cache: bottom-left or bottom-center.
- Observability: bottom-right.
- External systems: right side, outside the owned/runtime boundary.
- Webhook callers may enter from the right rather than being forced through the client lane.

For a genuine pipeline, use `LR`; do not force a pipeline into the poster layout.

## Semantic node palette

Use a restrained pastel palette. Node colour encodes **architectural role only**.

| Role | Fill | Stroke | Typical examples |
|---|---|---|---|
| clients | `#EAF3FF` | `#2F80ED` | mobile, dashboard, webhook caller |
| ingress | `#EAF3FF` | `#2F80ED` | nginx, gateway edge |
| api | `#F5F0FF` | `#8B5CF6` | API gateway / public HTTP service |
| realtime | `#FFF1F2` | `#F87171` | chat, call, notification |
| messaging | `#FFF7E6` | `#F59E0B` | RabbitMQ, Kafka, queues |
| processing | `#EFF6FF` | `#3B82F6` | media workers, pipelines |
| domain | `#ECFDF5` | `#34A853` | domain service groups |
| observability | `#ECFDF9` | `#14B8A6` | monitoring service |
| data | `#F8FAFC` | `#64748B` | PostgreSQL, MongoDB, Redis |
| external | `#FFF5F5` | `#EF4444` | SaaS, cloud storage, push providers |

Do not add colours for categories that are absent.

## Edge semantics

Keep the line system simple and put protocol in the label.

- solid arrow: synchronous request/call;
- dashed arrow: async publish/event/worker hand-off;
- thick arrow: one primary path only, when it materially helps;
- red or strongly accented line: reserve for media/UDP or external webhook only when
  that distinction is important to the question.

Do not use decorative colours on every edge. When multiple edge semantics appear,
include a legend.

Examples:

```mermaid
api -->|"REST request<br/>[HTTPS]"| svc
svc -.->|"publishes job<br/>[RabbitMQ]"| broker
client ==>|"WebRTC media<br/>[UDP 40000]"| call
```

## Node copy

A high-level node should be scannable, not a paragraph.

Preferred real service node:

```text
api-gateway
NestJS
REST API + RMQ clients
```

Preferred presentation group:

```text
Realtime communication
conversation-service · call-service · notification-service
Socket.IO + mediasoup + push
```

If that group would blur edge targets, render those services as separate small nodes
inside a panel labelled `Realtime communication`.

Avoid:

- sentences inside boxes;
- implementation details that belong in a component diagram;
- more than one responsibility sentence;
- labels wider than the surrounding lane;
- literal `\n`; Mermaid uses `<br/>`.

## Real boundaries vs presentation groups

Use visually different treatments:

- **real runtime/network boundary**: stronger dashed outline and explicit evidence;
- **presentation group**: light pastel panel or subtle solid outline;
- **external region**: separate panel outside the owned/runtime boundary.

Never call a presentation group "VPC", "cluster", "network" or "process" unless it
really is one.

## Legend

Include a compact legend when any of these are true:

- sync and async edges both appear;
- WebRTC/media has a distinct style;
- webhook direction is special;
- more than two semantic node roles use colour.

The legend is decoration and needs no source evidence, but it must describe the styles
actually used.

## Visual quality target

A polished overview should feel like a technical architecture poster:

- clear title and one-line subtitle in the delivered document/export;
- one obvious top-to-bottom story;
- balanced left/right weight, with machine warnings for strongly asymmetric margins;
- service groups aligned to a common grid;
- no accidental giant boxes caused by prose;
- no spaghetti around the broker;
- external integrations grouped rather than scattered;
- data and observability visually anchored at the bottom;
- whitespace between regions, not inside labels;
- no accidental presentation group/boundary capture of unrelated nodes.

A source-correct diagram that looks like raw auto-layout should be iterated before
delivery.

## Required review loop

For `presentation.style: polished-overview`:

1. Render from the evidence spec.
2. Run `visual_analyze_svg.py --strict` with the crossing budget.
3. If Blocking: reorder/reroute/shorten copy and render again.
4. Inspect the surviving final render at 100%.
5. Check primary path, hierarchy, balance, typography, labels and legend.
6. Only mark `Visual review: passed` when both geometry gate and rendered inspection pass.

If the environment cannot render Mermaid, do not silently substitute "looks valid in
source" for this loop. Mark visual review unverified.
