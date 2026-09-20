#!/usr/bin/env bash
# Publishes this folder as a new GitHub repository and applies professional defaults:
# squash-only merges, secret scanning, Dependabot, private vulnerability reporting,
# Actions permissions for release-please, and branch protection on main.
#
# Usage:   ./scripts/publish.sh
# Options (environment variables):
#   REPO_NAME=sheaf   repository name
#   OWNER=<user-or-org>         defaults to the account you are logged in as with `gh`
#   VISIBILITY=public|private   default: public
#   SKIP_CHECKS=1               skip the local lint/typecheck/test/build gate
#   PROTECT_MAIN=0              do not configure branch protection
set -euo pipefail

REPO_NAME="${REPO_NAME:-sheaf}"
VISIBILITY="${VISIBILITY:-public}"
PROTECT_MAIN="${PROTECT_MAIN:-1}"
DESCRIPTION="Your Notion, out of Notion — portable, versioned backups of a Notion workspace (Markdown, CSV, JSON, Git)."

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }
try()  { "$@" >/dev/null 2>&1 || warn "non-fatal: could not run: $*"; }

cd "$(dirname "$0")/.."

for bin in git gh node npm perl; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is required but not installed"
done
[[ "$VISIBILITY" == "public" || "$VISIBILITY" == "private" ]] || die "VISIBILITY must be public or private"

gh auth status >/dev/null 2>&1 || die "Not logged in to GitHub. Run: gh auth login   (then: gh auth refresh -s workflow)"
git config user.name  >/dev/null || die "Set your git identity first: git config --global user.name \"Your Name\""
git config user.email >/dev/null || die "Set your git identity first: git config --global user.email you@example.com"

USER_LOGIN="$(gh api user --jq .login)"
OWNER="${OWNER:-$USER_LOGIN}"
SLUG="$OWNER/$REPO_NAME"

if gh repo view "$SLUG" >/dev/null 2>&1; then
  die "$SLUG already exists. Pick another REPO_NAME or delete it first."
fi

say "1/6  Filling in your GitHub username ($OWNER) in placeholder URLs"
FILES="$(grep -rlI --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude=publish.sh 'YOU/' . || true)"
if [[ -n "$FILES" ]]; then
  # shellcheck disable=SC2086
  perl -pi -e "s#\\bYOU/#$OWNER/#g" $FILES
  echo "$FILES" | sed 's/^/     updated /'
fi

if [[ "${SKIP_CHECKS:-0}" != "1" ]]; then
  say "2/6  Local quality gate (lint, typecheck, test, build, capabilities)"
  npm ci
  npm run lint
  npm run typecheck
  npm test
  npm run build
  npm run capabilities:check
else
  say "2/6  Skipping local quality gate (SKIP_CHECKS=1)"
fi

say "3/6  Creating the initial commit"
[[ -d .git ]] || git init -b main
git add -A
git commit -m "chore: initial scaffold (milestone M0)"

say "4/6  Creating $SLUG ($VISIBILITY) and pushing"
gh repo create "$SLUG" "--$VISIBILITY" --description "$DESCRIPTION" --source . --remote origin --push

say "5/6  Repository settings"
try gh repo edit "$SLUG" --enable-issues --enable-discussions --enable-squash-merge \
  --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge --enable-auto-merge
try gh repo edit "$SLUG" --add-topic notion,backup,export,markdown,git,cli,typescript,portability
# Squash commits use the (Conventional-Commit) PR title, which release-please turns into the changelog.
try gh api -X PATCH "repos/$SLUG" -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
# Let release-please open its release PR with the workflow token.
try gh api -X PUT "repos/$SLUG/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
# Security features (some need a public repo or GitHub Advanced Security on private ones).
try gh api -X PUT "repos/$SLUG/vulnerability-alerts"
try gh api -X PUT "repos/$SLUG/automated-security-fixes"
try gh api -X PUT "repos/$SLUG/private-vulnerability-reporting"
try gh api -X PATCH "repos/$SLUG" --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON

if [[ "$PROTECT_MAIN" == "1" ]]; then
  say "6/6  Branch protection on main (admins can still push; force-push and deletion blocked)"
  try gh api -X PUT "repos/$SLUG/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["check (ubuntu-latest, node 22)"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
else
  say "6/6  Skipping branch protection (PROTECT_MAIN=0)"
fi

cat <<DONE

Done: https://github.com/$SLUG

Next steps
  1. Watch the first CI run:      gh run watch -R $SLUG
  2. To publish to npm later:     gh secret set NPM_TOKEN -R $SLUG
  3. Merge the release-please PR that appears after your first feat:/fix: commit on main.
DONE
