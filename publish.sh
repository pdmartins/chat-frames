#!/usr/bin/env bash
# shellcheck shell=bash
# publish.sh — release chat-frames: bump the version, close the CHANGELOG
# section, merge develop into main and push both.
#
# VERSIONING POLICY. The version is MAJOR.MINOR.REVISION and it changes ONLY on
# a release, i.e. only when develop is merged into main. Between releases the
# version in develop equals the last published one. The CHANGELOG follows the
# same policy: entries are written under `## Unreleased` while developing, and a
# release moves them under a heading with the number it just computed, dated.
# This script refuses to release an empty `## Unreleased`.
#
# WHERE USERS GET IT. The marketplace `pdmartins` lives in another repository
# and points at this one by its GitHub source, with no ref and no version, so it
# serves the default branch. This script makes main that default branch. It
# never touches the other repository and never touches this machine's install.
#
# Usage:
#   bash publish.sh                      release: 0.3.1 -> 0.4.0   (--minor)
#   bash publish.sh --major              release: 0.4.0 -> 1.0.0
#   bash publish.sh --revision           release: 1.0.0 -> 1.0.1   (or --patch)
#   bash publish.sh --dry-run            print the plan, change nothing
#   bash publish.sh --yes                skip the confirmation prompt (or -y)
#
# FINDING `claude`. The checks call `claude plugin test` and `claude plugin
# validate`, so the `claude` executable must be on the PATH of the shell that runs
# this script (here: the npm global bin directory). Note that `claude` is also a
# zsh function in the interactive shell; a function is not inherited by `bash
# publish.sh`, so only the executable counts. The script stops with a message
# when `command -v claude` finds nothing.
#
# A release merges into main and pushes it. That is not undoable from here, so
# everything that can refuse — branch, clean tree, changelog, checks — refuses
# BEFORE the first change, and nothing after the push is allowed to abort the
# script.

set -euo pipefail

# ─── settings ─────────────────────────────────────────────────────────────────
RELEASE_BRANCH="main"
DEV_BRANCH="develop"
REMOTE="origin"
MARKETPLACE_NAME="pdmartins"
PLUGIN_JSON_RELATIVE=".claude-plugin/plugin.json"
CHANGELOG_RELATIVE="CHANGELOG.md"
DEFAULT_BUMP="minor"
# No leading zeros: bash would read 08 as a broken octal number.
VERSION_PATTERN='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
GITHUB_HOST="github.com"
VISIBILITY_PRIVATE="PRIVATE"

# ─── user-visible text ────────────────────────────────────────────────────────
TAG="publish"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ICON_OK="✅"
ICON_WARN="⚠️ "
ICON_FAIL="❌"
USAGE="usage: bash publish.sh [--minor|--major|--revision|--patch] [--dry-run] [--yes|-y]
  default bump is --minor; see the header of this script for the details."

info()    { echo -e "${BLUE}[$TAG]${NC} $*"; }
success() { echo -e "${GREEN}[$TAG]${NC} $ICON_OK $*"; }
warn()    { echo -e "${YELLOW}[$TAG]${NC} $ICON_WARN $*"; }
error()   { echo -e "${RED}[$TAG]${NC} $ICON_FAIL $*" >&2; exit 1; }
dry()     { echo -e "${YELLOW}[dry-run]${NC} $*"; }

# ─── arguments ────────────────────────────────────────────────────────────────
DRY_RUN=false
ASSUME_YES=false
BUMP="$DEFAULT_BUMP"

for arg in "$@"; do
  case "$arg" in
    --dry-run)          DRY_RUN=true ;;
    --yes|-y)           ASSUME_YES=true ;;
    --major)            BUMP="major" ;;
    --minor)            BUMP="minor" ;;
    --revision|--patch) BUMP="revision" ;;
    *)                  echo "unknown argument: $arg" >&2; echo "$USAGE" >&2; exit 1 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

PLUGIN_JSON="$REPO_DIR/$PLUGIN_JSON_RELATIVE"
CHANGELOG_MD="$REPO_DIR/$CHANGELOG_RELATIVE"

