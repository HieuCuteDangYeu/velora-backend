# Scoped production environment approval

The deployment controller keeps its global `.env` hash gate. A scheduled deploy
never approves drift automatically, and `--force` still reconciles the normal
application services. For TURN-only changes, use the narrower operator action:

```sh
velora-deploy --approve-turn-env /absolute/path/to/before-turn.env --dry-run
velora-deploy --approve-turn-env /absolute/path/to/before-turn.env
```

The controller must first reach `homelab-deploy` through the normal CI/CD path.
The backup must hash to the `.env` recorded for the last healthy deployment.
Keep it private (directory mode 700, file mode 600); never commit it. The current
production TURN backup is under the deployment state's `env-backups` directory.

Approval accepts only canonical `TURN_URLS=`, `TURN_USERNAME=` and
`TURN_CREDENTIAL=` assignments. All other bytes must remain unchanged; duplicate,
export-style and indented TURN assignments are rejected. The settings must be
all populated or all cleared/removed. Partial settings are refused. Call Service
still validates TURN URLs on startup, and normal deployment health checks apply.
Values must be single-line literals (optionally quoted), not variable
interpolations. Other env assignments cannot reference the TURN variables.
Files containing multiline quoted assignments are refused rather than treating
secret contents as standalone env keys; use the normal reviewed process for them.

The computed release plan must contain no application other than `call-service`,
no infrastructure reconciliation, and no database-impact change. Approval adds
Call Service to the plan when only credentials changed, even at the same SHA.
It cannot be combined with `--force`, rollback or DB approval. Unrelated changes
must use the normal reviewed deployment process, not this option.

No healthy env hash is written during approval or dry-run. It is updated only
after deployment health checks succeed, provided the approved `.env` is still
unchanged. Replacing Call Service interrupts active calls; schedule accordingly.
Other services retain their existing containers and do not consume these TURN
settings.

For Langfuse sampling, save the last-healthy `.env` from the deployment state's
`env-backups` directory, change only the canonical
`LANGFUSE_SAMPLE_RATE=<number>` assignment to a literal between `0` and `1`, then
run:

```sh
velora-deploy --approve-langfuse-sampling /absolute/path/to/before-sampling.env --dry-run
velora-deploy --approve-langfuse-sampling /absolute/path/to/before-sampling.env
```

This approval accepts only that setting, schedules only `ai-service`, and uses
the same health check, exact image snapshot, and env rollback guard as TURN
approval. Keep the backup private. It cannot be combined with `--force`, TURN
approval, rollback or DB approval. Use it again to restore sampling to `1` after
the Langfuse quota resets.

If post-deployment health verification fails, automatic image rollback first
restores the verified baseline `.env` atomically with mode 600. If either file
changed after approval, restoration is refused instead of overwriting an
operator's edit; manual recovery is required. Existing failures earlier in the
deployment command and later manual image rollbacks retain their existing
recovery behavior: inspect the failure and explicitly restore env as needed.

The guard can be checked without Docker or production credentials:

```sh
bash scripts/deploy/test-turn-env-approval.sh
```
