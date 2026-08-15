#!/usr/bin/env bash
set -euo pipefail

# pack-local.sh — build this checkout once, emit installable npm tarballs.
#
# Produces a self-contained bundle directory holding one .tgz for every
# @paperclipai package the CLI and server need, plus a package.json that wires
# them together with npm `overrides`. Copy that directory to a target host,
# run `npm install` there, and you get a working `paperclipai` binary without
# a pnpm workspace, a compiler, or a published release.
#
# This exists because `paperclipai` on npm does NOT contain this checkout's
# server patches (see ReverseProxyCustomChanges.md). The CLI bundle resolves
# @paperclipai/server at runtime as a normal dependency, so shipping a local
# build means shipping the server tarball alongside it.
#
# The bundle directory is also rolled into a single archive so it can be moved
# to the target host as one file.
#
# Usage:
#   ./scripts/pack-local.sh                       # build, pack, emit .tar.gz
#   ./scripts/pack-local.sh --skip-build          # reuse existing dist/ output
#   ./scripts/pack-local.sh --version 0.0.0-rp.3  # stamp a specific version
#   ./scripts/pack-local.sh --out /srv/paperclip-bundle
#   ./scripts/pack-local.sh --zip                 # .zip instead of .tar.gz
#   ./scripts/pack-local.sh --no-archive          # bundle directory only
#
# The version rewrite is temporary: the rewritten files are restored on exit.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=""
OUT="$REPO_ROOT/releases/local"
skip_build=false
archive_format="tar"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --skip-build) skip_build=true; shift ;;
    --zip) archive_format="zip"; shift ;;
    --no-archive) archive_format="none"; shift ;;
    -h|--help) sed -n '3,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "pack-local: $*" >&2; exit 1; }

[ "$archive_format" != "zip" ] || command -v zip > /dev/null || die "--zip needs the 'zip' command on PATH"

VERSION="${VERSION:-0.0.0-local.$(git rev-parse --short HEAD)}"
OUT="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"

# Packages whose skills directory is materialized at publish time, mirroring
# scripts/release.sh step 2.
SKILL_PKGS=(server packages/adapters/claude-local packages/adapters/codex-local)

# Kept in step with scripts/release-lib.sh, which pins the npm used for
# bundleDependencies packing.
BUNDLED_NPM_PACK_VERSION="10.9.7"

# Pristine copies of the tracked files this script rewrites, taken just before
# the rewrite. Restoring from these instead of `git checkout -- .` means
# unrelated uncommitted work in the tree is not collateral damage.
BACKUP_DIR=""

restore_tree() {
  if [ -f "$REPO_ROOT/cli/package.dev.json" ]; then
    mv -f "$REPO_ROOT/cli/package.dev.json" "$REPO_ROOT/cli/package.json"
  fi
  rm -f "$REPO_ROOT/cli/README.md"
  rm -rf "$REPO_ROOT/server/ui-dist"
  for pkg_dir in "${SKILL_PKGS[@]}"; do
    rm -rf "${REPO_ROOT:?}/$pkg_dir/skills"
  done
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    while IFS= read -r -d '' rel; do
      cp -p "$BACKUP_DIR/$rel" "$REPO_ROOT/$rel"
    done < <(cd "$BACKUP_DIR" && find . -type f -printf '%P\0')
    rm -rf "$BACKUP_DIR"
  fi
}
trap restore_tree EXIT

# Tracked files rewritten below: every public package.json (version + the
# workspace: dep rewrite), the CLI's embedded version string, the CLI manifest
# that build-npm.sh swaps out, and cli/README.md — which build-npm.sh overwrites
# with the root README and restore_tree deletes. It is tracked, so it has to be
# copied back; only a genuinely generated (untracked) one stays deleted.
backup_rewritten_files() {
  BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-pack-local-backup.XXXXXX")"
  local rel
  {
    echo "cli/src/index.ts"
    echo "cli/package.json"
    echo "cli/README.md"
    node "$REPO_ROOT/scripts/release-package-map.mjs" list | cut -f1 | sed 's,$,/package.json,'
  } | sort -u | while IFS= read -r rel; do
    [ -f "$REPO_ROOT/$rel" ] || continue
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -p "$REPO_ROOT/$rel" "$BACKUP_DIR/$rel"
  done
}

echo "==> Packing $VERSION into $OUT"

# Anything the build dirties beyond the files backed up above is reported at the
# end rather than silently reverted.
DIRTY_BEFORE="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no || true)"

if [ "$skip_build" = false ]; then
  echo "  [1/6] Building the workspace (pnpm build)..."
  pnpm build
else
  echo "  [1/6] Skipping workspace build (--skip-build); reusing existing dist output"
