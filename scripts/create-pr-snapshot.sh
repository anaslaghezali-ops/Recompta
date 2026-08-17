#!/usr/bin/env bash
set -euo pipefail

# Create or update a snapshot branch at a merged PR's merge commit.
# Usage: ./scripts/create-pr-snapshot.sh <pr-number> <short-slug>
# Example: ./scripts/create-pr-snapshot.sh 128 import-achats

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <pr-number> <short-slug>" >&2
  echo "Example: $0 128 import-achats" >&2
  exit 1
fi

PR_NUM="$1"
SLUG="$2"
BRANCH="cursor/pr${PR_NUM}-${SLUG}-7cb5"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI required" >&2
  exit 1
fi

MERGE_SHA="$(gh pr view "$PR_NUM" --json mergeCommit,state -q 'if .state != "MERGED" then error("PR not merged") else .mergeCommit.oid end')"
TITLE="$(gh pr view "$PR_NUM" --json title -q .title)"

git fetch origin main
git branch -f "$BRANCH" "$MERGE_SHA"
git push -u origin "$BRANCH" --force-with-lease

echo "Snapshot branch: $BRANCH"
echo "Commit: $MERGE_SHA"
echo "PR #$PR_NUM — $TITLE"
