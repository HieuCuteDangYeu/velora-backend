---
name: velora-clean-architecture
description: Preserve Velora's Clean Architecture and Hexagonal layering when adding or changing backend services, use cases, repositories, adapters, controllers, modules, and shared contracts.
---

# Velora Clean Architecture

Use this skill for backend feature work that changes a service's domain, application, infrastructure, dependency injection, persistence, or transport boundaries.

## Core structure

Backend services follow three layers:

```text
domain/
  entities/ interfaces/ errors/
application/
  use-cases/ services/
infrastructure/
  controllers/ adapters/ repositories/ prisma/ services/ jobs/
```

- Domain owns entities, domain errors, and ports/interfaces. Domain must not depend on application or infrastructure.
- Application owns business orchestration and use cases. Depend on domain ports and shared contract types; do not import infrastructure implementations.
- Infrastructure owns Nest transport handlers, Prisma/Redis repositories, RMQ adapters, storage/provider implementations, configuration wiring, and scheduled/background jobs.
- Existing application-layer `ConfigService` or direct infrastructure imports are legacy exceptions, not patterns to copy into new code. AI and Reel Indexing already enforce the clean boundary with tests.

## Use-case shape

- Prefer one focused class per business operation under `application/use-cases/`.
- The public operation entrypoint is `execute(...)`.
- Do not bundle unrelated CRUD operations into one application service merely because they share an entity.
- Keep transport validation and `RpcException` mapping in infrastructure controllers; keep persistence mechanics in repositories.

When implementing a feature such as Series management, prefer separate use cases such as create/get/update/delete/add-member/remove-member/reorder instead of a single multi-method `SeriesUseCase`.

## Ports and dependency injection

- Define repository/service ports in `domain/interfaces/`.
- Application classes consume ports through string tokens such as `IContentRepository`, `IUserService`, and `IMailService`.
- Bind tokens to infrastructure implementations in the service module using `provide` + `useClass` or `useExisting`.
- Inter-service calls belong behind infrastructure adapters implementing domain ports; application code should not manipulate `ClientProxy` directly.

## Service and persistence ownership

- Each service owns its domain persistence. Never query another service's database directly.
- Services with databases keep their own Prisma schema/client and map persistence records back into domain entities in repositories.
- Some services intentionally have no database; do not create persistence merely for symmetry.
- For ordinary cross-service communication use RabbitMQ `send()` / `emit()` through adapters. The durable Reel media/index pipelines are the documented direct-AMQP exception; also load `velora-service-boundaries` or the relevant Reel skill when touching those paths.

## Shared contracts and gateway

- Put stable cross-service DTOs/schemas/interfaces in `libs/common/src/<domain>/...`.
- DTO validation uses Zod / `nestjs-zod`; the gateway applies `ZodValidationPipe` globally.
- `libs/common` has no barrel files. Import concrete files directly.
- The API Gateway is an edge boundary: HTTP/auth/validation/error translation and edge enrichment are allowed; persistent business rules and domain state belong to the owning service.

## Imports and naming

- Use repository path aliases for cross-directory imports when an alias exists.
- Follow existing suffixes: `*.use-case.ts`, `*.entity.ts`, `*.interface.ts`, `*.adapter.ts`, `*.repository.ts`, `*.controller.ts`, `*.dto.ts`.
- Do not introduce MVC-style model/service/controller layering inside a service; preserve the domain/application/infrastructure split.

## Before changing architecture

1. Trace the current execution path from gateway/controller to use case, port, adapter/repository, and persistence or remote service.
2. Find the closest existing use case with the same responsibility.
3. Put new behavior in the owning layer instead of the shortest convenient file.
4. Preserve existing service ownership and messaging boundaries.
5. Run focused tests/builds and any existing clean-architecture checks.

## Repository evidence

- Historical architecture contract: `references/QWEN.md`, recovered from commit `727afa1f`.
- `apps/auth-service/src/application/use-cases/register.use-case.ts`
- `apps/auth-service/src/auth-service.module.ts`
- `apps/content-service/src/application/use-cases/create-reel.use-case.ts`
- `apps/content-service/src/domain/interfaces/content.repository.interface.ts`
- `apps/content-service/src/infrastructure/repositories/content.repository.ts`
- `apps/content-service/src/infrastructure/adapters/friend-content-access.adapter.ts`
- `apps/ai-service/src/application/clean-architecture.spec.ts`
- `apps/api-gateway/src/main.ts`

The historical QWEN reference contains some statements that became too absolute as the repository evolved. Use it for architectural provenance; current code, tests, `AGENTS.md`, and repository skills remain authoritative for specific exceptions.