fi

# The server serves the UI from its own ui-dist when SERVE_UI=true, so the
# static assets have to be inside the server tarball.
echo "  [2/6] Staging server ui-dist and skills..."
export PAPERCLIP_RELEASE_REUSE_UI_DIST=1
bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
for pkg_dir in "${SKILL_PKGS[@]}"; do
  rm -rf "${REPO_ROOT:?}/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done

echo "  [3/6] Stamping version $VERSION across public packages..."
backup_rewritten_files
node "$REPO_ROOT/scripts/release-package-map.mjs" set-version "$VERSION"

echo "  [4/6] Bundling the CLI (esbuild) and generating its publish manifest..."
bash "$REPO_ROOT/scripts/build-npm.sh" --skip-checks --skip-typecheck > /dev/null

echo "  [5/6] Packing tarballs..."
rm -f "$OUT"/*.tgz "$OUT"/package.json "$OUT"/install.sh

# Every @paperclipai package reachable from the CLI or the server. Anything
# outside this closure comes from the public registry at install time.
CLOSURE="$(node -e '
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const rows = execFileSync("node", ["scripts/release-package-map.mjs", "list"], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean)
  .map((line) => line.split("\t"))
  .reduce((acc, [dir, name]) => Object.assign(acc, { [name]: dir }), {});

const seen = new Set();
const stack = ["paperclipai", "@paperclipai/server"];
while (stack.length > 0) {
  const name = stack.pop();
  if (seen.has(name) || !rows[name]) continue;
  seen.add(name);
  const pkg = JSON.parse(fs.readFileSync(path.join(rows[name], "package.json"), "utf8"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (dep === "paperclipai" || dep.startsWith("@paperclipai/")) stack.push(dep);
  }
}

for (const name of [...seen].sort()) console.log(`${rows[name]}\t${name}`);
')"

declare -a OVERRIDE_LINES=()
CLI_TARBALL=""

has_bundled_deps() {
  node -e '
    const pkg = require(process.cwd() + "/package.json");
    const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];
    process.stdout.write(bundled.length > 0 ? "yes" : "no");
  '
}

while IFS=$'\t' read -r pkg_dir pkg_name; do
  [ -n "$pkg_dir" ] || continue
  bundled="$(cd "$pkg_dir" && has_bundled_deps)"

  if [ "$pkg_name" = "paperclipai" ]; then
    # build-npm.sh already rewrote the CLI manifest, so no workspace: refs remain.
    tarball="$(cd "$pkg_dir" && npm pack --silent --pack-destination "$OUT" | tail -1)"
    CLI_TARBALL="$tarball"
  elif [ "$bundled" = "yes" ]; then
    # bundleDependencies cannot be packed under pnpm's isolated node-linker
    # (adapter-utils bundles patched acpx, db bundles patched embedded-postgres),
    # so stage them the way scripts/release.sh does and pack with npm.
    stage="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-pack-local.XXXXXX")"
    node "$REPO_ROOT/scripts/prepare-bundled-package.mjs" "$REPO_ROOT/$pkg_dir" "$stage" > /dev/null
    tarball="$(cd "$stage" && npx --yes "npm@$BUNDLED_NPM_PACK_VERSION" pack --pack-destination "$OUT" 2>/dev/null | tail -1)"
    tarball="$(basename "$tarball")"
    rm -rf "$stage"
    OVERRIDE_LINES+=("$pkg_name=$tarball")
  else
    tarball="$(cd "$pkg_dir" && pnpm pack --pack-destination "$OUT" 2>/dev/null | tail -1)"
    tarball="$(basename "$tarball")"
    OVERRIDE_LINES+=("$pkg_name=$tarball")
  fi
  printf '        %-45s %s\n' "$pkg_name" "$tarball"
done <<< "$CLOSURE"

[ -n "$CLI_TARBALL" ] || die "the CLI tarball was not produced"

# npm `overrides` pins every internal dependency to the tarball next to it, so
# the install never reaches the registry for an @paperclipai package.
OUT_DIR="$OUT" CLI_TARBALL="$CLI_TARBALL" VERSION="$VERSION" node -e '
const fs = require("node:fs");
const overrides = Object.fromEntries(
  process.argv.slice(1).map((entry) => {
    const index = entry.indexOf("=");
    return [entry.slice(0, index), `file:./${entry.slice(index + 1)}`];
  }),
);
const manifest = {
  name: "paperclip-local-bundle",
  version: process.env.VERSION,
  private: true,
  description: "Locally built Paperclip CLI + server. Run npm install here, then use node_modules/.bin/paperclipai.",
  dependencies: { paperclipai: `file:./${process.env.CLI_TARBALL}` },
  overrides,
};
fs.writeFileSync(`${process.env.OUT_DIR}/package.json`, JSON.stringify(manifest, null, 2) + "\n");
' "${OVERRIDE_LINES[@]}"

cat > "$OUT/install.sh" <<'INSTALL_EOF'
#!/usr/bin/env bash
# Install this bundle on a target host. No repo, no build, no pnpm.
#
# Usage:
#   ./install.sh                      # install here, beside this script
#   ./install.sh --prefix /opt/paperclip
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$BUNDLE_DIR"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) TARGET="${2:?--prefix needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! mkdir -p "$TARGET" 2>/dev/null; then
  echo "Cannot create install directory: $TARGET" >&2
  exit 1
fi
TARGET="$(cd "$TARGET" && pwd)"

if [ "$TARGET" != "$BUNDLE_DIR" ]; then
  # Copy the tarballs and manifest across so the install root is self-contained
  # and can be reinstalled offline later. This also keeps the file: specs in
  # package.json relative, so nothing has to be rewritten.
  echo "Staging bundle into $TARGET"
  cp "$BUNDLE_DIR"/*.tgz "$BUNDLE_DIR/package.json" "$TARGET/"
  cp "$BUNDLE_DIR/install.sh" "$TARGET/install.sh"
fi

cd "$TARGET"
npm install --no-audit --no-fund
echo
echo "Installed. The CLI lives at:"
echo "  $TARGET/node_modules/.bin/paperclipai"
echo
echo "Add it to PATH for this shell:"
echo "  export PATH=\"$TARGET/node_modules/.bin:\$PATH\""
INSTALL_EOF
chmod +x "$OUT/install.sh"

# One file to copy to the target host. The archive holds a single top-level
# directory named for the version, so extracting never scatters tarballs into
# the current directory. A symlinked staging dir renames the top level without
# copying the (large) bundle a second time; tar -h and zip both follow it.
ARCHIVE=""
if [ "$archive_format" != "none" ]; then
  echo "  [6/6] Rolling the bundle into a single archive..."
  # Deliberately unversioned: the archive and the directory it extracts to keep
  # the same names on every build, so install commands, scripts and docs never
  # have to be reworded or globbed. The build is still identified by the version
  # stamped into the packages, which `paperclipai --version` reports.
  BUNDLE_NAME="paperclip-bundle"
  ARCHIVE_DIR="$(dirname "$OUT")"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-pack-local-archive.XXXXXX")"
  ln -s "$OUT" "$stage/$BUNDLE_NAME"

  if [ "$archive_format" = "zip" ]; then
    ARCHIVE="$ARCHIVE_DIR/$BUNDLE_NAME.zip"
    rm -f "$ARCHIVE"
    (cd "$stage" && zip -rq "$ARCHIVE" "$BUNDLE_NAME")
  else
    ARCHIVE="$ARCHIVE_DIR/$BUNDLE_NAME.tar.gz"
    rm -f "$ARCHIVE"
    tar -czhf "$ARCHIVE" -C "$stage" "$BUNDLE_NAME"
  fi

  rm -rf "$stage"
else
  echo "  [6/6] Skipping archive (--no-archive)"
fi

# Put the tree back before reporting on it, so the version stamp itself is not
# what the dirty check below sees.
restore_tree
trap - EXIT

echo
echo "Bundle ready: $OUT"
echo "  version:  $VERSION"
echo "  tarballs: $(ls "$OUT"/*.tgz | wc -l | xargs)"
if [ -n "$ARCHIVE" ]; then
  echo "  archive:  $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
fi
echo
echo "On the target host:"
if [ -n "$ARCHIVE" ]; then
  echo "  scp $ARCHIVE host:/srv/"
  if [ "$archive_format" = "zip" ]; then
    echo "  cd /srv && unzip $(basename "$ARCHIVE")"
  else
    echo "  cd /srv && tar xzf $(basename "$ARCHIVE")"
  fi
  echo "  /srv/$BUNDLE_NAME/install.sh                        # or: --prefix /opt/paperclip"
  echo "  export PATH=\"/srv/$BUNDLE_NAME/node_modules/.bin:\$PATH\""
else
  echo "  cp -r $OUT /srv/paperclip-bundle"
  echo "  /srv/paperclip-bundle/install.sh"
  echo "  export PATH=\"/srv/paperclip-bundle/node_modules/.bin:\$PATH\""
fi
echo "  paperclipai --version"

DIRTY_AFTER="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no || true)"
if [ "$DIRTY_AFTER" != "$DIRTY_BEFORE" ]; then
  echo
  echo "Note: the build left tracked files modified beyond the version stamp."
  echo "      Review with: git -C $REPO_ROOT status --short"
fi
