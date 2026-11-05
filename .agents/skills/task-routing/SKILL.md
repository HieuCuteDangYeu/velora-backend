---
name: task-routing
description: Decide whether to delegate a substantial or high-risk project task, and which Orca-configured agent, reasoning effort, and quota pool to use. Not needed for routine single-session edits.
---

# Task routing

Use only when considering an Orca worker or when an explicitly requested
agent/provider comparison is needed. **Orca executes work**; this skill
only guides the selection decision.

## Decide whether to delegate

1. Inspect task scope, repository state, dependencies, risk, and tools.
2. Keep trivial/easy tasks in the parent session (low effort). Keep moderate
   tasks local (medium effort) unless expertise, isolation, or independent
   verification justifies a worker. Complex work may need high effort;
   critical work gets the strongest *supported* effort and independent review.
3. Use the currently installed Orca `orchestration` skill and its **live guide**
   for actual Runs, workers, worktrees, messages, and decision gates.
   Do not reproduce Orca commands here or build a second task scheduler.

## Choose a capable, available worker

1. Discover actual configured agents in Orca Settings -> Agents. Match
   expertise and access to the task (e.g. security, backend, mobile/device).
   Do not infer availability from a chat subscription or an example profile.
2. Check the current Orca **Usage** display for the *specific account and
   model-group pool*. Examine all reported rolling/daily/weekly windows and
   reset times. A missing or stale figure is **unknown**, not free capacity.
3. Prefer demonstrated task capability first, supported reasoning effort
   second, and verified quota headroom third. Preserve a reserve; avoid
   providers near exhaustion (80%+ usage is cautionary). For high-risk work,
   require an independent reviewer even when only one agent implements.
4. If usage or capabilities cannot be verified, stop automatic delegation:
   continue locally if safe, or request a manual choice. Never guess an agent,
   model ID, quota, permissions, or unsupported effort flag.

## Optional advisory helper

The harness CLI, when installed on the machine, can calculate a transparent
recommendation from **locally verified profiles and a recent usage snapshot**:

```bash
agent-harness route --difficulty hard --domain backend,security \
  --config ~/.config/agent-harness/agents.json \
  --usage ~/.config/agent-harness/usage.json
```

Use `routing/agents.example.json` and `routing/usage.example.json` from
the **harness source checkout** as schema examples; do not treat their
scores, quotas, or provider names as real observations. A current
`observed_at` and reported account/model-pool windows are required.
The helper refuses sample `_example_only` data, stale usage, and
unqualified candidates. Output is `stay_local`, `delegate`, or
`manual_review`. It **never launches a worker** and does not have a
verified live Orca quota API. Real routing must still respect current
Orca state and explicit approvals.

For the scoring implementation and configuration schema, inspect the
installed harness's `scripts/route_agent.py` and the example JSON files;
do not copy model benchmarks or implementation constants into project
guidance. Avoid storing account or quota details in the repository.
