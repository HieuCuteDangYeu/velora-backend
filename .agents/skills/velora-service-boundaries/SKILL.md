---
name: velora-service-boundaries
description: Preserve Velora service ownership, RabbitMQ boundaries, gateway responsibilities, and shared cross-service contracts when changing service communication.
---

# Velora Service Boundaries

Use this skill for gateway routes, service RPC/events, queue topology, adapters, or shared cross-service payloads.

## Invariants

- Keep domain persistence owned by the service that owns that domain. Do not introduce cross-service database access.
- Put stable cross-service request/event/response contracts in `libs/common/src/` and import the concrete file directly; `libs/common` intentionally has no barrel files.
- Use Nest `ClientProxy.send()` / `emit()` for ordinary service RPC and events. The durable Reel media/index pipelines are an explicit exception: they use direct AMQP exchanges, persistent messages, retry queues, DLQs, and manual ACK/NACK.
- Keep the API gateway as an edge/orchestration boundary, not a domain-data owner. Edge enrichment and fallback such as `apps/api-gateway/src/content/reel-author.service.ts` are acceptable; persistent business state belongs downstream.
- Do not assume every service has a database. `api-gateway`, `media-service`, and `media-processing-service` intentionally have no local Prisma schema.

## Repository evidence

- `apps/api-gateway/src/api-gateway.module.ts`
- `apps/api-gateway/src/content/reel-author.service.ts`
- `apps/content-service/src/infrastructure/adapters/reel-media-job-publisher.adapter.ts`
- `apps/content-service/src/infrastructure/adapters/reel-index-job-publisher.adapter.ts`
- `libs/common/src/processing/interfaces/semantic-index.interface.ts`
- `libs/common/src/processing/interfaces/reel-media-job.interface.ts`
- `libs/common/src/processing/interfaces/reel-index-job.interface.ts`
