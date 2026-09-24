#!/usr/bin/env bash
# repo_map.sh — one-shot recon of a codebase, sized for an LLM context window.
# Usage: bash repo_map.sh [repo_root]
set -uo pipefail

ROOT="${1:-.}"
cd "$ROOT" || { echo "no such dir: $ROOT" >&2; exit 1; }

EXCLUDES='node_modules|\.git|dist|build|out|target|vendor|__pycache__|\.venv|venv|\.next|\.nuxt|coverage|\.idea|\.gradle|bin/Debug|obj/'

have() { command -v "$1" >/dev/null 2>&1; }

if have rg; then
  FILES() { rg --files --hidden -g '!.git' 2>/dev/null | grep -vE "$EXCLUDES"; }
  SEARCH() { rg -n --no-heading -g '!.git' "$@" 2>/dev/null | grep -vE "$EXCLUDES"; }
else
  FILES() { find . -type f -not -path '*/.git/*' 2>/dev/null | sed 's|^\./||' | grep -vE "$EXCLUDES"; }
  SEARCH() { grep -rnE "$@" . 2>/dev/null | grep -vE "$EXCLUDES"; }
fi

hr() { printf '\n=== %s ===\n' "$1"; }

hr "REPO"
echo "path: $(pwd)"
have git && git rev-parse --short HEAD 2>/dev/null | sed 's/^/commit: /'
have git && git log -1 --format='last commit: %ad (%an)' --date=short 2>/dev/null

hr "LANGUAGES (by file count)"
FILES | sed -n 's/.*\.\([A-Za-z0-9]\{1,6\}\)$/\1/p' | tr 'A-Z' 'a-z' \
  | grep -E '^(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|cs|rs|scala|swift|c|cc|cpp|h|hpp|sql|proto|graphql|vue|svelte|sh|yaml|yml|tf|dockerfile)$' \
  | sort | uniq -c | sort -rn | head -20

hr "TOP-LEVEL LAYOUT (depth 3)"
FILES | awk -F/ 'NF>1{ d=$1; for(i=2;i<NF && i<=3;i++) d=d"/"$i; print d }' \
  | sort | uniq -c | sort -rn | head -40

hr "MANIFESTS & INFRA"
for f in package.json pnpm-workspace.yaml turbo.json nx.json lerna.json \
         go.mod pom.xml build.gradle build.gradle.kts settings.gradle \
         requirements.txt pyproject.toml Pipfile Gemfile Cargo.toml \
         composer.json Makefile Procfile \
         Dockerfile docker-compose.yml docker-compose.yaml \
         .env.example .env.sample README.md ARCHITECTURE.md; do
  [ -f "$f" ] && echo "  [x] $f"
done
for d in k8s kubernetes helm charts terraform infra deploy .github/workflows docs adr docs/adr; do
  [ -d "$d" ] && echo "  [d] $d/  ($(ls -1 "$d" 2>/dev/null | wc -l | tr -d ' ') entries)"
done

hr ".env.example / compose (external dependencies — high signal)"
for f in .env.example .env.sample docker-compose.yml docker-compose.yaml; do
  [ -f "$f" ] && { echo "--- $f"; head -60 "$f"; }
done

hr "ENTRYPOINTS"
SEARCH 'func main\(|if __name__ == .__main__.|public static void main|fn main\(|^\s*app\.listen\(|createServer\(|uvicorn\.run|ASGI|WSGI' | head -25

hr "HTTP ROUTES / CONTROLLERS"
SEARCH '@(Get|Post|Put|Delete|Patch)Mapping|@(RestController|Controller)\b|@(app|router|api)\.(get|post|put|delete|patch)|app\.(get|post|put|delete|use)\(|router\.(HandleFunc|Handle|Get|Post)\(|MapGet\(|MapPost\(|路由' | head -40

hr "MESSAGING / ASYNC / JOBS"
SEARCH '@KafkaListener|@RabbitListener|@EventListener|@Async|@Scheduled|kafkajs|sarama|amqplib|pika|celery|sidekiq|BullMQ|new Worker\(|\.subscribe\(|\.publish\(|go func\(|cron' | head -30

hr "DATA MODEL (schemas / migrations / entities)"
FILES | grep -iE 'migration|schema|\.sql$|models?/|entities/|entity\.' | head -40
SEARCH 'CREATE TABLE|@Entity|@Table\(|class .*\(models\.Model\)|db\.Model|Schema\(\{|prisma' | head -20

hr "SERVICE CONTRACTS (proto / graphql / openapi)"
FILES | grep -iE '\.proto$|\.graphql$|openapi|swagger' | head -25

hr "LARGEST SOURCE FILES (god-object candidates)"
FILES | grep -E '\.(ts|tsx|js|jsx|py|go|java|kt|rb|php|cs|rs|scala|swift|cpp|c)$' \
  | tr '\n' '\0' | xargs -0 wc -l 2>/dev/null | grep -vE '[[:space:]]total$' | sort -rn | head -20

hr "NEXT"
cat <<'EOF'
Read in this order, not depth-first:
  1. README / ARCHITECTURE / ADRs  (context; verify against code, may be stale)
  2. manifests + .env.example + compose/k8s  (external systems, containers)
  3. the contract files (.proto / openapi / graphql) if any
  4. entrypoints + route tables listed above
  5. only then: targeted reads around the symbols your diagram needs
EOF
