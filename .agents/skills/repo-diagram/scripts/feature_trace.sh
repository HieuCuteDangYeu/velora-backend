#!/usr/bin/env bash
# feature_trace.sh — turn a feature name into concrete code anchors.
# Usage: bash feature_trace.sh <keyword> [repo_root] [more keywords...]
#
# Prints grouped file:line hits so a diagram can be scoped to one feature
# without reading the whole repo.
set -uo pipefail

[ $# -ge 1 ] || { echo "usage: bash feature_trace.sh <keyword> [repo_root]" >&2; exit 2; }

KW="$1"; shift
ROOT="."
if [ $# -ge 1 ] && [ -d "$1" ]; then ROOT="$1"; shift; fi
EXTRA=("$@")

cd "$ROOT" || { echo "no such dir: $ROOT" >&2; exit 1; }

EXCLUDES='node_modules|\.git/|dist/|build/|out/|target/|vendor/|__pycache__|\.venv|/venv/|\.next/|\.nuxt/|coverage/|\.min\.|lock\.json|\.lock$'

have() { command -v "$1" >/dev/null 2>&1; }

# Build a case-insensitive alternation of the keyword and its naming variants.
variants() {
  local w="$1" lower snake kebab camel pascal
  lower=$(printf '%s' "$w" | tr 'A-Z' 'a-z')
  snake=$(printf '%s' "$lower" | tr ' -' '__')
  kebab=$(printf '%s' "$lower" | tr ' _' '--')
  camel=$(printf '%s' "$snake" | awk -F_ '{printf "%s", $1; for(i=2;i<=NF;i++) printf "%s%s", toupper(substr($i,1,1)), substr($i,2)}')
  pascal=$(printf '%s' "$camel" | awk '{printf "%s%s", toupper(substr($0,1,1)), substr($0,2)}')
  printf '%s\n%s\n%s\n%s\n%s\n' "$lower" "$snake" "$kebab" "$camel" "$pascal" | sort -u
}

PAT=$(for w in "$KW" "${EXTRA[@]+"${EXTRA[@]}"}"; do variants "$w"; done | sort -u | paste -sd'|' -)

if have rg; then
  S() { rg -n -i --no-heading -g '!.git' -g '!node_modules' "$1" 2>/dev/null | grep -vE "$EXCLUDES"; }
else
  S() { grep -rniE "$1" . 2>/dev/null | sed 's|^\./||' | grep -vE "$EXCLUDES"; }
fi

hr() { printf '\n--- %s ---\n' "$1"; }
cap() { head -"${1:-15}"; }

echo "FEATURE TRACE: $KW ${EXTRA[*]+(+ ${EXTRA[*]})}"
echo "pattern: $PAT"
echo "root:    $(pwd)"

hr "FILES whose NAME matches (strongest signal)"
if have rg; then
  rg --files -g '!.git' 2>/dev/null | grep -iE "$PAT" | grep -vE "$EXCLUDES" | cap 30
else
  find . -type f 2>/dev/null | sed 's|^\./||' | grep -iE "$PAT" | grep -vE "$EXCLUDES" | cap 30
fi

hr "HTTP ROUTES / ENDPOINTS"
S "($PAT)" | grep -iE '@(Get|Post|Put|Delete|Patch)Mapping|@(app|router|api)\.(get|post|put|delete|patch)|(app|router|api)\.(get|post|put|delete|patch)\(|HandleFunc|MapGet|MapPost|@Route|path=|url\(' | cap 20

hr "TYPE / CLASS / FUNCTION DEFINITIONS"
S "(class|interface|type|struct|enum|func|def|fn)[[:space:]]+[A-Za-z_]*($PAT)" | cap 25

hr "SERVICE / HANDLER / CONTROLLER / REPOSITORY"
S "($PAT)" | grep -iE 'service|handler|controller|repository|usecase|interactor|manager|provider' | cap 25

hr "DATA MODEL (tables, entities, migrations)"
S "($PAT)" | grep -iE 'CREATE TABLE|@Entity|@Table|models\.Model|db\.Model|Schema\(|migration|belongsTo|hasMany|ForeignKey|references' | cap 25

hr "EVENTS / MESSAGES / JOBS (async boundaries — critical for sequence diagrams)"
S "($PAT)" | grep -iE 'publish|emit|dispatch|subscribe|consume|listener|@Async|@Scheduled|cron|queue|topic|kafka|rabbit|sqs|celery|sidekiq|worker|job' | cap 25

hr "PERMISSIONS / ROLES (actors, for use case diagrams)"
S "($PAT)" | grep -iE 'role|permission|policy|ability|@PreAuthorize|guard|can\(|authorize|scope' | cap 15

hr "CONFIG / FEATURE FLAGS"
S "($PAT)" | grep -iE '\.env|config|settings|flag|toggle|\.ya?ml:|\.json:|\.toml:' | cap 15

hr "TESTS (often the clearest spec of the flow)"
S "($PAT)" | grep -iE 'test|spec|__tests__|_test\.' | cap 15

hr "ALL OTHER HITS (count by file)"
S "($PAT)" | cut -d: -f1 | sort | uniq -c | sort -rn | cap 25

cat <<'EOF'

--- NEXT ---
1. Pick the entrypoint from ROUTES (or the job/listener for async features).
2. Read only the handler body, then follow named symbols with `rg -n`.
3. Stop at network calls, DB calls, queue publishes and unresolvable dispatch —
   record each as one edge, do not trace past it.
4. If this returned little, the feature is named differently in code than in the
   product. Ask the user for one anchor: an endpoint, a table, or a class name.
EOF