command -v claude >/dev/null 2>&1 || \
  error "'claude' is not on the PATH of this shell — the plugin checks need it (see the header of this script)."
command -v python3 >/dev/null 2>&1 || error "'python3' is not on the PATH."

# Prints one top-level field of a JSON file; a clear message, not a traceback,
# when the file is missing, is not JSON, or lacks the field.
read_json() {
  python3 - "$1" "$2" <<'PYEOF'
import json, sys
path, key = sys.argv[1:3]
try:
    with open(path, encoding="utf-8") as handle:
        print(json.load(handle)[key])
except (OSError, ValueError, KeyError, TypeError) as problem:
    sys.exit("cannot read '%s' from %s: %s: %s" % (key, path, type(problem).__name__, problem))
PYEOF
}

PLUGIN_NAME=$(read_json "$PLUGIN_JSON" name)
CURRENT_VERSION=$(read_json "$PLUGIN_JSON" version)
[[ "$CURRENT_VERSION" =~ $VERSION_PATTERN ]] || \
  error "$PLUGIN_JSON_RELATIVE: version '$CURRENT_VERSION' is not MAJOR.MINOR.REVISION."

REMOTE_URL=$(git remote get-url "$REMOTE" 2>/dev/null) || \
  error "the git remote '$REMOTE' does not exist — a release needs somewhere to push."

# owner/repo, read from the remote rather than hardcoded, so renaming the
# repository does not need an edit here. Empty when the remote is not GitHub.
REMOTE_SLUG=""
if [[ "$REMOTE_URL" == *"$GITHUB_HOST"* ]]; then
  REMOTE_SLUG=$(echo "$REMOTE_URL" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
fi

# True when main already exists here, or on the remote (a fresh clone has only
# the remote-tracking ref, and `git checkout main` creates the local one).
release_branch_exists() {
  git show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH" ||
    git show-ref --verify --quiet "refs/remotes/$REMOTE/$RELEASE_BRANCH"
}

# ─── release gates ────────────────────────────────────────────────────────────
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$CURRENT_BRANCH" = "$RELEASE_BRANCH" ] && \
  error "already on $RELEASE_BRANCH. Release from $DEV_BRANCH."

# Getting back to the branch you started on must not depend on the happy path.
# The release checks out main to merge, and `set -e` means a conflicted merge or
# a rejected push kills the script right there — leaving you on main, mid-merge,
# without saying so. This trap runs on every exit, success or failure.
ORIGINAL_BRANCH="$CURRENT_BRANCH"
restore_branch() {
  local status=$?
  local current
  current=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  { [ -z "$current" ] || [ "$current" = "$ORIGINAL_BRANCH" ]; } && return $status
  if [ -f "$(git rev-parse --git-dir 2>/dev/null)/MERGE_HEAD" ]; then
    # Never abort it silently: an unfinished merge is the user's to resolve,
    # and throwing it away could discard conflict resolution already done.
    warn "a merge is still in progress on '$current' — finish it, or run:"
    warn "    git merge --abort && git checkout $ORIGINAL_BRANCH"
    return $status
  fi
  info "returning to $ORIGINAL_BRANCH (was left on $current)"
  git checkout "$ORIGINAL_BRANCH" >/dev/null 2>&1 || \
    warn "could not switch back — you are on '$current'; run: git checkout $ORIGINAL_BRANCH"
  return $status
}
trap restore_branch EXIT
[ "$CURRENT_BRANCH" = "$DEV_BRANCH" ] || \
  warn "releasing from '$CURRENT_BRANCH', not '$DEV_BRANCH'"

# Untracked files count too: `git commit -am` would leave them out of the release.
[ -z "$(git status --porcelain)" ] || \
  error "the working tree is not clean. Commit or stash your changes before releasing."

# The release notes are the one thing this script cannot compute, so they are
# checked while the release can still be called off: once main is pushed, a
# release that says nothing about itself is permanent.
[ -f "$CHANGELOG_MD" ] || error "$CHANGELOG_RELATIVE does not exist."
CHANGELOG_PROBLEM=$(python3 - "$CHANGELOG_MD" <<'PYEOF'
import io, re, sys
text = io.open(sys.argv[1], encoding="utf-8").read()
section = re.search(r"^## Unreleased[^\n]*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
if section is None:
    print("there is no '## Unreleased' heading")
elif not section.group(1).strip():
    print("the '## Unreleased' section is empty")
PYEOF
)
[ -z "$CHANGELOG_PROBLEM" ] || \
  error "$CHANGELOG_RELATIVE: $CHANGELOG_PROBLEM — write what this release changes under that heading first; the release moves it under the new version."

info "Running the plugin tests..."
TEST_OUT=$(claude plugin test . 2>&1) || {
  echo "$TEST_OUT" | tail -25
  error "'claude plugin test .' failed — release aborted."
}
success "tests OK ($(echo "$TEST_OUT" | grep -E '^Ran ' | tail -1))"

info "Validating the plugin..."
claude plugin validate . --strict >/dev/null 2>&1 || \
  error "'claude plugin validate . --strict' failed — release aborted."
success "plugin validates"

# ─── compute the new version ──────────────────────────────────────────────────
IFS=. read -r MAJOR MINOR REVISION <<< "$CURRENT_VERSION"
case "$BUMP" in
  major)    NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  minor)    NEW_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  revision) NEW_VERSION="${MAJOR}.${MINOR}.$((REVISION + 1))" ;;
