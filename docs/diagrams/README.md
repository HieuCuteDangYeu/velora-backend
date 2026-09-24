# Velora Reel pipeline diagrams

These diagrams are source-backed views of the current Reel media, indexing, and RAG retrieval workflows. The media diagrams were refreshed against backend commit `fd757662` and Velora-Mobile commit `2b044e3`; the relevant mobile upload/streaming ranges are unchanged by the local mobile working-tree edits present during review.

- `reel-upload-workflow.spec.yaml` is the evidence model for client upload, transactional outbox delivery, attempt fencing, HLS generation, validation, and media-to-index handoff.
- `reel-upload-workflow.png` is the final image deliverable for Reel upload and media processing.
- `reel-streaming-workflow.spec.yaml` is the evidence model for API HLS delivery, mobile prefetch, persistent offline caching, and playback source selection.
- `reel-streaming-workflow.png` is the final image deliverable for Reel streaming and mobile caching.
- `reel-indexing-workflow.spec.yaml` is the Repo Diagrammer evidence model for the Reel Indexing LangGraph.
- `reel-indexing-workflow.png` is the final image deliverable for Reel indexing.
- `rag-retrieval-workflow.spec.yaml` is the Repo Diagrammer evidence model for retrieval and answer grounding.
- `rag-retrieval-workflow.png` is the final image deliverable for RAG retrieval and answer grounding.

Refresh the specs from the current source before changing the drawings. Validate the evidence models with:

```bash
python3 .agents/skills/repo-diagram/scripts/validate_spec.py docs/diagrams/reel-upload-workflow.spec.yaml
python3 .agents/skills/repo-diagram/scripts/validate_spec.py docs/diagrams/reel-streaming-workflow.spec.yaml
python3 .agents/skills/repo-diagram/scripts/validate_spec.py docs/diagrams/reel-indexing-workflow.spec.yaml
python3 .agents/skills/repo-diagram/scripts/validate_spec.py docs/diagrams/rag-retrieval-workflow.spec.yaml
```
