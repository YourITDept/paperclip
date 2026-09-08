#!/usr/bin/env bash
# ============================================================================
# verify-fork.sh — the post-merge verification procedure, executable.
#
# FORK-CARRIED (CustomCodeDoc §4 change set 8, local scripts). Upstream has no
# equivalent. See CustomCodeDoc/"Review and Test Changes.md" for the reasoning
# behind every check here; this script is that document's §6.5, §7.1, §7.2 and
# §7.3 made runnable so they are not re-derived, and so their traps cannot be
# forgotten.
#
# RULE 0: this script NEVER commits, pushes, merges or resets. It only reads
# and runs tests.
#
#   ./scripts/verify-fork.sh guards     # ~3 min  greps + typecheck
#   ./scripts/verify-fork.sh targeted   # ~8 min  the §7.2 change-set suites
#   ./scripts/verify-fork.sh full       # ~90 min everything, incl. serialized
#   ./scripts/verify-fork.sh            # guards + targeted
#
# Results land in $OUT (default /tmp/paperclip-verify) with a summary.tsv.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
OUT=${OUT:-/tmp/paperclip-verify}
MODE=${1:-default}
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
: > "$SUMMARY"

# ---------------------------------------------------------------------------
# The env scrub. §7.5 #2: the container exports ~24 PAPERCLIP_* variables for
# the live deployment and the suite assumes a clean environment. FOUR have
# bitten so far. Treat this as a CLASS, not a list — when an assertion mentions
# a host, URL, path or mode that matches `env | grep PAPERCLIP_`, or when
# something was "called 0 times", suspect a fifth.
# ---------------------------------------------------------------------------
CLEAN=(env
  -u PAPERCLIP_CODEX_HOME          # retired in v6, harmless but kept
  -u PAPERCLIP_PUBLIC_URL          # 2 OAuth origin tests
  -u PAPERCLIP_TELEMETRY_DISABLED  # CLI telemetry suite
  -u PAPERCLIP_NO_BROWSER          # CLI onboard-service; found Session 19
)

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()  { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
note() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$SUMMARY"; }

FAILED=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then grn "  PASS  $1 ($3)"; note PASS "$1" "$3"
  else red "  FAIL  $1 — expected $2, got $3"; note FAIL "$1" "got=$3 want=$2"; FAILED=1; fi
}

# ===========================================================================
hdr "0. Toolchain — §3.1 and §3.3"
# §3.3: `pnpm` on PATH is 9.15.9 and is NOT the pin. Only `corepack pnpm` is.
PNPM_V=$(corepack pnpm -v 2>/dev/null | tail -1)
check "corepack pnpm is the pin" "9.15.4" "$PNPM_V"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
check "node major" "24" "$NODE_MAJOR"

# §3.2: the database-backed suites depend on the embedded-postgres patch. If
# these are missing, install did not apply patchedDependencies and a large
# number of suites will fail for a reason that has nothing to do with the merge.
PATCHED=$(ls node_modules/.pnpm 2>/dev/null | grep -cE 'embedded-postgres@.*patch_hash|acpx@.*patch_hash')
if [ "$PATCHED" -ge 2 ]; then grn "  PASS  patched deps applied ($PATCHED)"; note PASS "patched deps" "$PATCHED"
else red "  FAIL  patched deps missing — run: corepack pnpm install --frozen-lockfile"; note FAIL "patched deps" "$PATCHED"; FAILED=1; fi

# §7.5 #1: without this, twelve server suites fail at IMPORT and report
# "(0 test)" rather than assertion failures. plain test:run does NOT do it.
corepack pnpm --filter @paperclipai/plugin-sdk ensure-build-deps > "$OUT/sdk.log" 2>&1 \
  && grn "  PASS  plugin-sdk build deps" || ylw "  WARN  plugin-sdk ensure-build-deps failed — see $OUT/sdk.log"

