#!/bin/bash
# ship-fix.sh — open a REVIEWABLE DRAFT PR for an investigated production fix.
#
# Replaces the old "push straight to main (Render auto-deploys)" step in the
# /investigate-errors flow. The fix is NOT deployed until a human reviews and
# merges the draft PR. This script never merges and never pushes to `main`.
#
# Usage:
#   scripts/ship-fix.sh --incident <id> --summary "<one-line>" \
#       [--slug <slug>] [--body-file <path>]
#
# It operates on ALREADY-STAGED changes — the caller stages the fix files first
# (by explicit path, never `git add .`). This script refuses to run if nothing
# is staged. That refusal is the guard that replaces `git add .`.
#
# Behavior:
#   1. Preflight `gh auth status`. If gh is missing/unauthed → FALLBACK MODE:
#      still branch + commit + push, print the compare URL + a manual-open note,
#      post the Slack line, exit 0 (never hard-fail).
#   2. Always creates/switches to a feature branch before committing. Never
#      commits onto `main`.
#   3. Follow-up mode: if an open PR already exists for this incident, push the
#      staged changes as a new commit onto that PR's branch — no second PR.
#   4. Opens a DRAFT PR against `main`. Never merges (no `gh pr merge`).
#
# Source: https://github.com/purmemo-ai/purmemo-mcp/blob/main/scripts/ship-fix.sh

set -euo pipefail

REPO_SLUG="purmemo-ai/purmemo-mcp"
BASE_BRANCH="main"
SLACK_PUSH="$HOME/.claude/bin/slack-push.sh"

# --- redact known credential shapes from anything we echo back (lifted from
# --- superlog redactGitSecrets). Defense-in-depth: we avoid echoing raw remote
# --- output, but scrub what we must surface.
redact() {
  sed -E \
    -e 's/gh([opsu])_[A-Za-z0-9]{20,}/gh\1_***/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/github_pat_***/g' \
    -e 's/x-access-token:[^@[:space:]/"]+/x-access-token:***/gI'
}

die() { echo "❌ ship-fix: $*" >&2; exit 1; }

# --- parse args ---
INCIDENT=""
SUMMARY=""
SLUG=""
BODY_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --incident)  INCIDENT="${2:-}"; shift 2 ;;
    --summary)   SUMMARY="${2:-}"; shift 2 ;;
    --slug)      SLUG="${2:-}"; shift 2 ;;
    --body-file) BODY_FILE="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$INCIDENT" ]] || die "--incident <id> is required"
[[ -n "$SUMMARY" ]]  || die "--summary \"<one-line>\" is required"
if [[ -n "$BODY_FILE" && ! -f "$BODY_FILE" ]]; then
  die "--body-file not found: $BODY_FILE"
fi

# --- run from repo root, safe from anywhere ---
REPO_ROOT="$(git rev-parse --show-toplevel)" || die "not inside a git repository"
cd "$REPO_ROOT"

# --- refuse if nothing is staged (this replaces `git add .`) ---
if git diff --cached --quiet; then
  die "no staged changes — stage the fix files by explicit path first (never 'git add .')"
fi

# --- slugify ---
slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-40 \
    | sed -E 's/-+$//'
}
if [[ -z "$SLUG" ]]; then
  SLUG="$(slugify "$SUMMARY")"
fi
[[ -n "$SLUG" ]] || SLUG="fix"

# --- retry-branch naming on collision (lifted from superlog formatRetryBranchName) ---
retry_branch_name() {
  local base="$1"
  local seed
  seed="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)"
  [[ -n "$seed" ]] || seed="$(date +%s | tail -c 8)"
  printf '%s-retry-%s' "$base" "$seed"
}

BRANCH="fix/incident-${INCIDENT}-${SLUG}"

PR_TITLE="fix: ${SUMMARY} [incident ${INCIDENT}]"
COMMIT_MSG="fix: ${SUMMARY} [incident ${INCIDENT}] [AI-Investigated]"

# --- detect gh availability (drives fallback mode) ---
GH_OK=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GH_OK=1
fi

