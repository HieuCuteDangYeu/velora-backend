# Diagram quality profiles

After selecting a type, read its profile **before** writing renderer source. The same
profile is used during review.

| Type | Profile |
|---|---|
| C4 landscape/context/container/component/dynamic | architecture.md |
| sequence | sequence.md |
| class | class.md |
| ER | er.md |
| state | state.md |
| dataflow | dataflow.md |
| deployment | deployment.md |
| call graph | callgraph.md |
| use case | usecase.md |
| flowchart / swimlane | flowchart.md |

A profile has two gates:
1. semantic contract — whether the diagram says the right thing;
2. presentation contract — whether a professional reader can understand it quickly.

Violating either can be Blocking.
