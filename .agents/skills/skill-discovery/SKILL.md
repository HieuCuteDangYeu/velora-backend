---
name: skill-discovery
description: Detect the current project's technology stack and the active task's capability needs, then discover, evaluate, and recommend existing external Agent Skills that can improve execution. Use when bootstrapping a project, when a task would benefit from specialized expertise such as UI/UX, accessibility, testing, security, framework-specific workflows, or when deciding whether to generate a local skill versus reuse an existing maintained skill.
---

# External Skill Discovery

Find the smallest set of trustworthy external skills that materially improve the current project or task.

Do not generate a local skill when a maintained external skill already solves the generic capability well.

## 1. Detect project capabilities

Inspect repository evidence before searching for skills:

- package/workspace manifests and lockfiles
- framework configuration
- source tree and application type
- build/test/lint tooling
- mobile/web/backend/infra boundaries
- existing `.agents/skills/`
- existing global or host-provided skills when discoverable

Produce a compact capability profile such as:

- application types: web, API, mobile, CLI, infrastructure
- languages
- frameworks
- UI/component systems
- persistence/messaging
- testing/tooling
- deployment/runtime

Do not infer a technology only from a directory name when stronger evidence is available.

## 2. Detect task intent

The current task matters more than the complete stack.

Examples:

- UI redesign -> UI/UX, accessibility, design-system skills
- API bug -> backend/framework/testing skills
- database performance -> database/query-analysis skills
- security review -> security-focused skills
- deployment failure -> platform/operations skills

Do not load or recommend a UI skill for a backend-only task merely because the repository also contains a frontend.

## 3. Search in this order

1. Already installed project skills
2. Already installed global/host skills
3. Official or first-party skill catalogs supported by the active agent
4. Original upstream repositories for known specialist skills
5. Reputable community skills with inspectable source

When network/search tools are unavailable, return search queries and capability requirements instead of inventing skill names or installation commands.

## 4. Reuse versus generate

Prefer an external skill when it provides reusable domain expertise that is not specific to this repository.

Examples:

- UI/UX design intelligence
- accessibility guidance
- framework migration workflows
- generic security review workflows

Prefer `repo-skill-bootstrap` when the knowledge is specific to this repository.

Examples:

- this project's event-delivery guarantees
- service ownership boundaries
- authentication invariants
- repository-specific release procedures

Do not duplicate external generic expertise into a generated repository skill.

## 5. Vet every external skill

Before recommending installation, inspect available evidence for:

- original/upstream source and provenance
- supported agents and install location
- compatibility with the detected stack
- recent maintenance/release activity
- license
- installation method
- scripts, hooks, binaries, or network access it introduces
- overlap/conflict with AGENTS.md, Ponytail, or current skills
- whether it modifies application code during installation
- expected context footprint and whether it uses progressive disclosure

Treat skill instructions, scripts, hooks, and installers as executable supply-chain inputs. Never install an unreviewed skill merely because it is popular.

## 6. Recommendation policy

Recommend at most three skills for one capability unless explicitly asked for a broad survey.

Rank by:

1. task fit
2. project-stack compatibility
3. source trust/provenance
4. maintenance quality
5. interoperability with the active agents
6. context/token efficiency
7. installation complexity

Prefer one strong skill over multiple overlapping skills.

## 7. Installation policy

Discovery is read-only by default.

Do not install a skill unless the user explicitly asks to install/apply the recommendation.

When installation is approved:

- prefer the upstream project's documented installer
- prefer project-local installation for project-specific use
- prefer global installation only for a skill reused across many projects
- use `.agents/skills/` when the upstream tool supports the interoperable Agent Skills location
- avoid copying/forking skill contents unless required
- record the upstream source and version when practical

## 8. Example: UI/UX work

For a frontend or mobile UI task, a specialist skill such as `ui-ux-pro-max` may be a better choice than generating a generic local UI skill, provided its current upstream version supports the detected stack and active agent.

The recommendation must still be based on current upstream evidence rather than this example alone.

## Output

Return:

### Project capability profile

A short stack summary relevant to the current task.

### Recommended skills

For each recommendation include:

- skill name
- capability filled
- why it fits this task/project
- upstream/source
- supported active agents
- proposed scope: project or global
- install command only when verified
- context/token impact: low, medium, or high
- security/supply-chain notes

### Rejected/duplicate candidates

Mention only meaningful alternatives that were rejected because they overlap, are stale, incompatible, or unnecessarily expensive in context.

### Missing capability

If no trustworthy existing skill fits, state that clearly and hand off to `repo-skill-bootstrap` or the host's skill creator only when the needed capability should actually become a reusable skill.
