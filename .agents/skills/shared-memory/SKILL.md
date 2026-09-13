---
name: shared-memory
description: Use the shared local agentmemory MCP to recover relevant prior engineering decisions, failures, outcomes, and lessons without flooding context. Use for substantial tasks where historical project context can avoid repeated exploration, and after verified work when a concise durable lesson should be preserved.
---

# Shared Agent Memory

Use agentmemory to avoid rediscovering history. Never treat memory as the source of truth.

## Source-of-truth order

For current implementation facts, prefer:

1. current repository code and tests
2. current GitHub issue/PR requirements
3. version-controlled `AGENTS.md` and repository skills
4. authoritative project documentation
5. shared memory

If memory conflicts with the current repository, the repository wins.

## Read path

For substantial work where prior decisions or failures may matter, use the agentmemory MCP tools exposed by the current agent:

- `memory_smart_search` for the normal retrieval path
- `memory_recall` when a direct keyword-oriented recall is enough
- `memory_sessions` only when session history itself matters

Start with a concise task-specific query and a small result set. Do not inject the whole memory store into context.

The harness defaults to keyless local operation with local MiniLM embeddings and the lean core MCP tool set. No OpenAI, Gemini, or Anthropic API key is required for normal recall/save behavior.

Skip memory retrieval for trivial edits where history is unlikely to change the solution.

## Write path

After work is verified, use `memory_save` or `memory_lesson_save` only for durable engineering knowledge such as:

- accepted architecture decisions
- non-obvious invariants
- root causes of important failures
- successful remediation patterns
- task outcomes future agents are likely to need

Keep writes concise and evidence-based. Include the relevant GitHub issue, PR, or commit when useful so future agents can verify the claim.

Do not store:

- passwords, API keys, tokens, secrets, or private credentials
- reproducible raw logs
- full chat transcripts merely because they exist
- temporary implementation details
- speculative conclusions

## Automatic behavior

Do not enable broad automatic context injection merely because the feature exists. The harness keeps automatic context injection and LLM compression off by default to protect context size and avoid unnecessary API usage.

Retrieve memory deliberately when it can materially improve the task.

## Project boundaries

agentmemory is shared across connected local agents. Current repository context should be included in saved lessons when the knowledge is repository-specific. Treat memory namespaces and tags as retrieval aids, not security boundaries.

## ChatGPT Web bridge

When `codex-chatgpt-web` Full Harness is enabled, ChatGPT Web operates through the current Codex tool surface. Because agentmemory is registered as a Codex MCP server, the same memory tools can be available through that harness without exposing raw storage or database administration.
