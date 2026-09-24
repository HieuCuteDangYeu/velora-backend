#!/usr/bin/env bash
# extract_structure.sh — deterministic extraction, so the diagram isn't recalled.
# Usage: bash extract_structure.sh <mode> [path] [out_dir]
#   modes: classes | deps | routes | schema | all
# Writes artefacts to out_dir (default ./.diagram-extract) and prints what it made.
set -uo pipefail

MODE="${1:-all}"
TARGET="${2:-.}"
OUT="${3:-./.diagram-extract}"
mkdir -p "$OUT"

have() { command -v "$1" >/dev/null 2>&1; }
note() { printf '\n>>> %s\n' "$*"; }
skip() { printf '    (skip) %s\n' "$*"; }

cd "$TARGET" 2>/dev/null || { echo "no such path: $TARGET" >&2; exit 1; }
OUT="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/$(basename "$OUT")"
mkdir -p "$OUT"

# ---------- language detection ----------
LANGS=""
det() { [ -n "$(find . -name "$1" -not -path '*/node_modules/*' -not -path '*/.git/*' -print -quit 2>/dev/null)" ] && LANGS="$LANGS $2"; }
det "*.py"       python
det "*.ts"       ts
det "*.tsx"      ts
det "*.js"       js
det "go.mod"     go
det "pom.xml"    java
det "build.gradle*" java
det "*.java"     java
det "*.csproj"   dotnet
det "*.rb"       ruby
det "*.php"      php
det "Cargo.toml" rust
LANGS=$(printf '%s' "$LANGS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
echo "detected languages:$LANGS"
echo "output dir: $OUT"

is() { case " $LANGS " in *" $1 "*) return 0;; *) return 1;; esac; }

# ---------- classes ----------
do_classes() {
  note "CLASS STRUCTURE"
  if is python && have pyreverse; then
    (cd "$OUT" && pyreverse -o mmd -k -p Overview "$OLDPWD" >/dev/null 2>&1) \
      && echo "    pyreverse -> $OUT/classes_Overview.mmd (classes only)" \
      || skip "pyreverse failed; try: pyreverse -o mmd -k -p X <package-dir>"
    (cd "$OUT" && pyreverse -o mmd -p Detail "$OLDPWD" >/dev/null 2>&1) \
      && echo "    pyreverse -> $OUT/classes_Detail.mmd (with members)"
  elif is python; then
    skip "python found but pyreverse missing: pip install pylint"
  fi

  if is java; then
    echo "    Spring/JPA component map:"
    grep -rnE "@(RestController|Controller|Service|Repository|Component|Entity)" \
      --include='*.java' --include='*.kt' . 2>/dev/null | head -40 | tee "$OUT/java_components.txt" >/dev/null
    echo "    -> $OUT/java_components.txt"
  fi

  if is ts || is js; then
    echo "    TS/JS class + interface declarations:"
    grep -rnE "^[[:space:]]*(export[[:space:]]+)?(abstract[[:space:]]+)?(class|interface)[[:space:]]+[A-Z]" \
      --include='*.ts' --include='*.tsx' --include='*.js' \
      --exclude-dir=node_modules --exclude-dir=dist . 2>/dev/null \
      | head -80 | tee "$OUT/ts_types.txt" >/dev/null
    echo "    -> $OUT/ts_types.txt"
  fi
}

# ---------- deps ----------
do_deps() {
  note "MODULE / PACKAGE DEPENDENCIES"
  if (is ts || is js) && have npx; then
    npx --yes madge --circular --extensions ts,tsx,js,jsx . > "$OUT/madge_circular.txt" 2>/dev/null \
      && echo "    -> $OUT/madge_circular.txt  (CIRCULAR DEPS — read this first)"
    npx --yes madge --json --extensions ts,tsx,js,jsx . > "$OUT/madge_graph.json" 2>/dev/null \
      && echo "    -> $OUT/madge_graph.json"
  elif is ts || is js; then
    skip "JS/TS found but npx missing (install Node.js) — madge unavailable"
  fi

  if is python && have pyreverse; then
    (cd "$OUT" && pyreverse -o mmd -p Pkgs "$OLDPWD" >/dev/null 2>&1) \
      && echo "    -> $OUT/packages_Pkgs.mmd  (import structure, shows cycles)"
  fi

  if is go && have go; then
    go list -f '{{.ImportPath}} -> {{join .Imports " "}}' ./... > "$OUT/go_imports.txt" 2>/dev/null \
      && echo "    -> $OUT/go_imports.txt"
    go mod graph > "$OUT/go_modgraph.txt" 2>/dev/null && echo "    -> $OUT/go_modgraph.txt"
  fi

  if is java && have mvn; then
    mvn -q dependency:tree > "$OUT/mvn_tree.txt" 2>/dev/null \
      && echo "    -> $OUT/mvn_tree.txt"
  fi

  if is rust && have cargo; then
    cargo tree > "$OUT/cargo_tree.txt" 2>/dev/null && echo "    -> $OUT/cargo_tree.txt"
  fi
}