# ===========================================================================
hdr "1. Change-set guards — §6.5. Greps, because nothing else detects these"
# Each of these fails SILENTLY if lost: no type error, no red suite, just wrong
# behaviour. That is why they are greps and not tests.
g() { # g <label> <expected-count> <pattern> <files...>
  local label=$1 want=$2 pat=$3; shift 3
  check "$label" "$want" "$(grep -ho "$pat" "$@" 2>/dev/null | wc -l | tr -d ' ')"
}
# change set 1 — the proxy_header actor source
check "cs1 proxy-header-auth.ts present" "yes" "$([ -f server/src/auth/proxy-header-auth.ts ] && echo yes || echo no)"
# Quoted, so this counts the UNION MEMBER and not the surrounding comment that
# also names it. A bare `proxy_header` grep counts 2 and looks like a failure.
g     "cs1 proxy_header in express.d.ts" 1 '"proxy_header"' server/src/types/express.d.ts
# change sets 3+4 — the credential vault routes
check "cs3 codex-vaults route"  "yes" "$([ -f server/src/routes/codex-vaults.ts ] && echo yes || echo no)"
check "cs4 claude-vaults route" "yes" "$([ -f server/src/routes/claude-vaults.ts ] && echo yes || echo no)"
# change sets 3+4, THE UI HALF. Server routes surviving proves nothing about
# whether a person can reach the pages. Added 2026-09-08 after the two tabs went
# missing from a production build for a week: upstream's `.production` layout
# family (#12746/#12748) is chosen by `streamlinedUiEnabled`, and the fork's
# sidebar entries existed in the streamlined file only. Nothing failed — the
# routes were registered for both modes, so the pages stayed reachable by URL
# and every test passed. They were simply invisible.
# BOTH sidebars must carry BOTH entries. Keep them in sync.
#
# Presence, not an exact count: these files legitimately mention each name
# several times (nav item, visibility map, path matcher), and a count-based
# guard would go red the first time someone adds a line. What must never be
# true is a name being ABSENT from one of these surfaces.
pair() { # pair <label> <file> <term>...
  local label=$1 file=$2; shift 2
  local missing=""
  for term in "$@"; do grep -q -- "$term" "$file" 2>/dev/null || missing="$missing $term"; done
  if [ -z "$missing" ]; then grn "  PASS  $label"; note PASS "$label" "all present"
  else red "  FAIL  $label — absent from $(basename "$file"):$missing"; note FAIL "$label" "missing:$missing"; FAILED=1; fi
}
pair "cs3/4 sidebar (streamlined)" ui/src/components/CompanySettingsSidebar.tsx            codex-logins claude-logins
pair "cs3/4 sidebar (production)"  ui/src/components/CompanySettingsSidebar.production.tsx codex-logins claude-logins
pair "cs3/4 settings tab bar"      ui/src/components/access/CompanySettingsNav.tsx         codex-logins claude-logins
pair "cs3/4 routes + imports"      ui/src/App.tsx  codex-logins claude-logins InstanceCodexVaults InstanceClaudeVaults
# §4.1 — upstream emptied this exclusion set in Session 19; the fork's two stay
g     "cs3/4 openapi exclusions" 2 "codex-vaults.ts\|claude-vaults.ts" server/src/__tests__/openapi-routes.test.ts
# change set 6 — one term, easy to lose
g     "cs6 invite auto-accept guard" 1 "Boolean(invite) &&" ui/src/pages/InviteLanding.tsx
# change set 10 — the HIRE call site is the one a conflict tends to drop
g     "cs10 duplicateFromAgentId" 1 "duplicateFromAgentId" packages/shared/src/validators/agent.ts
g     "cs10 restoreDuplicateSourceEnv (def + 2 call sites)" 3 "restoreDuplicateSourceEnv" server/src/routes/agents.ts
# change set 11 — THE WORST SILENT FAILURE IN THE FORK. Lose these three lines
# and the build, the typecheck and every suite stay green while the instance
# onboards nobody, for ever. The provisioning suites do not catch it: they
# construct the handlers directly and never import index.ts.
g     "cs11 provisioning wired into index.ts" 3 "startProvisioningWorker\|provisioningWorker.stop" server/src/index.ts
check "cs11 module present" "5" "$(ls server/src/provisioning/*.ts 2>/dev/null | wc -l | tr -d ' ')"

