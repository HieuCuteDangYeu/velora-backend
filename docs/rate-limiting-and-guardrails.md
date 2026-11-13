# Rate limiting and the RAG guardrail

Status: deployed 2026-11-09 (`c3112146`). Rate limits are enforced. The guardrail runs in shadow mode only.

## Rate limiting

A token bucket kept in the shared Redis, updated by one Lua script, so every gateway and
conversation-service replica shares a single budget. Code: `libs/common/src/rate-limit/`.

- A policy has a capacity and a window (for example 10 per 60 s). Each request spends one token and the bucket
  refills continuously, so short bursts are allowed and sustained abuse is not.
- Public routes are keyed by client IP (IPv6 by /64). Login, resend-verification and forgot-password are also
  keyed by a SHA-256 of the submitted email, so rotating IPs cannot hammer one account or mailbox.
- Authenticated routes are keyed by user id. Per-user rules run after `JwtAuthGuard`.
- If Redis is slow or down (100 ms timeout, circuit breaker), a policy either falls back to a per-process
  limit (`local`: login, upload, publish, AI) or lets the request through (`allow`). An outage never blocks users.

### Policies (defaults)

| Policy | Limit | Applies to |
|---|---|---|
| `auth_login_ip` / `auth_login_account` | 10/min / 5 per 5 min | `POST /auth/login`, `/auth/mobile/login` |
| `auth_register_ip` | 10/hour | register |
| `auth_google_ip` | 20/min | Google verify (web and mobile) |
| `auth_refresh_ip`, `auth_logout_ip` | 60/min, 30/min | refresh, logout |
| `auth_confirm_ip` | 10 per 5 min | confirm account |
| `auth_resend_ip` / `auth_resend_account` | 5 per 10 min / 3 per hour | resend verification |
| `auth_forgot_ip` / `auth_forgot_account` | 5 per 10 min / 3 per hour | forgot password |
| `auth_reset_ip` | 10 per 10 min | reset password |
| `public_share_ip` | 60/min | `GET /r/:token` |
| `media_upload_url_user`, `media_finalize_user` | 30 per 10 min each | media upload |
| `content_publish_user` | 20/hour | create or reprocess a reel |
| `content_write_user`, `content_share_user`, `content_comment_user` | 60, 30, 30 per min | other content writes |
| `content_events_user` | 120/min | `POST /content/reels/events` |
| `friend_request_user` / `friend_write_user` | 30/hour / 60/min | friend requests / accept, reject, block, unfriend |
| `ai_turn_minute`, `ai_turn_day` | 10/min, 300/day | per-user AI-reply budget (REST and WebSocket) |

The values are starting estimates. The source of truth is `rate-limit.policies.ts`.

### Configuration

| Variable | Meaning |
|---|---|
| `RATE_LIMIT_<POLICY>_LIMIT`, `RATE_LIMIT_<POLICY>_WINDOW_SECONDS` | Override one policy, for example `RATE_LIMIT_AUTH_LOGIN_IP_LIMIT=20`. |
| `RATE_LIMIT_ENABLED=false` | Kill switch for every policy. |
| `RATE_LIMIT_REDIS_TIMEOUT_MS` | Redis call timeout (default 100). |
| `TRUST_PROXY_HOPS` | Proxies in front of the gateway for `req.ip` (default 1). |
| `RATE_LIMIT_CLIENT_IP_HEADER` | Read the client IP from this header instead (only if the edge overwrites it). |

**Production topology:** Cloudflare, then `cloudflared`, then nginx, then the gateway. nginx always sees the tunnel
as the client, so production sets `RATE_LIMIT_CLIENT_IP_HEADER=cf-connecting-ip` and `TRUST_PROXY_HOPS=2`.
A wrong value puts every user in one bucket and locks everyone out at the login limit. After changing the proxy
chain, verify with logins from two different networks.

### Client contract

- HTTP: `429` with body `{ "statusCode": 429, "message": "...", "retryAfterSeconds": n }` and headers
  `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining: 0`.
- AI chat over REST or WebSocket: the user's message is stored, the AI reply is withheld, and the conversation room
  receives `bot_reply_failed`:

  ```json
  { "conversationId": "...", "userMessageId": "...", "clientMessageId": "...",
    "error": { "code": "RATE_LIMITED", "message": "You are asking Velora AI too quickly. ...", "retryAfterSeconds": 12 } }
  ```

  Clients should show a message and may offer a retry after `retryAfterSeconds`. Other codes are `AI_UNAVAILABLE`,
  `NO_CONTENT`, `UNKNOWN` and `AI_BUSY`.
- `AI_BUSY` is not a per-user limit: the model server is saturated (see `docs/model-host.md`). It carries the same
  `retryAfterSeconds` and means "try again shortly".

### Clients

- **velora-mobile** (Expo / React Native, repo `lequan170205/Velora-Mobile`, commit `d596575`) listens for
  `bot_reply_failed` in `SocketProvider` and shows the failure as an in-memory bot message in the thread. It builds
  its own wording per code (`src/lib/conversation/botReplyFailurePolicies.ts`) and falls back to the server text only
  for a code it does not know. The notice is removed when a bot token or a confirmed bot message arrives.