esac
RELEASE_DATE=$(date +%F)

echo ""
info "Plugin:      $PLUGIN_NAME"
info "Branch:      $CURRENT_BRANCH → $RELEASE_BRANCH"
info "Version:     $CURRENT_VERSION → $NEW_VERSION  ($BUMP)"
info "Remote:      $REMOTE_URL"
echo ""

if $DRY_RUN; then
  dry "bump version $CURRENT_VERSION → $NEW_VERSION in $PLUGIN_JSON_RELATIVE"
  dry "move the '## Unreleased' notes of $CHANGELOG_RELATIVE under '## $NEW_VERSION — $RELEASE_DATE', empty '## Unreleased' on top"
  dry "git commit -am 'release: v$NEW_VERSION' && git push $REMOTE $CURRENT_BRANCH"
  if release_branch_exists; then
    dry "git checkout $RELEASE_BRANCH && git merge --no-ff $CURRENT_BRANCH -m 'release: v$NEW_VERSION'"
  else
    dry "git checkout -b $RELEASE_BRANCH  (first release: $RELEASE_BRANCH starts at $CURRENT_BRANCH, so there is no merge commit)"
  fi
  dry "git push $REMOTE $RELEASE_BRANCH && git checkout $CURRENT_BRANCH"
  if [ -n "$REMOTE_SLUG" ] && command -v gh >/dev/null 2>&1; then
    dry "gh repo edit $REMOTE_SLUG --default-branch $RELEASE_BRANCH  (if it is not already), and warn if the repository is private"
  else
    dry "(no gh or no GitHub remote) the default branch and visibility are left alone"
  fi
  warn "Dry-run finished — nothing was executed."
  exit 0
fi

if ! $ASSUME_YES; then
  printf "Merge %s into %s and push v%s? [y/N] " "$CURRENT_BRANCH" "$RELEASE_BRANCH" "$NEW_VERSION"
  read -r reply
  case "$reply" in [yY]*) ;; *) error "aborted." ;; esac
fi

# ─── bump, commit, merge, push ────────────────────────────────────────────────
# Only the version value is replaced, so the rest of plugin.json keeps its layout.
python3 - "$PLUGIN_JSON" "$CHANGELOG_MD" "$NEW_VERSION" "$RELEASE_DATE" <<'PYEOF'
import io, json, re, sys

plugin_json, changelog, version, date = sys.argv[1:5]

with io.open(plugin_json, encoding="utf-8") as handle:
    text = handle.read()

# Walk the strings and brackets to find the "version" key at depth 1: a nested
# object may carry a "version" of its own that must stay as it is.
TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[{}\[\]]')
VALUE = re.compile(r'\s*:\s*("(?:[^"\\]|\\.)*")')
depth = 0
span = None
for token in TOKEN.finditer(text):
    if token.group() in ("{", "["):
        depth += 1
    elif token.group() in ("}", "]"):
        depth -= 1
    elif depth == 1 and token.group() == '"version"':
        value = VALUE.match(text, token.end())
        if value:
            span = value.span(1)
            break