if [ "$MODE" = "guards" ]; then hdr "guards only — stopping"; exit $FAILED; fi

# ===========================================================================
hdr "2. Typecheck — §7.3"
# §7.5 #5: exit 137 is the OOM KILLER, not tsc. The signature is zero `error TS`
# lines with a non-zero exit. Never run this beside the suite: the host has
# 15 GB and cannot hold both.
if ps -eo rss,cmd --sort=-rss | grep -q "[v]itest"; then
  ylw "  WARN  vitest is already running — typecheck may be OOM-killed (§7.5 #5)"
fi
corepack pnpm run typecheck > "$OUT/typecheck.log" 2>&1; TC=$?
TS_ERRORS=$(grep -cE 'error TS' "$OUT/typecheck.log")
if [ "$TC" -eq 0 ]; then grn "  PASS  typecheck (0 error TS)"; note PASS typecheck 0
elif [ "$TS_ERRORS" -eq 0 ]; then
  red "  FAIL  typecheck exit $TC with ZERO 'error TS' — this is MEMORY (§7.5 #5), not types."
  red "        Check for stale runs:  ps -eo pid,rss,etime,cmd --sort=-rss | head -12"
  note FAIL typecheck "exit=$TC oom-signature"; FAILED=1
else red "  FAIL  typecheck — $TS_ERRORS type errors, see $OUT/typecheck.log"; note FAIL typecheck "$TS_ERRORS errors"; FAILED=1; fi

# ===========================================================================
hdr "3. Change-set suites — §7.2"
# Expected counts drift UPWARD when upstream adds cases; that is fine and not a
# failure. A count going DOWN is the alarm.
suite() { # suite <label> <expected-tests> <files...>
  local label=$1 want=$2; shift 2
  local log="$OUT/suite-$(echo "$label" | tr ' /' '__').log"
  "${CLEAN[@]}" corepack pnpm exec vitest run "$@" > "$log" 2>&1
  local got; got=$(grep -oE 'Tests +[0-9]+ passed' "$log" | tail -1 | grep -oE '[0-9]+')
  got=${got:-0}
  if [ "$got" -ge "$want" ]; then
    grn "  PASS  $label ($got passed; baseline $want)"; note PASS "$label" "$got"
    [ "$got" -gt "$want" ] && ylw "        note: above baseline — upstream added cases; update §7.2"
  else red "  FAIL  $label — $got passed, baseline $want. See $log"; note FAIL "$label" "$got<$want"; FAILED=1; fi
}
suite "cs1 proxy header auth" 28 server/src/auth/proxy-header-auth.test.ts \
  server/src/middleware/proxy-header-actor.test.ts \
  server/src/__tests__/proxy-header-auth.integration.test.ts
suite "cs3+4 credential vaults" 83 server/src/__tests__/codex-vault-login-service.test.ts \
  server/src/__tests__/claude-vault-login-service.test.ts \
  packages/adapters/codex-local/src/server/codex-vault.test.ts \
  packages/adapters/claude-local/src/server/claude-vault.test.ts
suite "cs3/4 sidebar parity (UI reachability)" 4 ui/src/components/CompanySettingsSidebar.fork-parity.test.ts
suite "cs5 vault preset" 20 ui/src/lib/new-agent-preset.test.ts ui/src/pages/NewAgent.test.tsx
suite "cs6 invite guard" 19 ui/src/pages/InviteLanding.test.tsx
suite "cs10 duplicate payload" 5 ui/src/lib/duplicate-agent-payload.test.ts
suite "cs10 agent permissions" 69 server/src/__tests__/agent-permissions-routes.test.ts
suite "cs3/4 openapi contract" 5 server/src/__tests__/openapi-routes.test.ts
suite "cs11 provisioning" 17 server/src/__tests__/provisioning-agent-codex-home.test.ts \
  server/src/__tests__/provisioning-agent-task.test.ts

if [ "$MODE" != "full" ]; then
  hdr "Summary"; column -t -s"$(printf '\t')" "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
  echo; ylw "Run './scripts/verify-fork.sh full' for the whole suite (~90 min)."
  exit $FAILED