- Bot replies are triggered by `send_message` (socket) or `POST /conversations/:id/messages` (REST). Both reach the
  same `ai_turn_*` budget in conversation-service, so no client can bypass it. (A `POST /conversations/chat`
  convenience endpoint and its `ai_chat_user` pre-check existed until 2026-11-09; it had no callers and was removed.)

## RAG guardrail (shadow by default, input check can enforce)

In shadow mode it records what a guardrail would block and changes nothing. Code: `apps/ai-service/src/domain/services/rag-guardrail/`
(rules), `application/use-cases/screen-rag-*.use-case.ts` and `build-rag-guardrail-summary.use-case.ts`.

- Input: instruction override, prompt extraction, jailbreak personas and role tags (English and Vietnamese), including
  obfuscation (zero-width, homoglyphs, leetspeak, spaced letters, full-width text, base64).
- Evidence: text in reel transcript, OCR or metadata that addresses the assistant.
- Output: secrets, system-prompt text, leaked IDs, remote-image exfiltration, citations outside the accessible reels.

Each request that produces a finding logs one line with codes only, never text:
`[Guardrail] execution=<id> mode=shadow wouldBlock=<bool> input=<codes> evidence=<codes> output=<codes>`.
The same summary is added to the Langfuse root output.

`AI_GUARDRAIL_MODE=off|shadow|enforce` (default `shadow`), with per-check overrides `AI_GUARDRAIL_INPUT_MODE`,
`AI_GUARDRAIL_EVIDENCE_MODE`, `AI_GUARDRAIL_OUTPUT_MODE`. Only the **input** check can enforce; for evidence and
output `enforce` is read as `shadow`.

With the input check enforcing, a message with a **high** input finding is answered with a fixed refusal
(`RAG_INPUT_REFUSAL_MESSAGE`) before the chat-admission queue, the router, retrieval or any model call, so a refused
message never takes a model slot. The decision lives in `RefuseRagInputUseCase`, called first by `StreamChatUseCase`;
the workflow adapter itself stays shadow-only. Medium findings are still answered. The log line is
`[Guardrail] mode=enforce blocked=true input=<codes>`. A refused turn never reaches RAG telemetry and is not
summarised or remembered (`HandleConversationTurnCompletedUseCase` asks the same use case), so the refused text cannot
return through memory. If the check itself fails it fails open.

Know the cost before turning it on: the check is a pattern list, so a quoted attack ("the video says to ignore all
previous instructions, is that real?") is refused too, and rewordings it has never seen still get through. The measured
catch and false-positive rates are in `eval/rag/README.md`. To roll back, unset `AI_GUARDRAIL_INPUT_MODE` (or set it
to `shadow`) and redeploy; nothing is stored.

## Scope: staying on topic

Velora AI only helps with Velora: Reels and videos, finding something to watch, the user's own chat and saved memory,
and using the app. A message about anything else (general knowledge, coding, maths, writing, translation, advice,
live data) is answered with one fixed redirect, `OFF_TOPIC_REDIRECT_MESSAGE`, and the question is not answered.

- The router (`QueryRouterAgentUseCase`) has an `OFF_TOPIC` intent. It adds no model call. The graph sends that intent
  straight to `noContextAnswerNode`: no retrieval, memory, tools or verifier. It is reported as `finalFailureSource=NONE`
  (not a failure) in telemetry.
- A router error still falls back to ordinary chat, so a model outage cannot make the bot refuse everything.
- `AI_SCOPE_MODE=enforce|off` (default `enforce`). `off` demotes `OFF_TOPIC` to normal chat and restores the open
  general-knowledge instruction in the draft step. Rollback is an `.env` change plus recreating ai-service.
- The draft step also carries a scope instruction, but it is weak: on `gemma4:e2b` about two thirds of the unrelated
  prompts that reach it are still answered. The router is the gate.

Measured on the production model (`eval/rag/README.md`): 76 of 79 unrelated messages caught, 0 of 143 in-scope messages
refused. Unrelated messages that slip through (advice and "suggest" style requests) are answered normally.

## After every deploy

1. A green "Homelab CD" run only means images were built and `homelab-deploy` was promoted. The homelab deploys by
   pulling that ref. Confirm with `docker ps` on the host and `~/.local/state/velora/deployed-sha`.
2. The deploy controller pauses with `CONFIG DRIFT DETECTED` when the production `.env` differs from
   `~/.local/state/velora/env.sha256`. Reviewing and approving a new baseline is an operator decision.
3. Run `scripts/deploy/ensure-reel-indexing-qdrant --check` (read-only). A CI deploy recreates
   `reel-indexing-service` and `reel-indexing-long-service` from the plain `docker-compose.yml`, which drops their
   Qdrant settings (image `velora-reel-indexing-qdrant:*`, the `QDRANT_*` variables and `reel-vector-net`), and
   every index job then fails with `Qdrant vector publication must be enabled`. `--apply` re-applies the host
   overlay (`VELORA_QDRANT_INDEX_OVERLAY`, default `~/velora-operations/qdrant-staging/index-rollout.yml`) and
   re-checks. The permanent fix is to select `docker-compose.qdrant.yml` in the deploy environment once the gates in
   that file's header are met.
4. The installed launcher `/usr/local/bin/velora-deploy` is root-owned and is not updated by CD. When a deploy
   change needs a newer launcher, reinstall it with `sudo scripts/deploy/install-velora-deploy-launcher`.
