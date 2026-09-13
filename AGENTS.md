# Engineering Agent Contract

## Instruction priority

Apply instructions in this order:

1. Explicit user/task requirements
2. Repository `AGENTS.md`
3. More specific nested `AGENTS.md` files
4. Relevant Agent Skills
5. Existing repository conventions

Never override a higher-priority instruction with a lower-priority one.

## Context acquisition

Before implementation:

1. Understand the requested behavior.
2. For substantial work, use agentmemory recall when its MCP tools are available and historical context could matter.
3. Inspect the actual current execution path in the repository.
4. Locate relevant tests.
5. Search for an analogous existing implementation.
6. Determine the smallest safe change.
7. Identify assumptions that materially affect correctness.

Memory is advisory. Current code, tests, issue/PR requirements, and version-controlled project instructions are authoritative.

Do not implement solely from the issue description or a remembered summary when the repository can answer the question.

## Capability selection

- Use `skill-discovery` when a task would materially benefit from specialist external expertise (for example UI/UX, accessibility, security, testing, migration, or framework-specific workflows).
- Prefer a maintained trustworthy external skill over generating a weaker generic local duplicate.
- Use `repo-skill-bootstrap` for repository-specific architecture, invariants, and workflows.
- Do not load unrelated skills merely because the project uses that technology somewhere.

## Implementation

Prefer:

existing implementation → existing utility → platform/native functionality → installed dependency → smallest new implementation

Rules:

- Keep changes surgical.
- Do not perform unrelated refactors.
- Preserve existing architecture and conventions.
- Reuse existing abstractions before introducing new ones.
- Do not introduce dependencies without necessity.
- Preserve public interfaces unless the task explicitly changes them.
- Follow applicable repository skills.
- Follow Ponytail simplicity guidance when available.

## Safety and correctness

Simplicity must never remove required:

- authentication
- authorization
- trust-boundary validation
- transaction safety
- concurrency protection
- idempotency guarantees
- data-integrity checks
- error handling
- security controls
- accessibility requirements

Never put secrets into shared memory.

## Verification

Run the narrowest meaningful checks first.

Where applicable verify:

1. relevant tests
2. typecheck
3. lint
4. integration tests
5. broader repository tests only when necessary

Never claim a command succeeded unless it was actually executed successfully.

## Scope discipline

Do not fix unrelated problems discovered during the task. Report them separately when materially important.

## Durable learning

After a meaningful task is verified, use shared memory only when there is a concise lesson future agents are likely to reuse. Prefer recording the accepted decision/root cause/outcome, with a PR/issue/commit reference when available, rather than raw transcripts or logs.

If a repeated workflow becomes stable procedural knowledge, propose it through `skill-maintenance` instead of repeatedly storing copies in memory.

## Completion

Report:

1. implementation summary
2. files changed
3. verification commands
4. verification results
5. remaining risks or assumptions

Keep completion reports concise.
