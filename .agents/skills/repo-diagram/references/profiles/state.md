# State-machine profile

## Semantic contract
The enum/status plus transition code are both required. Show initial and terminal
states. Every transition has a trigger; guards/actions appear only when source proves
them. Composite states require a real nested lifecycle. Choice/fork/join requires
matching branch/concurrency behavior.

## Presentation contract
Keep the normal lifecycle visually straight. Use one consistent accent for
failure/cancelled/terminal states. Recovery transitions should not dominate the graph.
TB is the default; LR is fine for time-like progression.

## Renderer
Mermaid stateDiagram-v2 preferred; PlantUML fallback.

## Blocking
Transition inferred from naming; terminal state missing; material guard omitted;
direction reversed; exception paths make normal lifecycle unreadable.
