---
name: diagram-doctor
description: Diagnose renderer capabilities and extraction tooling for Repo Diagrammer.
---

# Diagram Doctor

1. Run `../repo-diagram/scripts/check_deps.sh`.
2. Detect repo languages/shape.
3. Report Mermaid version when local, browser status, PlantUML and Graphviz.
4. State whether native Mermaid use-case (>=12) and swimlane (>=11.16) are eligible.
5. Read `renderer-strategy.md` and identify preferred vs fallback renderer coverage
   for diagram types relevant to this repo.
6. Recommend only extraction tools relevant to detected languages.
7. Do not install dependencies unless explicitly asked.
