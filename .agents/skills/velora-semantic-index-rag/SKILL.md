---
name: velora-semantic-index-rag
description: Preserve Velora semantic-index ownership, candidate commit safety, Reel access scoping, and RAG retrieval boundaries across Content, Reel Indexing, and AI services.
---

# Velora Semantic Index and RAG

Use this skill for Reel indexing, semantic search/reindexing, RAG routing/retrieval, context access, or semantic candidate lifecycle changes.

## Invariants

- Content Service owns Reel business state and decides which shared Reels a conversation/user may access.
- Reel Indexing Service owns canonical semantic documents (`ReelDocument`, `ReelSection`, `ReelChunk`, visual scenes) and their active candidate lifecycle. AI must use the indexing RPC boundary, not the indexing database.
- Resolve Reel access before router/retrieval work, and constrain every semantic query/neighbor expansion to the Content-resolved Reel IDs. Retrieval logic may narrow access, never widen it.
- Persist and validate a semantic candidate before activation. Before commit, recheck that the indexing attempt is still current.
- Candidate activation and Content completion form a guarded commit protocol: if Content rejects/fails completion, roll back activation and discard the candidate. Serve only active semantic rows.
- Keep attempt IDs and index versions as concurrency/provenance fences; stale attempts must not replace the currently accepted index.
- AI and Reel Indexing application layers have an explicit test-enforced clean-architecture boundary. Do not import infrastructure or `ConfigService` into their application source. Do not generalize this exact enforcement to unrelated services without current tests/code evidence.

## Repository evidence

- `apps/content-service/src/application/use-cases/resolve-reel-context-access.use-case.ts`
- `apps/reel-indexing-service/src/infrastructure/workflows/reel-index-langgraph.workflow.ts`
- `apps/reel-indexing-service/src/application/use-cases/commit-semantic-candidate.use-case.ts`
- `apps/reel-indexing-service/src/infrastructure/repositories/prisma-semantic-index.repository.ts`
- `apps/ai-service/src/infrastructure/adapters/langgraph-rag-chat-workflow.adapter.ts`
- `apps/ai-service/src/application/use-cases/retrieve-reel-evidence.use-case.ts`
- `apps/ai-service/src/infrastructure/adapters/reel-semantic-index.adapter.ts`
- `apps/ai-service/src/application/clean-architecture.spec.ts`
- `libs/common/src/processing/interfaces/semantic-index.interface.ts`
