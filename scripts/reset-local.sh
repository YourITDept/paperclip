#!/usr/bin/env bash
set -euo pipefail

# reset-local.sh — return this checkout to a pristine build state.
#
# Re-cloning the repository to get a clean build is unnecessary: everything that
# makes a build stale is either ignored build output or node_modules, and both
# can be removed in place. This script does that, and nothing else.
#
# What it removes is exactly the set of paths git reports as ignored, minus a
# list of ignored paths that hold real state rather than build output. Two
# properties fall out of that, and both are the point:
#
#   * Files you have not committed yet survive. A new source file is untracked
#     but NOT ignored, so it is never a candidate. (`git clean -x` would take
#     it, which is why this script does not use it.)
#   * Packages with no `clean` script are still cleaned. `pnpm -r run clean`
#     silently skips packages/tailscale-https-broker, leaving its dist/ —
#     including the compiled peercred-native.node addon — in place across a
#     "clean" build. Asking git what is generated avoids that class of miss.
#
# Usage:
#   ./scripts/reset-local.sh              # remove build output, keep node_modules
#   ./scripts/reset-local.sh --deps       # also remove node_modules, then reinstall
#   ./scripts/reset-local.sh --dry-run    # print what would be removed, remove nothing
#   ./scripts/reset-local.sh --yes        # skip the confirmation prompt
#
# After either mode, ./scripts/pack-local.sh is ready to run: it does its own
# clean (step 1/7) and build (step 2/7), so nothing else is needed in between.
#
# --deps is the one to reach for when a merge adds a new workspace package, or
# when an install looks corrupt. A plain run is enough for a stale-artifact
# rebuild.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

wipe_deps=false
dry_run=false
assume_yes=false

while [ $# -gt 0 ]; do
  case "$1" in
    --deps) wipe_deps=true; shift ;;
    --dry-run|-n) dry_run=true; shift ;;
    --yes|-y) assume_yes=true; shift ;;
    # Print the whole header comment, so adding usage lines never truncates -h.
    -h|--help) awk 'NR > 3 { if (!/^#/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "reset-local: $*" >&2; exit 1; }

git rev-parse --git-dir > /dev/null 2>&1 || die "not a git repository: $REPO_ROOT"

# Ignored paths holding state a build does not regenerate. Losing one costs a
# reconfiguration or a local database rather than a rebuild, so they are kept
# in both modes. Matched as a literal path prefix against the repo-relative
# paths git reports.
#
# These cannot be expressed as `git clean -e` excludes: -e adds to the ignore
# rules, so under `git clean -X` ("remove ignored files") an -e pattern marks a
# path for removal rather than protecting it. Filtering here instead.
PRECIOUS=(
  .env
  data/
  .paperclip/
  .paperclip-local/
  .paperclip-runtime/
  .claude/settings.local.json
  .vscode/
  .idea/
)

is_precious() {
  local candidate="$1" precious
  for precious in "${PRECIOUS[@]}"; do
    case "$candidate" in
      "$precious"|"$precious"*) return 0 ;;
      */"$precious"|*/"$precious"*) return 0 ;;
    esac
  done
  return 1
}

# `git status --porcelain --ignored` collapses whole ignored directories to a
# single entry and -z makes the list NUL-separated, so paths containing spaces
# or quotes survive intact. Parsing `git clean -n` prose would not.
declare -a TARGETS=()
declare -a KEPT_PRECIOUS=()
while IFS= read -r -d '' entry; do
  [ "${entry:0:3}" = "!! " ] || continue
  path="${entry:3}"

  if is_precious "$path"; then
    KEPT_PRECIOUS+=("$path")
    continue
  fi

  # Without --deps, node_modules is off limits: reinstalling gigabytes of
  # packages to clear a stale dist/ wastes several minutes for nothing.
  if [ "$wipe_deps" = false ]; then
    case "$path" in
      node_modules/|*/node_modules/) continue ;;
    esac
  fi

  TARGETS+=("$path")
done < <(git status --porcelain --ignored -z)

echo "==> Files this reset would remove:"
if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "    (nothing — the checkout is already clean)"
else
  printf '    %s\n' "${TARGETS[@]}"
fi

if [ "${#KEPT_PRECIOUS[@]}" -gt 0 ]; then
  echo
  echo "==> Keeping (local state, not build output):"
  printf '    %s\n' "${KEPT_PRECIOUS[@]}"
fi

if [ "$dry_run" = true ]; then
  echo
  echo "Dry run: nothing was removed."
  exit 0
fi

if [ "${#TARGETS[@]}" -eq 0 ] && [ "$wipe_deps" = false ]; then
  exit 0
fi

if [ "${#TARGETS[@]}" -gt 0 ] && [ "$assume_yes" = false ] && [ -t 0 ]; then
  echo
  read -r -p "Remove these ${#TARGETS[@]} path(s)? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

if [ "${#TARGETS[@]}" -gt 0 ]; then
  echo
  echo "==> Removing ${#TARGETS[@]} path(s)..."
  rm -rf -- "${TARGETS[@]}"
fi

if [ "$wipe_deps" = true ]; then
  echo "==> Reinstalling dependencies (pnpm install --frozen-lockfile)..."
  # --frozen-lockfile installs exactly what pnpm-lock.yaml pins and fails loudly
  # if the lockfile and the package.json files disagree, rather than rewriting
  # the lockfile and putting unrelated churn in the branch.
  #
  # This also restores the @paperclipai/plugin-sdk symlink inside the plugins
  # excluded from the pnpm workspace, which the node_modules wipe removes and
  # only the root postinstall (scripts/link-plugin-dev-sdk.mjs) recreates.
  pnpm install --frozen-lockfile
fi

echo
echo "Reset complete."
if [ "$wipe_deps" = false ]; then
  echo "  node_modules was kept. Use --deps if a new workspace package was added."
fi
echo
echo "Next:"
echo "  ./scripts/pack-local.sh          # cleans and builds on its own"