slack() {
  [[ -x "$SLACK_PUSH" ]] || return 0
  "$SLACK_PUSH" audit "$1" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# FOLLOW-UP MODE: an open PR for this incident already exists → push onto it,
# do NOT open a second PR. (Lifted from superlog pr-delivery follow-up logic.)
# ---------------------------------------------------------------------------
if [[ "$GH_OK" -eq 1 ]]; then
  EXISTING_JSON="$(gh pr list --state open --search "incident-${INCIDENT}" \
      --json number,headRefName,url,isDraft 2>/dev/null || echo '[]')"
  # Also match branches by the incident prefix, in case the search misses.
  EXISTING_NUM="$(printf '%s' "$EXISTING_JSON" \
    | grep -oE '"number":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
  EXISTING_HEAD="$(printf '%s' "$EXISTING_JSON" \
    | grep -oE "\"headRefName\":\"[^\"]*\"" | head -1 | sed -E 's/.*:"([^"]*)"/\1/' || true)"
  EXISTING_URL="$(printf '%s' "$EXISTING_JSON" \
    | grep -oE '"url":"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)"/\1/' || true)"

  # Fallback match by branch prefix if search returned nothing.
  if [[ -z "$EXISTING_NUM" ]]; then
    PREFIX_JSON="$(gh pr list --state open \
        --json number,headRefName,url --limit 100 2>/dev/null || echo '[]')"
    EXISTING_HEAD="$(printf '%s' "$PREFIX_JSON" \
      | grep -oE "\"headRefName\":\"fix/incident-${INCIDENT}-[^\"]*\"" \
      | head -1 | sed -E 's/.*:"([^"]*)"/\1/' || true)"
    if [[ -n "$EXISTING_HEAD" ]]; then
      EXISTING_NUM="$(gh pr list --state open --head "$EXISTING_HEAD" \
          --json number --jq '.[0].number' 2>/dev/null || true)"
      EXISTING_URL="$(gh pr list --state open --head "$EXISTING_HEAD" \
          --json url --jq '.[0].url' 2>/dev/null || true)"
    fi
  fi

  if [[ -n "${EXISTING_NUM:-}" && -n "${EXISTING_HEAD:-}" ]]; then
    echo "→ Open PR #${EXISTING_NUM} already exists for incident ${INCIDENT} — follow-up mode."
    # Stash the staged fix as a patch so we can carry it onto the PR branch.
    PATCH="$(mktemp)"
    trap 'rm -f "$PATCH"' EXIT
    git diff --cached >"$PATCH"

    git fetch origin "$EXISTING_HEAD" >/dev/null 2>&1 || true
    git checkout -B "$EXISTING_HEAD" "origin/${EXISTING_HEAD}" 2>/dev/null \
      || git checkout "$EXISTING_HEAD"
    git apply --index "$PATCH"
    git commit -m "$COMMIT_MSG" >/dev/null
    git push origin "HEAD:refs/heads/${EXISTING_HEAD}" 2>&1 | redact
    echo "✓ Pushed follow-up commit to existing PR: ${EXISTING_URL}"
    slack "📌 Follow-up commit pushed to draft PR for incident ${INCIDENT}: ${EXISTING_URL}"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# NEW INCIDENT: create the feature branch (with collision retry), commit, push.
# ---------------------------------------------------------------------------
# Collision check against origin — append -retry-<random8> if the branch exists.
attempt=0
while git ls-remote --exit-code origin "refs/heads/${BRANCH}" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [[ "$attempt" -le 2 ]] || die "branch name kept colliding on origin: ${BRANCH}"
  BRANCH="$(retry_branch_name "fix/incident-${INCIDENT}-${SLUG}")"
done

# Always switch to the feature branch before committing — never commit onto main.
git checkout -b "$BRANCH"
git commit -m "$COMMIT_MSG" >/dev/null

# Push the branch (redact any surfaced remote output).
git push -u origin "HEAD:refs/heads/${BRANCH}" 2>&1 | redact

COMPARE_URL="https://github.com/${REPO_SLUG}/compare/${BASE_BRANCH}...${BRANCH}?expand=1"

# --- FALLBACK MODE: gh unavailable → print the manual PR-create URL, exit 0 ---
if [[ "$GH_OK" -ne 1 ]]; then
  echo ""
  echo "⚠️  gh unavailable — open the PR manually at the URL above"
  echo "    ${COMPARE_URL}"
  slack "📌 Fix branch pushed for incident ${INCIDENT} (gh unavailable — open PR manually): ${COMPARE_URL}"
  exit 0
fi

# --- build the PR body ---
BODY_TMP="$(mktemp)"
trap 'rm -f "$BODY_TMP"' EXIT
if [[ -n "$BODY_FILE" ]]; then
  cat "$BODY_FILE" >"$BODY_TMP"
else
  cat >"$BODY_TMP" <<EOF
## Incident
Admin panel / error hub incident ${INCIDENT}
## Root cause
TODO — fill from investigation
## Fix
${SUMMARY}
## Test evidence
TODO
## Rollback
Revert this PR / redeploy previous main commit.
---
🤖 Opened by ship-fix.sh — DRAFT, awaiting human review. Do not auto-merge.
EOF
fi

# --- open the DRAFT PR (never merged) ---
PR_URL="$(gh pr create --draft --base "$BASE_BRANCH" --head "$BRANCH" \
    --title "$PR_TITLE" --body-file "$BODY_TMP" 2>&1 | redact | tail -1)"

echo "✓ Draft PR opened: ${PR_URL}"
slack "📌 Draft PR opened for incident ${INCIDENT}: ${PR_URL}"
