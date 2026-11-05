---
name: project-learning
description: Maintain verified project-specific knowledge and reusable skills after significant bug fixes, accepted architecture decisions, recurring failures, or an explicit memory/skills improvement request. Skip routine edits.
---

# Project learning

Use this workflow only when the completed task reveals a **durable, non-obvious
project-specific lesson**. Do not load it for every task.

## Evidence first

1. Inspect the current repository, tests, and existing project skills.
2. Require an accepted decision, reproduced root cause, or successful
   verification. Identify the relevant files/tests and commit, issue, or PR
   where available. Avoid guessing from unverified agent output.
3. Check existing relevant Orca/agent skills and past agentmemory entries
   when available; avoid duplicate or contradictory knowledge. Current
   code/tests and explicit user requirements override stored memory.

## Reuse integrations

- **Orca** owns worktrees, tasks, agent supervision, and installed skill
  updates. Load its live `orca-cli` or `orchestration` skill as needed;
  never duplicate its CLI reference or generic skill-discovery workflow.
- **Ponytail**, if installed, owns its own minimal-change/review guidance.
  Never copy or paraphrase the plugin's rules into a generated project skill.
- **agentmemory**, if connected, owns cross-session storage and retrieval.
  Use its supported tools to store **one concise, verified lesson**, scoped
  to this project, with the decision, reason, outcome, and evidence pointer.
  Do not claim to have saved memory if no write succeeded. Lifecycle hooks
  may capture sessions automatically, but raw capture is not trusted
  architectural knowledge. Do not register duplicate capture hooks.

## Promote to a project skill only when justified

Prefer an existing test, code comment, or project skill over creating another
file. Promote a lesson into `.agents/skills/<topic>/SKILL.md` only if it
will change future engineering decisions and cannot be reliably inferred
from nearby code/tests. Update an existing matching skill rather than
creating an overlapping one. Use valid Agent Skills YAML frontmatter
(`name`, `description`) and a short, concrete workflow, evidence,
and verification guidance.

When an eligible, well-verified lesson is discovered during authorized
project work, include the project-owned skill update in the same
reviewable diff and report it in the completion summary. Do not silently
commit, push, or merge. Preserve customized skills and never edit
third-party managed skill files. For harness-wide behavior, propose a
change to the **boilerplate's** template instead of rewriting every
project's managed copies.

## Do not store

Secrets, tokens, personal information, raw transcripts, unverified claims,
generic language/framework tutorials, ephemeral troubleshooting output,
or content that an installed upstream skill already maintains.

If nothing durable was learned, create no memory or skill and report
nothing extra.
