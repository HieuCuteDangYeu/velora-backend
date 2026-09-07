# RAG evaluator in CI/CD

`rag-eval` is intentionally a separate, profile-gated image. It is not a production application service and normal `docker compose up -d` must not start it.

## Pipeline

### Pull request

`Homelab CI/CD` now requires:

1. normal repository validation/build checks;
2. build the isolated `eval/rag/Dockerfile` image;
3. run `pnpm eval:rag:test` inside that image;
4. run `pnpm eval:rag:offline --dataset rag-generalization-v1` inside that image;
5. only then build affected ARM64 application images.

These evaluator steps receive no provider credentials and must make:

- 0 production requests;
- 0 provider calls;
- 0 frozen primary executions;
- 0 RAGAS judge calls.

### Master / production promotion

Before `homelab-deploy` advances, CI requires:

1. normal validation;
2. the same zero-provider evaluator gate;
3. affected production application images published to Docker Hub;
4. a matching ARM64 evaluator image published as both:
   - `rag-eval:latest`;
   - `rag-eval:<checkout-sha>`;
5. evaluator image labels:
   - `org.opencontainers.image.revision=<checkout-sha>`;
   - `io.velora.production-sha=<checkout-sha>`.

Only after all required jobs succeed does CI fast-forward `homelab-deploy`.

## Actual homelab deployment completion

The repository CI promotes `homelab-deploy`; the machine-side deploy agent is responsible for applying that branch to the homelab. Therefore GitHub must not assume that branch promotion itself means the new containers are already running.

After the machine has deployed the promoted SHA and completed its normal health checks, it should emit a repository dispatch event:

```json
{
  "event_type": "homelab-deployed",
  "client_payload": {
    "production_sha": "<40-char deployed sha>",
    "evaluator_sha": "<40-char evaluator sha>",
    "status": "healthy"
  }
}
```

`evaluator_sha` may equal `production_sha` and is optional in the workflow implementation; when omitted it defaults to the production SHA.

The token used by the deploy agent must be stored outside the repository and scoped only as broadly as required to emit the repository dispatch event. Never commit it.

Until the machine-side agent is configured to emit this event, operators can run the `RAG Post-Deploy Gate` workflow manually and supply the deployed production SHA.

## Post-deploy gate

The `RAG Post-Deploy Gate` workflow:

1. requires a `healthy` deployment receipt (or explicit manual healthy attestation);
2. verifies that the receipt SHA exactly matches `origin/homelab-deploy`;
3. pulls the exact `rag-eval:<evaluator-sha>` image;
4. checks the evaluator and production SHA image labels;
5. reruns evaluator tests from the published image;
6. reruns offline `rag-generalization-v1` from the published image.

It intentionally performs no live/frozen benchmark and receives no provider credentials.

## Frozen and semantic acceptance

`rag-frozen-ami-v2` is not an ordinary CI test. It consumes the real deployed production path and may consume hosted-model quota. It remains an explicit acceptance action after deployment and post-deploy precheck.

Required order:

```text
PR offline evaluator gate
  -> build/publish
  -> promote homelab-deploy
  -> machine deploy + health check
  -> RAG Post-Deploy Gate
  -> explicit frozen deterministic evaluation
  -> deterministic HARD_GATE_PASS=YES
  -> semantic RAGAS judge
```

Never automatically resend `FAILED_RECONCILED` or completed frozen cases, and never run semantic RAGAS when the deterministic hard gate fails.
