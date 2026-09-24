# Deployment profile

## Semantic contract
One environment per view unless comparison is explicit. Distinguish deployment nodes,
infrastructure nodes and application/container instances. Nest only real runtime
hierarchy. Replicas, ports, protocols, volumes and routing require evidence.
Network/trust zones require infra/config proof. Show important ingress and egress.

## Presentation contract
Topology/geography first, call flow second. External traffic enters from a clear
perimeter. Same node type uses same visual language. Collapse instances as ×N only
when replica count is evidenced. Do not mix source-code components into topology.
Legend provider/cloud icons.

## Renderer
PlantUML preferred; Mermaid flowchart fallback.

## Blocking
Guessed infrastructure; environments mixed; replica count invented; component shown
as machine/node; decorative network boundary.
