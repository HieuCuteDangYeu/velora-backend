# Velora indexing and retrieval diagrams

These diagrams are source-backed views of the current Reel indexing and RAG retrieval workflows at commit `56fce3e2`.

- `reel-indexing-workflow.spec.yaml` is the Repo Diagrammer evidence model for the Reel Indexing LangGraph.
- `reel-indexing-workflow.png` is the final image deliverable for Reel indexing.
- `rag-retrieval-workflow.spec.yaml` is the Repo Diagrammer evidence model for retrieval and answer grounding.
- `rag-retrieval-workflow.png` is the final image deliverable for RAG retrieval and answer grounding.

Refresh the specs from the current source before changing the drawings. Validate the evidence models with:

```bash
python3 .agents/skills/repo-diagram/scripts/validate_spec.py docs/diagrams/reel-indexing-workflow.spec.yaml
python3 .agents/skills/repo-diagram/scripts/validate_spec.py docs/diagrams/rag-retrieval-workflow.spec.yaml
```