# ---------- routes ----------
do_routes() {
  note "ROUTES / ENTRYPOINTS"
  {
    grep -rnE "@(Get|Post|Put|Delete|Patch)Mapping|@RequestMapping" --include='*.java' --include='*.kt' . 2>/dev/null
    grep -rnE "(app|router|api)\.(get|post|put|delete|patch|use)\(" --include='*.ts' --include='*.js' --exclude-dir=node_modules . 2>/dev/null
    grep -rnE "@(app|router)\.(get|post|put|delete|patch)|@api_view|path\(|re_path\(" --include='*.py' . 2>/dev/null
    grep -rnE "HandleFunc|\.(GET|POST|PUT|DELETE|PATCH)\(" --include='*.go' . 2>/dev/null
    grep -rnE "MapGet|MapPost|\[Http(Get|Post|Put|Delete)\]|\[Route\(" --include='*.cs' . 2>/dev/null
    grep -rnE "Route::(get|post|put|delete|patch)" --include='*.php' . 2>/dev/null
  } | grep -vE 'node_modules|/dist/|/build/' | sort -u > "$OUT/routes.txt" 2>/dev/null

  N=$(wc -l < "$OUT/routes.txt" 2>/dev/null | tr -d ' ')
  echo "    -> $OUT/routes.txt  ($N entries)"

  for f in $(ls *.proto **/*.proto openapi*.y*ml swagger*.json schema.graphql 2>/dev/null | head -5); do
    echo "    contract file: $f  (read this — it IS the interface, already abstracted)"
  done
}

# ---------- schema ----------
do_schema() {
  note "DATA MODEL"
  if [ -f prisma/schema.prisma ]; then
    echo "    prisma/schema.prisma found — this IS the ER model, read it directly"
    cp prisma/schema.prisma "$OUT/schema.prisma" 2>/dev/null
  fi

  FOUND=$(find . -path '*/migrations/*' -name '*.sql' -o -name '*.sql' -not -path '*/node_modules/*' 2>/dev/null | head -20)
  if [ -n "$FOUND" ]; then
    echo "$FOUND" > "$OUT/sql_files.txt"
    echo "    -> $OUT/sql_files.txt  ($(echo "$FOUND" | wc -l | tr -d ' ') sql files)"
    grep -hnE "CREATE TABLE|FOREIGN KEY|REFERENCES|UNIQUE|NOT NULL" $FOUND 2>/dev/null \
      | head -200 > "$OUT/sql_constraints.txt"
    echo "    -> $OUT/sql_constraints.txt  (derive cardinality from these, not intuition)"
  fi

  {
    grep -rnE "@Entity|@Table|@OneToMany|@ManyToOne|@JoinColumn" --include='*.java' --include='*.kt' . 2>/dev/null
    grep -rnE "class .*\(models\.Model\)|ForeignKey\(|ManyToManyField\(|OneToOneField\(" --include='*.py' . 2>/dev/null
    grep -rnE "belongsTo|hasMany|hasOne|belongsToMany|@ManyToOne|@OneToMany" --include='*.ts' --include='*.js' --include='*.rb' --include='*.php' --exclude-dir=node_modules . 2>/dev/null
  } | head -120 > "$OUT/orm_relations.txt" 2>/dev/null
  [ -s "$OUT/orm_relations.txt" ] && echo "    -> $OUT/orm_relations.txt"

  if [ -n "${DATABASE_URL:-}" ] && have psql; then
    pg_dump --schema-only "$DATABASE_URL" > "$OUT/live_schema.sql" 2>/dev/null \
      && echo "    -> $OUT/live_schema.sql  (live DB — most authoritative source)"
  fi
}

case "$MODE" in
  classes) do_classes ;;
  deps)    do_deps ;;
  routes)  do_routes ;;
  schema)  do_schema ;;
  all)     do_classes; do_deps; do_routes; do_schema ;;
  *) echo "unknown mode: $MODE (classes|deps|routes|schema|all)" >&2; exit 2 ;;
esac

cat <<'EOF'

--- REMEMBER ---
Tool output is a skeleton, never the deliverable. Three passes before drawing:
  1. CUT    — drop tests, generated code, DTOs, framework base classes, utilities
  2. GROUP  — collapse to bounded contexts until within budget; name by responsibility
  3. LABEL  — tools give relation types but no intent; add protocol + purpose per edge
Record the exact command in the evidence table as `tool: <command>`.
EOF
