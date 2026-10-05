# Chat load: dependency failures and database pressure

## Observed failure

During the 2026-10-05 diagnostic run across 20 conversations, the 5/s stage
completed 300/300 sender confirmations. At 10/s, 586/600 were confirmed before
the runner stopped on `/auth/socket-token` returning 502. The remaining 14
were disconnected attempts, not confirmed lost database records.

At 14:24:46 UTC, Nginx retried a `/monitoring/overview` 503 against both Gateway
addresses. Gateway logs report `auth.verify_token` timeouts. Subsequent Nginx
requests report `no live upstreams`, including `/auth/socket-token` at 14:25:28.
Both Gateway containers were running with zero restarts and no OOM kill.

User Service separately reported Prisma P2024 on `user.findMany`, with
`connection_limit=1` and the existing 10-second pool acquisition timeout.
Participant hydration competes with Auth's user lookup in that pool.

## Changes

- Nginx does not retry or quarantine a Gateway because it returned application
  503. Transport failures and HTTP 502/504 still use the existing failover policy.
  Auth outages remain 503; missing/invalid credentials remain rejected.
- The chat gateway passes its freshly loaded conversation to the bot trigger,
  avoiding a second MongoDB read and participant RPC for the same message.
- Concurrent participant hydration for the same set of IDs shares one pending
  RPC. The entry is discarded on success, error or the unchanged 5-second
  deadline. No completed profile cache or authorization cache is introduced.
- Compose gives User Service a pool budget of **2 connections per replica**,
  configured with `USER_DATABASE_CONNECTION_LIMIT`. Its Prisma service overrides
  only `connection_limit`; SSL and timeout URL parameters are preserved. Outside
  Compose, omitting the override retains the database URL's original limit.

The inspected Aiven server allows 20 connections, with 3 reserved. The pool
increase adds one potential connection at the current single User replica.
Recheck the combined budget before scaling replicas or increasing any pool.
An override of `1` restores the old User Service budget. No migrations or data
deletion are required.

## Verification

Unit tests cover concurrent lookup sharing, fresh reads after completion,
failure/timeout cleanup, independent participant sets, validation isolation,
bot membership with a dispatch snapshot, and pool option preservation.

The isolated Nginx regression runs the actual proxy configuration with two mock
Gateways in a disposable container, without host ports or database access:

```sh
python3 infra/nginx/test-upstream-policy.py
```

It alternates dependency 503 and protected-route 401, checking that neither
healthy Gateway is quarantined. The old policy must fail this scenario.

After deployment, rerun the same 20-room diagnostic with one sender plus one
observer, retaining the 8-second message deadline and all auth checks. Record
actual stage rates, acknowledgements, receiver delivery, errors, skips, phase
metrics and Nginx/User logs. A planned 50/s stage is not evidence of completed
50/s capacity.

References: [Nginx retry and failure policy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream),
[Prisma connection pool](https://www.prisma.io/docs/orm/v6/prisma-client/setup-and-configuration/databases-connections/connection-pool).
