---
name: velora-auth-lifecycle
description: Preserve Velora authentication lifecycle invariants for registration, refresh/logout, roles, verification, password reset, and related gateway/auth changes.
---

# Velora Auth Lifecycle

Use this skill for changes to registration, login, refresh/logout, roles, verification codes, password reset, JWTs, or auth Redis state.

## Invariants

- User Service owns identity/profile data; Auth Service owns credentials, roles, refresh-token state, and transient auth state.
- Refresh tokens are persisted and rotated. A missing or revoked presented refresh token is treated as replay and revokes the user's refresh-token family before failing.
- Password-reset tokens are single-use: consume the Redis token atomically before updating the password. Do not restore a consumed token after a downstream failure.
- Registration spans User and Auth state. Preserve compensation for a created user and assigned roles when later registration steps fail.
- Redis role entries (`roles:{userId}`, 900-second TTL) are a cache, not the authority. Do not make correctness depend on the cache being present.
- Verification/reset values are transient Redis state with TTLs; keep them scoped to their existing key namespaces rather than introducing a second source of truth.

## Repository evidence

- `apps/auth-service/src/application/use-cases/register.use-case.ts`
- `apps/auth-service/src/application/use-cases/refresh-token.use-case.ts`
- `apps/auth-service/src/application/use-cases/reset-password.use-case.ts`
- `apps/auth-service/src/infrastructure/repositories/redis-user-role.repository.ts`
- `apps/auth-service/src/auth-service.module.ts`
- `apps/user-service/src/user-service.module.ts`
