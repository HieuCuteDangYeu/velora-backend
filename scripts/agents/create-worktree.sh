#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <agent> <issue-number> [base-branch]"
  exit 1
fi

AGENT="$1"
ISSUE="$2"
BASE="${3:-$(git remote show origin 2>/dev/null | sed -n '/HEAD branch/s/.*: //p')}"
BASE="${BASE:-main}"

ROOT="$(git rev-parse --show-toplevel)"
REPO="$(basename "$ROOT")"
BRANCH="agent/${AGENT}-${ISSUE}"
DIR="$(dirname "$ROOT")/${REPO}-${AGENT}-${ISSUE}"

git fetch origin "$BASE"
git worktree add "$DIR" -b "$BRANCH" "origin/$BASE"

echo
echo "Agent:    $AGENT"
echo "Issue:    $ISSUE"
echo "Branch:   $BRANCH"
echo "Worktree: $DIR"
