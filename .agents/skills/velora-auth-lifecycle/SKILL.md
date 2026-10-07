---
name: velora-auth-lifecycle
description: Preserve Velora authentication lifecycle invariants for registration, rolling refresh sessions, recovery/replay, logout, roles, verification, password reset, and related gateway/auth changes.
---

# Velora Auth Lifecycle

Use this skill for changes to registration, login, refresh/logout, roles, verification codes, password reset, JWTs, or auth Redis state.

## Invariants

- User Service owns identity/profile data; Auth Service owns credentials, roles, refresh-token state, and transient auth state.
- Password and Google login issue 15-minute access tokens and refresh tokens valid for 90 days. Each successful fresh rotation sets replacement expiry to the refresh time plus `REFRESH_TOKEN_TTL_MS`, using `getRefreshTokenExpiresAt(now)`. Periodically refreshed sessions may continue indefinitely; do not add a deadline tied to the original login.
- Individual persisted `expiresAt` and JWT signature/expiry still govern validity. The nullable Prisma/domain `absoluteExpiresAt` field is legacy metadata: ignore historical values, write null on new login/rotation rows, and retain the column without destructive cleanup. Previously expired or revoked tokens stay invalid; existing JWTs adopt the new TTL only after successful rotation.
- Refresh tokens have unique JWT IDs and are stored as SHA-256 hashes plus encrypted tokens. Preserve legacy lookup/upgrading, encryption and transactional compare-and-set consumption (`id` plus `revoked: false`), old-token revocation, and replacement linkage.
- After JWT verification, a missing stored token or unrecoverable replay/rotation conflict revokes all refresh tokens for the verified user. An invalid JWT or expired individual token is rejected without introducing global revocation.
- A revoked token may recover its already-issued replacement only with the same `refreshRequestId`, within the existing five-minute recovery window, and with an unrevoked, unexpired, encrypted replacement. Recovery returns the existing refresh token and expiry plus a new access token; it does not rotate again or extend either window. Preserve same-request CAS-conflict recovery.
- Logout revokes the presented refresh token and invalidates role caching. Preserve gateway push-token cleanup and 401/403 credential clearing; infrastructure failures must not be misreported as invalid credentials.
- Gateway refresh cookies use the same rolling 90-day lifetime and are replaced on refresh; access cookies remain 15 minutes. Update all issuance paths/callers and their tests when changing TTL policy.
- Mobile auth retains in-memory access tokens, SecureStore refresh tokens and retry IDs, single-flight `refreshPromise`, and cold-start `hydrateAuth()`. Keep mobile body-token endpoints separate from browser cookie endpoints.
- Password-reset tokens are single-use: consume the Redis token atomically before updating the password. Do not restore a consumed token after a downstream failure.
- Registration spans User and Auth state. Preserve compensation for a created user and assigned roles when later registration steps fail.
- Redis role entries (`roles:{userId}`, 900-second TTL) are a cache, not the authority. Do not make correctness depend on the cache being present.
- Verification/reset values are transient Redis state with TTLs; keep them scoped to their existing key namespaces rather than introducing a second source of truth.

## Repository evidence

- `apps/auth-service/src/domain/refresh-token.constants.ts`
- `apps/auth-service/src/domain/entities/refresh-token.entity.ts`
- `apps/auth-service/prisma/schema.prisma`
- `apps/auth-service/src/application/use-cases/login.use-case.ts`
- `apps/auth-service/src/application/use-cases/google-login.use-case.ts`
- `apps/auth-service/src/application/use-cases/refresh-token.use-case.ts`
- `apps/auth-service/src/infrastructure/repositories/auth.repository.ts`
- `apps/auth-service/src/application/use-cases/logout.use-case.ts`
- `apps/api-gateway/src/auth/auth.controller.ts`
- `apps/auth-service/src/application/use-cases/register.use-case.ts`
- `apps/auth-service/src/application/use-cases/reset-password.use-case.ts`
- `apps/auth-service/src/infrastructure/repositories/redis-user-role.repository.ts`
- `apps/auth-service/src/auth-service.module.ts`
- `apps/user-service/src/user-service.module.ts`

## Focused verification

Run `pnpm exec jest --runInBand apps/auth-service apps/api-gateway/src/auth`. Cover both login JWT lifetimes, repeated refresh beyond the login date, ignored legacy caps, expiry, replay, recovery-window boundaries, CAS, logout, browser cookies and mobile 401/403 clearing.

For actual PostgreSQL concurrency/storage/revocation checks, run `auth.repository.integration.spec.ts` with `AUTH_TEST_DATABASE_URL` pointing to a disposable database initialized with the Auth Prisma schema. Never initialize or clear a production database for this test. Also run auth/gateway typechecks, scoped lint and builds when runtime code changes.

Auth diagrams 18–20 must show the active-individual-token guard and replacement expiry = now + rolling TTL while retaining recovery, replay, CAS and client retry branches. Update embedded draw.io source evidence and semantic metadata with source changes.