if span is None:
    raise SystemExit("no top-level \"version\" field found in " + plugin_json)
text = text[:span[0]] + json.dumps(version) + text[span[1]:]
with io.open(plugin_json, "w", encoding="utf-8") as handle:
    handle.write(text)

# `## Unreleased` keeps its place, now empty, and the notes that were under it
# end up under the new heading. The gate above already refused an empty section.
with io.open(changelog, encoding="utf-8") as handle:
    text = handle.read()
heading = "## Unreleased\n\n## %s \u2014 %s\n" % (version, date)
text, renamed = re.subn(r"^## Unreleased[^\n]*\n", lambda _: heading, text, count=1, flags=re.M)
if not renamed:
    raise SystemExit("no '## Unreleased' heading found in " + changelog)
with io.open(changelog, "w", encoding="utf-8") as handle:
    handle.write(text)
PYEOF
success "$PLUGIN_JSON_RELATIVE bumped to $NEW_VERSION, $CHANGELOG_RELATIVE section moved"

claude plugin validate . --strict >/dev/null 2>&1 || \
  error "the bumped plugin does not validate — nothing was committed or pushed. Undo with: git checkout -- $PLUGIN_JSON_RELATIVE $CHANGELOG_RELATIVE"

git commit -q -am "release: v$NEW_VERSION"
git push "$REMOTE" "$CURRENT_BRANCH"
success "committed and pushed on $CURRENT_BRANCH"

info "Merging $CURRENT_BRANCH → $RELEASE_BRANCH..."
if release_branch_exists; then
  git checkout "$RELEASE_BRANCH"
  git merge --no-ff "$CURRENT_BRANCH" -m "release: v$NEW_VERSION"
else
  git checkout -b "$RELEASE_BRANCH"   # first release: main starts here
fi
git push "$REMOTE" "$RELEASE_BRANCH"
# Tolerant on purpose: the release is public from the line above, so nothing
# after it may abort the script. The EXIT trap is the backstop if this fails.
git checkout "$CURRENT_BRANCH" || warn "could not return to $CURRENT_BRANCH"
success "v$NEW_VERSION is on $RELEASE_BRANCH"

# ─── nothing below may abort: the release is already public ───────────────────
# The marketplace entry has no ref, so it serves the repository's DEFAULT branch:
# one still pointing at develop would hand users the development code — the exact
# opposite of what this release just did.
if [ -n "$REMOTE_SLUG" ] && command -v gh >/dev/null 2>&1; then
  DEFAULT_BRANCH=$(gh repo view "$REMOTE_SLUG" --json defaultBranchRef \
    --jq .defaultBranchRef.name 2>/dev/null || true)
  if [ "$DEFAULT_BRANCH" != "$RELEASE_BRANCH" ]; then
    info "GitHub default branch is '$DEFAULT_BRANCH' — switching it to $RELEASE_BRANCH..."
    if gh repo edit "$REMOTE_SLUG" --default-branch "$RELEASE_BRANCH"; then
      success "default branch is now $RELEASE_BRANCH"
    else
      warn "could not switch it — run: gh repo edit $REMOTE_SLUG --default-branch $RELEASE_BRANCH"
    fi
  fi
  VISIBILITY=$(gh repo view "$REMOTE_SLUG" --json visibility --jq .visibility 2>/dev/null || true)
  if [ "$VISIBILITY" = "$VISIBILITY_PRIVATE" ]; then
    warn "the repository is PRIVATE — others cannot install it from the marketplace until you make it public"
  fi
fi

echo ""
success "Released v$NEW_VERSION"
echo ""
echo "  To get it, run (this script did not):"
echo "    /plugin marketplace update $MARKETPLACE_NAME"
echo "    claude plugin update $PLUGIN_NAME@$MARKETPLACE_NAME"
echo ""
echo "  Then open a NEW session: hooks load at session start."