fi

# ===========================================================================
hdr "4. Full suite — §7.1, four processes"
# ONE GROUP PER PROCESS. `pnpm run test:run` exits on the first failing group,
# so groups 2-4 never start; on this host general-server ALWAYS fails, which
# means test:run has never once exercised most of the fork's own code.
for grp in general-server general-workspaces-a general-workspaces-b; do
  echo "  running $grp ..."
  "${CLEAN[@]}" node scripts/run-vitest-stable.mjs --mode general --group "$grp" > "$OUT/$grp.log" 2>&1
  grep -hE "Test Files" "$OUT/$grp.log" | sed 's/^/    /'
done
# §7.1: general-workspaces-a holds TWO vitest projects (ui, cli) and the abort
# applies between them too. One summary block means a project was skipped and
# the group's result is incomplete however green it looks.
BLOCKS=$(grep -cE '^ Test Files' "$OUT/general-workspaces-a.log")
check "workspaces-a ran both projects" "2" "$BLOCKS"

# ===========================================================================
hdr "5. Serialized — per file, WITHOUT the abort. §7.1"
# `--mode serialized` calls runVitest once per file and runVitest exits the
# process on any non-zero status, so ONE failing suite abandons every suite
# after it in localeCompare order. Session 19 measured 58 of 143 — 59% never
# ran. Any tally printed by the script is a lower bound on a number nobody can
# see. This loop is the only way to get real coverage.
node scripts/run-vitest-stable.mjs --mode serialized --dry-run 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).selectedSerializedSuites.join("\n")))' \
  > "$OUT/serial-files.txt"
TOTAL=$(grep -c . "$OUT/serial-files.txt")
mkdir -p "$OUT/serial-logs"; : > "$OUT/serial-results.tsv"
n=0
while IFS= read -r f; do
  [ -z "$f" ] && continue; n=$((n+1))
  "${CLEAN[@]}" corepack pnpm exec vitest run --project @paperclipai/server \
    "$f" --pool=forks --isolate > "$OUT/serial-logs/$(echo "$f" | tr / _).log" 2>&1
  rc=$?
  printf '%s\t%s\n' "$rc" "$f" >> "$OUT/serial-results.tsv"
  [ "$rc" -ne 0 ] && red "  [$n/$TOTAL] FAIL $f" || printf '  [%s/%s] ok\n' "$n" "$TOTAL"
done < "$OUT/serial-files.txt"
SFAIL=$(awk -F'\t' '$1!=0' "$OUT/serial-results.tsv" | wc -l | tr -d ' ')
note "$([ "$SFAIL" -eq 0 ] && echo PASS || echo INFO)" "serialized" "$SFAIL failed of $TOTAL"

# ===========================================================================
hdr "Summary"
column -t -s"$(printf '\t')" "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
cat <<'EOF'

CLASSIFY EVERY FAILURE BEFORE RECORDING IT — §7.4. A failure is not
automatically the fork's fault, and most on this host are not:

  * Already in §8's register?  It is standing. Do not re-investigate.
  * §7.5 #4 — workspace-runtime*, local-service-supervisor bind real ports and
    spawn process trees; cursor-local-* exits 127 because cursor-agent is not
    in the image. Re-run alone before classifying.
  * §7.5 #2 — does the assertion mention a host/URL/path/mode in
    `env | grep PAPERCLIP_`, or say "called 0 times"? Re-run that ONE file with
    the variable cleared before investigating anything else.
  * Upstream's? Prove it rather than assume it:
        git log <prev-upstream-tip>..<fork-tip> -- <impl>   # empty = never ours
        git diff --quiet <upstream-tip> HEAD -- <impl>      # identical = theirs
        git diff --quiet <upstream-tip> HEAD -- <test>
    then check the suite's imports do not reach fork-carried code. State that
    you used byte-identity instead of a scratch worktree — it is an argument,
    not a measurement.

Append a dated session entry to §8 of CustomCodeDoc/"Review and Test Changes.md".
Then STOP. The operator commits (RULE 0).
EOF
exit $FAILED
