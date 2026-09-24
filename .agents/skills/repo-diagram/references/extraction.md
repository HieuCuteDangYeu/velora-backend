# Deterministic extraction

Reading code and recalling it invents edges. A parser does not. Always check this
file before hand-reading, and record the command in the evidence column as
`tool: <command>`.

## Contents
- [What tools can and cannot give you](#what-tools-can-and-cannot-give-you)
- [Python](#python)
- [JavaScript / TypeScript](#javascript--typescript)
- [Go](#go)
- [Java / Kotlin](#java--kotlin)
- [C# / .NET](#c--net)
- [PHP, Ruby, Rust](#php-ruby-rust)
- [Database schema](#database-schema)
- [Service contracts](#service-contracts)
- [Runtime topology](#runtime-topology)
- [After extraction: curate](#after-extraction-curate)

## What tools can and cannot give you

| Relation | Tool can extract | Notes |
|---|---|---|
| Class hierarchy, fields, methods | yes | reliable; the best reason to use a tool |
| Module/package import graph | yes | reliable; reveals cycles |
| DB schema, FKs, cardinality | yes | from migrations or a live DB |
| HTTP routes | mostly | decorator/registry styles parse well; dynamic mounting does not |
| Call graph | partly | static call graphs miss interfaces, DI, reflection |
| Runtime sequence | no | needs reading, or tracing/OpenTelemetry |
| Event publisher→consumer wiring | no | resolve by message name: `rg -n "OrderCreated"` |
| Intent, responsibility, boundaries | no | this is the part you are paid for |

So: tools give you the skeleton; you supply abstraction, grouping and meaning. Never
paste raw tool output as the final diagram — it is always over budget and
under-abstracted.

## Python

```bash
pip install pylint            # ships pyreverse
# Mermaid straight out:
pyreverse -o mmd -p Orders src/orders/
# Classes only, no members — ideal for a readable overview:
pyreverse -o mmd -k -p Orders src/orders/
# PlantUML / Graphviz variants:
pyreverse -o puml -p Orders src/
pyreverse -o dot  -p Orders src/ && dot -Tsvg classes_Orders.dot -o classes.svg
```

Useful flags: `-k` classes only · `-f ALL` include private members · `-a1 -s1` limit
ancestor/association depth · `-m n` hide module prefix · `--colorized`.

It produces two artefacts: `classes_<name>` (hierarchy) and `packages_<name>`
(import structure — the fastest way to spot circular imports).

Other Python options: `pydeps` for module graphs, `code2flow` for call graphs,
`sqlalchemy schema` reflection or `alembic` migrations for the data model,
`django-extensions`' `graph_models` for Django ORM.

## JavaScript / TypeScript

```bash
# module dependency graph + circular dependency detection
npx madge --circular --extensions ts,tsx,js,jsx src/
npx madge --image graph.svg src/

# richer: rules, orphans, dot output
npx dependency-cruiser --output-type dot src | dot -Tsvg > deps.svg
npx dependency-cruiser --output-type err src        # violations only

# TypeScript class/interface structure
npx tsuml2 -g "./src/**/*.ts" -o classes.svg        # if installed
```

For NestJS, decorators give you the component graph directly:
`rg -n "@Injectable|@Controller|@Module" src/`. For React, the component tree comes
from imports plus JSX usage, not from madge alone.

Prisma: `npx prisma generate` then read `schema.prisma` — it *is* the ER diagram,
already typed, with relations explicit. Never hand-derive an ERD when a
`schema.prisma` exists.

## Go

```bash
go list -deps ./...                       # dependency closure
go list -f '{{.ImportPath}} {{.Imports}}' ./...
go mod graph                              # module-level
go-callvis -group pkg -focus ./cmd/api .  # call graph, if installed
```

Interfaces are where static analysis loses the thread in Go. When an edge crosses an
interface, find the implementations by method set:
`rg -n "func \(\w+ \*?\w+\) MethodName\("`.

## Java / Kotlin

```bash
jdeps -verbose:class -filter:none build/libs/app.jar   # class-level deps
jdeps -s app.jar                                        # summary
mvn dependency:tree
./gradlew dependencies
```

Spring annotations are a reliable component map:
`rg -n "@RestController|@Service|@Repository|@Component|@Configuration"`.
Request flows: `@GetMapping|@PostMapping|@RequestMapping`.
JPA gives the data model: `@Entity|@Table|@OneToMany|@ManyToOne|@JoinColumn`.

## C# / .NET

```bash
dotnet list package --include-transitive
dotnet build /t:GenerateRestorePackageIdentity   # project graph
```

EF Core is the shortest path to an accurate ERD:

```bash
dotnet ef dbcontext info
dotnet ef migrations script          # SQL — read FKs from here
```

Routes: `rg -n "MapGet|MapPost|\[HttpGet\]|\[HttpPost\]|\[Route\("`.

## PHP, Ruby, Rust

- PHP: `composer show --tree`; Laravel routes with `php artisan route:list`;
  Eloquent relations via `rg -n "hasMany|belongsTo|belongsToMany"`.
- Ruby: `bundle exec rails routes`; `rails-erd` for the data model; ActiveRecord
  relations via `rg -n "has_many|belongs_to|has_one"`.
- Rust: `cargo tree`; `cargo modules structure`; `cargo-depgraph` for crate graphs.

## Database schema

Best source, in order: a live DB, then migrations, then ORM models. Never guess.

```bash
# PostgreSQL — real constraints, real cardinality
psql "$DATABASE_URL" -c "\d+ orders"
pg_dump --schema-only "$DATABASE_URL" > schema.sql

# MySQL
mysqldump --no-data -u user -p dbname > schema.sql

# from migrations
rg -n "CREATE TABLE|ALTER TABLE|REFERENCES|FOREIGN KEY" db/migrations/
```

Derive cardinality from constraints, not intuition: FK `NOT NULL` → `||` on that
side; nullable FK → `|o`; unique index on the FK → one-to-one; a table with exactly
two FKs and no other meaningful columns → a join table, and you draw it as an entity
rather than hiding it.

## Service contracts

If `.proto`, `openapi.yaml` or `schema.graphql` exists, read it first. It is the
interface contract, already abstracted at exactly the level a Container or Component
diagram needs — better than anything you can reconstruct from handlers.

```bash
rg --files -g '*.proto' -g 'openapi*' -g 'swagger*' -g '*.graphql'
```

## Runtime topology

For Container and Deployment diagrams, these beat source code:

```bash
cat docker-compose*.yml .env.example 2>/dev/null
ls k8s/ helm/ terraform/ .github/workflows/ 2>/dev/null
rg -n "image:|ports:|replicas:|env:" k8s/ docker-compose*.yml
```

`.env.example` and `docker-compose.yml` are usually the highest-signal files in the
whole repo for "what external systems exist" — they name the databases, brokers,
caches and third-party APIs explicitly.

Map library → external system: `pg`/`psycopg`/`pgx` → PostgreSQL · `ioredis`/`go-redis`
→ Redis · `kafkajs`/`sarama`/`confluent` → Kafka · `amqplib`/`pika` → RabbitMQ ·
`@aws-sdk/*` → S3/SQS/etc · `stripe` → Stripe · `@elastic/elasticsearch` →
Elasticsearch.

## After extraction: curate

Raw tool output is never the deliverable. Three passes:

1. **Cut.** Remove test doubles, generated code, DTOs, framework base classes,
   utilities. Keep what answers the question.
2. **Group.** Collapse to bounded contexts or packages until within budget. Name each
   group by responsibility.
3. **Label.** Tools give relation types but no intent. Add protocol and purpose to
   every edge — that's what makes the diagram useful.

Record in the spec which elements came from a tool and which from reading. When a
reviewer disagrees with a tool-derived edge, they can rerun the command; when they
disagree with a read-derived edge, they need the line number. Both need to be in the
evidence table.
