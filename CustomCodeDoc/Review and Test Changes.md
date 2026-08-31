---
name: review-and-test-changes
description: The standing procedure for reviewing and testing an upstream merge into the YourITDept/paperclip fork. Start here after merging paperclipai/paperclip into a new dated working branch. Covers the coordinates (repos, branches, doc locations), the container runtime the work happens in, the register of fork-carried custom code that upstream can silently undo, the exact commands to run, and how to read and record the test results.
metadata:
  status: current
  owner: Chris (cwa@youritdept.com)
  written: 2026-08-29
  first-applied: W4-20260829a (merge 2342be5d0 / PR #31)
---

# Review and Test Changes — the standing post-merge procedure

> **What this file is for.** Every time upstream code is merged into the fork,
> the same question has to be answered: *did the upstream change break anything
> the fork carries?* This document is the answer procedure. It is written so
> that a single prompt (§0) plus this file is enough — nothing else needs to be
> explained to the assistant at the start of a session.
>
> **What this file is not.** It does not describe the fork's features. Those
> live in the other files in this directory (§4). It does not describe how to
> re-apply a lost change — [`ReverseProxyCustomChanges.md`](CustomCodeDoc/ReverseProxyCustomChanges.md) §0
> does that. This file is the *review and test* half only.

**Convention:** §7 is an append-only session log. Add a new dated entry every
time this procedure runs. Do not rewrite old entries; amend them with a
follow-up line.

**To use this as an auto-discovered skill**, copy this file to
`skills/review-and-test-changes/SKILL.md`. It lives here because this directory
is where the fork's working documents are kept and where the operator looks
first.

---

## 0. The prompt to use — copy this at the start of every session

Paste this verbatim. Fill in only the branch name and, if known, the number of
upstream changes merged.

> I merged upstream into a new branch, `W4-<YYYYMMDD><letter>`. Follow
> `CustomCodeDoc/Review and Test Changes.md` — start at §0, it tells you
> everything you need.
>
> Review the upstream changes that came in with this merge and validate that they
> work with the fork's custom code, which is documented in `CustomCodeDoc/`.
> The upstream project's own documentation is in `doc/`. Run the full test suite;
> for anything that fails, work out whether the cause is the custom code or is
> pre-existing/environmental, and record it in the known-failure register (§6.4).
> Append a new dated session entry to §7 when you are done.
>
> Don't commit anything unless I ask.

That is the whole prompt. Everything below is what it relies on.

### 0.1 The three things the assistant must not assume

1. **Do not re-apply anything by reflex.** The fork now *merges upstream into a
   long-lived working branch* rather than re-branching from upstream. In that
   workflow the fork's changes are already in history and a cherry-pick would
   duplicate work that is present. Check first — §5.3.
2. **Do not commit or push.** The operator commits. Say what changed and stop.
3. **Do not trust a bare `pnpm -v`.** See §3.3 — the pnpm on `PATH` is *not* the
   pinned version. Use `corepack pnpm` for anything whose result is quoted.

---

## 1. Coordinates

| | |
| --- | --- |
| **Fork (ours)** | <https://github.com/YourITDept/paperclip.git> — remote `origin` |
| **Upstream (theirs)** | <https://github.com/paperclipai/paperclip.git> |
| **Working copy** | `/Projects/paperclip` |
| **Operator** | Chris — cwa@youritdept.com |

### 1.1 Branch naming

Working branches are `W<week><YYYYMMDD><letter>` — the ISO-ish week bucket, the
date, then a letter that increments for each branch cut on the same day:

```
W4-20260827a   W4-20260828a   W4-20260828b   W4-20260828c   W4-20260829a
```

A new letter means a new branch on the same day, normally because a fresh
upstream merge was taken. The fork's own long-lived branch is `master`; upstream
merges arrive as GitHub pull requests from `paperclipai/paperclip` into it
(PR #24 … #31 so far).

### 1.2 Where documentation lives

| Directory | Whose | What it holds |
| --- | --- | --- |
| [`doc/`](doc/) | **upstream's** | The codebase documentation for the project we forked — architecture, database, deployment modes, CLI, releasing, specs. Read this to understand *what an upstream change is doing*. |
| [`docs/`](docs/) | upstream's | The published Mintlify documentation site source. |
| [`CustomCodeDoc/`](CustomCodeDoc/) | **ours** | The fork's working documents — what the fork carries, why, and the running logs. Read this to understand *what an upstream change might break*. §4 is the index. |

`AGENTS.md`, `CONTRIBUTING.md`, `DESIGN.md` and `ROADMAP.md` at the repo root are
upstream's and describe upstream's own conventions.

---

## 2. Where the work runs — the container

All of this work happens **inside a purpose-built Docker container**, not on a
developer host. The container is the environment; nothing is installed on a host
to make a build correct.

- The container's build source lives in the operator's **`octo-docker`**
  directory (outside this repository). Look there for the library sets, the
  package selection and the image assembly.
- The running container reports its build generation in
  [`/etc/octobot-version`](/etc/octobot-version) — **`v83`** at the time of
  writing. The same stamp keys the versioned trees under `/install`
  (`/install/engineroom/v83`, `/install/linuxbrew/v83`).

> **Note (2026-08-29).** The `octo-docker` directory is *not* mounted inside the
> running container — a filesystem search finds no such path. Read the two
> manifests below (§2.1) as the authoritative record of what the image actually
> contains; use `octo-docker` on the host when the question is *how* it got
> there.

### 2.1 The two install manifests — read these instead of guessing

The image writes a complete record of everything it installed. When a tool
version matters, read the manifest rather than probing:

| File | What it lists |
| --- | --- |
| [`/os-install-manifest.txt`](/os-install-manifest.txt) | Every Ubuntu package in the image, with versions. Header line gives the distribution: **Ubuntu 24.04.4 LTS, amd64**. 237 lines. |
| [`/home/linuxbrew/brew-install-manifest.txt`](/home/linuxbrew/brew-install-manifest.txt) | Every **Linuxbrew (Homebrew)** formula and cask, plus the Rust toolchain, the Node/npm/pnpm aliases, the global npm packages and `psql`. Header line gives the Homebrew version. 155 lines. |

**Linuxbrew is the tool manager for anything outside the base OS packages.**
Homebrew's prefix is `/home/linuxbrew/.linuxbrew`, and `node`, `npm` and `pnpm`
on `PATH` are all Homebrew-tracked aliases into it.

### 2.2 What the manifests say today (image `v83`)

Recorded so a later drift is visible. Re-read the manifests rather than trusting
this table if a version-sensitive result is in question.

| Tool | Version | Source |
| --- | --- | --- |
| OS | Ubuntu 24.04.4 LTS (amd64) | `/os-install-manifest.txt` |
| Homebrew | 6.0.20 | brew manifest header |
| Node | **v24.20.0** (`node@24`) | Linuxbrew alias |
| npm | 11.19.0 | Linuxbrew alias |
| pnpm | **9.15.9** (`pnpm@9`, keg-only) | Linuxbrew alias — **not the pin**, see §3.3 |
| corepack | 0.35.0 (global npm) | provisions the pinned pnpm |
| Rust | rustc/cargo **1.98.0**, rustup 1.29.0 | brew manifest `---- rust ----` |
| PostgreSQL client | psql 18.6 (`libpq` 18.6) | brew manifest `---- psql ----` |
| git / gh | 2.55.0 / 2.98.0 | brew |
| ripgrep | 15.2.0 | brew — must stay on `PATH`, see the build doc §3.1 |
| Python | 3.14.7 (+ `pyenv`, `pipx`, `uv`) | brew |
| Claude Code | 2.1.236 | brew |
| Also present | `gcc` 16.2.0, `make`, `tmux`, `screen`, `restic`, `ffmpeg`, `obsidian-headless` | brew |

Other container paths worth knowing:

| Path | Contents |
| --- | --- |
| `/install/paperclip/<release>`, `/install/paperclip-release/<release>` | The deployed Paperclip release trees (currently `W4-20260828c`). |
| `/install/READY.txt` | Timestamp the image finished provisioning. |
| `/sysops/` | Runtime state — `config`, `db_backups`, `llm` (the credential vaults, see §4), `logs`, `paperclip`, `supervisord`. |
| `/shared/` | `business-brain`, `paperclip`. |

---

## 3. The toolchain rules that govern test results

Full detail is in [`builds paperclip.md`](CustomCodeDoc/builds%20paperclip.md).
The three rules that change how a test result must be read:

### 3.1 The canonical pins

Node **24** (floor `24.11.0`), pnpm **9.15.4** (`packageManager` in
`package.json`), lockfile format `9.0`, `@types/node` `^24.0.0`. The container's
Node 24.20.0 is inside the canonical major and above the floor — results on it
are attributable.

### 3.2 Install before testing, and check the patches applied

`node_modules` is not baked into the image; a fresh checkout has none.

```bash
corepack pnpm install --frozen-lockfile
```

Then confirm the two patched dependencies actually got patched — the
database-backed suites depend on the `embedded-postgres` patch:

```bash
ls node_modules/.pnpm | grep -E 'embedded-postgres|acpx'
# expect: embedded-postgres@18.1.0-beta.16_patch_hash=…
#         acpx@0.12.0_patch_hash=…
```

The `Failed to create bin at …/paperclip-plugin-dev-server` warnings during
install are **benign** — the plugin SDK's `dist/` does not exist until it is
built, and the postinstall relinks it afterwards.

### 3.3 `pnpm` on `PATH` is not the pin — use `corepack pnpm`

`/home/linuxbrew/.linuxbrew/opt/pnpm@9/bin/pnpm` **is** 9.15.9 and does **not**
delegate to the pinned 9.15.4. Both are pnpm 9, so `overrides` and
`patchedDependencies` still resolve out of `package.json` and nothing breaks —
but a bare `pnpm -v` is not evidence the pin was honoured. `corepack pnpm -v`
prints `9.15.4`. **Prefer `corepack pnpm` for every command in §6.**

---

## 4. What the fork carries — the register to protect

Upstream does not have any of this. An upstream change can silently undo it, and
most of it fails *quietly*: no type error, no crash, just wrong behaviour. This
is the list to check against every incoming change.

| # | Change set | Its document | Principal files |
| --- | --- | --- | --- |
| 1 | **Reverse-proxy / forward-auth** — a `proxy_header` actor source resolved from `X-Forwarded-User`, off unless `PAPERCLIP_PROXY_AUTH_ENABLED=true` | [`ReverseProxyCustomChanges.md`](CustomCodeDoc/ReverseProxyCustomChanges.md), [`doc/REVERSE-PROXY-AUTH.md`](doc/REVERSE-PROXY-AUTH.md) | `server/src/auth/proxy-header-auth.ts`, `server/src/middleware/auth.ts`, `server/src/types/express.d.ts`, `server/src/services/authorization.ts`, `server/src/routes/authz.ts`, `server/src/realtime/live-events-ws.ts` |
| 2 | **`PAPERCLIP_CODEX_HOME`** — relocates the Paperclip-*managed* Codex home without opting out of management | [`Codex-changes-instructions.md`](CustomCodeDoc/Codex-changes-instructions.md) | `packages/adapter-utils/src/server-utils.ts`, `packages/adapter-utils/src/acpx-engine/execute.ts`, `packages/adapters/codex-local/src/server/{execute,codex-home,acp,test}.ts` |
| 3 | **Codex credential vaults** — provision `/sysops/llm/codex/<name>`, sign in, sign out, delete, from Settings | [`Codex device login web service.md`](CustomCodeDoc/Codex%20device%20login%20web%20service.md) | `server/src/services/codex-vault-login-service.ts`, `server/src/routes/codex-vaults.ts`, `ui/src/pages/InstanceCodexVaults.tsx`, `ui/src/api/codexVaults.ts`, `packages/adapters/codex-local/src/server/{codex-vault,host-login-pty}.ts` |
| 4 | **Claude credential vaults** — the sibling feature, `/sysops/llm/claude/<name>` and `CLAUDE_CONFIG_DIR` | [`Claude device login web service.md`](CustomCodeDoc/Claude%20device%20login%20web%20service.md) | `server/src/services/claude-vault-login-service.ts`, `server/src/routes/claude-vaults.ts`, `ui/src/pages/InstanceClaudeVaults.tsx`, `ui/src/api/claudeVaults.ts`, `packages/adapters/claude-local/src/server/{claude-vault,claude-host-login-pty}.ts` |
| 5 | **Create agent from a login vault** — a button that opens New Agent with the runtime and the vault directory prefilled | [`Create agent from a login vault.md`](CustomCodeDoc/Create%20agent%20from%20a%20login%20vault.md) | `ui/src/lib/new-agent-preset.ts`, `ui/src/components/CreateAgentFromLoginButton.tsx`, `ui/src/pages/NewAgent.tsx` |
| 6 | **Invite auto-accept guard** — `Boolean(invite) &&` as the first term of `shouldAutoAcceptHumanInvite` | [`Reviewing onboarding process and error messages.md`](CustomCodeDoc/Reviewing%20onboarding%20process%20and%20error%20messages.md), and `ReverseProxyCustomChanges.md` §0.1 #1 | `ui/src/pages/InviteLanding.tsx` |
| 7 | **Startup banner** | — | `server/src/startup-banner.ts` |
| 8 | **Local packaging scripts** | [`builds paperclip.md`](CustomCodeDoc/builds%20paperclip.md) | `scripts/pack-local.sh`, `scripts/reset-local.sh`, `releases/` |
| 9 | **`OPENROUTER_API_KEY` in the ACPX `codex` host-env allowlist** — without it an OpenRouter-backed Codex vault gets an empty auth token and a 401 | §8 Session 12, Finding 2 | `packages/adapter-utils/src/acpx-engine/execute.ts` (`ACPX_INHERITED_PROVIDER_ENV_KEYS`), `packages/adapter-utils/src/acpx-engine/execute-identity.test.ts` |

### 4.1 The three files where fork and upstream both edit

These are the collision points. A merge conflict here is normal and both sides
are almost always kept:

- `server/src/app.ts` — the fork's vault route imports and `api.use(...)` mounts.
- `packages/adapter-utils/src/acpx-engine/execute.ts` — the fork's
  `PAPERCLIP_CODEX_HOME` resolution and its provenance log line.
- `packages/adapters/codex-local/src/server/execute.ts` — the same override on
  the Codex CLI lane.

A fourth collision point was added in Session 12:
`server/src/__tests__/openapi-routes.test.ts` — the fork's `codex-vaults.ts` and
`claude-vaults.ts` entries in `explicitOpenApiCoverageExclusions`. An upstream
rewrite of that set drops them silently and the suite goes red naming both files.

Change set 9 lives in the first of these too: the fork's `OPENROUTER_API_KEY`
entry sits inside upstream's `ACPX_INHERITED_PROVIDER_ENV_KEYS` table, so an
upstream edit to that table is a likely conflict — and, worse, a *silent* loss if
upstream rewrites the table wholesale. The regression guard in
`execute-identity.test.ts` is what turns that into a red test instead of a 401.

---

## 5. Taking the upstream merge

**This section exists because the GitHub PR route stops working.** The fork's
normal sync is a GitHub pull request from `paperclipai/paperclip` into the fork
(`Merge pull request #NN from paperclipai/master`, PRs #24–#31). When that route
stalls, the merge has to be done locally, and the questions below get asked every
time. **The answers are recorded here so they are not re-litigated.**

### 5.1 The decided path — use this unless told otherwise

> **Decided 2026-08-29 (session 2).** Both questions came up during a stuck
> merge; these are the operator's answers, to be treated as the default from now
> on.

| Question | **The answer** | Why |
| --- | --- | --- |
| Which master gets merged? | **Upstream `paperclipai/master`** | "The master from the fork" means *the project we forked from*, not `origin/master`. `origin/master` is the fork's own master and normally lags the working branch. |
| How is upstream reached? | **One-shot fetch, no remote added** | Keeps `.git/config` untouched. A persistent `upstream` remote was explicitly declined. |

**Do not add an `upstream` remote.** `SYNC-2026-08-27.md` §2 records one being
added in an earlier session; that is not the current preference. Fetch by URL.

> **`origin` is confusing — read this before assuming.** The fork's `origin`
> mirrors *upstream's* branch names too (hundreds of `PAP-*`, `PAPA-*`,
> `codex/*`, `release/*` refs). It is easy to conclude upstream is already
> available locally. It is not: **`origin/master` is the fork's master**, and
> there is no local ref for upstream's master at all. That is exactly why the
> fetch is needed.

### 5.2 The commands

```bash
# 0. Confirm a clean tree and the right branch. Never merge onto a dirty tree.
git status --short
git branch --show-current

# 1. A rollback point. Cheap, local, and the only thing that makes step 3 safe.
git tag -f pre-merge-backup-$(git branch --show-current) HEAD

# 2. One-shot fetch. No remote is added; the result lands in FETCH_HEAD.
git fetch https://github.com/paperclipai/paperclip.git master
git log -1 --format='%h %ad %s' --date=short FETCH_HEAD

# 3. See what is coming, and confirm the merge base is the tip taken last time.
git merge-base HEAD FETCH_HEAD          # expect the previous merge's upstream tip
git log --oneline --no-merges HEAD..FETCH_HEAD
git diff --stat HEAD FETCH_HEAD | tail -3

# 4. Preview conflicts WITHOUT touching the working tree.
git merge-tree --write-tree --name-only HEAD FETCH_HEAD
#   exit 0 = clean, exit 1 = conflicts, and the output names every file.

# 5. Merge, holding the commit so the result can be reviewed first.
git merge --no-ff --no-commit FETCH_HEAD
git status --short | grep -E '^(UU|AA|DU|UD|DD|AU|UA)'
```

**Step 4 is the one worth keeping.** `git merge-tree` answers "where can this not
be merged?" before anything is modified, which is usually the question actually
being asked. It needs no cleanup and cannot fail halfway.

**Rollback, if it goes wrong:**

```bash
git merge --abort                                    # mid-merge
git reset --hard pre-merge-backup-<branch>           # after the merge commit
```

### 5.3 Resolving conflicts — the standing rule

**Keep both sides.** Every conflict this fork has hit across four sessions has
been *adjacency*, not semantics: the fork's lines and upstream's lines landing at
the same place in a file neither side restructured. None has yet required
choosing one side over the other.

Label the fork's half when resolving, so the next merge can tell what is carried:

```gitignore
.herenow
# Fork-carried: local release bundles produced by scripts/pack-local.sh
releases/local/
.vercel/
```

If a conflict ever *is* semantic — both sides changing the same logic — stop and
raise it. Do not pick a side unilaterally.

### 5.4 Do not commit the merge without being asked

The merge is left staged and uncommitted for review. The operator commits.
The tree is fully usable in this state: typecheck and the test suite both run
normally against a staged merge.

---

## 6. Reviewing what came in


### 6.1 Establish what came in

When `HEAD` is the merge commit, its second parent is the upstream tip:

```bash
git log --oneline --graph -20
UPSTREAM_TIP=$(git rev-parse HEAD^2)          # e.g. 35fca9562
PREV_MERGE=$(git log --merges --format=%H -2 | tail -1)

# the upstream commits this merge brought in
git log --oneline --no-merges "$PREV_MERGE".."$UPSTREAM_TIP"

# what each one touched — use --format= to suppress the (very long) PR bodies
git show --stat --format= --find-renames <sha>
```

### 6.2 Establish what the fork still carries

```bash
git diff --stat "$UPSTREAM_TIP" HEAD
```

Everything in that list is fork-carried. Cross-check it against §4: every change
set should be represented. A change set that has *vanished* from this list is the
alarm — it was lost in the merge.

### 6.3 Decide whether anything must be re-applied

```bash
git merge-base --is-ancestor ddcd436f5 HEAD && echo "add-on already carried — do NOT cherry-pick"
```

In the merge-into-a-working-branch workflow this always passes and **nothing is
re-applied**. Only a fresh re-branch from upstream needs
`ReverseProxyCustomChanges.md` §0.

### 6.4 Read the upstream changes against §4

For each incoming commit, ask the three questions in order:

1. **Does it touch a file §4 lists?** If yes, read the merged file and confirm
   *both* sides are present — the fork's hunk and upstream's.
2. **Does it rename or move a module the fork imports?** Upstream renames
   modules regularly. After a rename, search for dangling references:
   ```bash
   grep -rn "<old-module-name>" --include='*.ts' --include='*.tsx' --include='*.cjs' \
     server/src ui/src cli/src packages
   ```
   No hits means every consumer moved with it.
3. **Does it generalise a mechanism the fork built privately?** Upstream
   periodically lands its own version of something the fork already carries. That
   is not a break, but it is a convergence opportunity worth recording in §7 —
   the fork patch may eventually be retired in favour of upstream's.

### 6.5 Verify the merge kept both sides in the §4.1 collision files

```bash
grep -n "managedCodexHomeOverride\|PAPERCLIP_CODEX_HOME" packages/adapter-utils/src/acpx-engine/execute.ts
grep -n "codexVault\|claudeVault" server/src/app.ts server/src/routes/index.ts
```

---

## 7. The test procedure

### 7.1 Run the full suite — one group per process

> **Do not use `pnpm run test:run` on this host.** It aborts after the first
> failing group and the remaining three never execute. See the box below.

```bash
SC=/tmp/paperclip-tests; mkdir -p $SC
CLEAN="env -u PAPERCLIP_CODEX_HOME -u PAPERCLIP_PUBLIC_URL -u PAPERCLIP_TELEMETRY_DISABLED"  # see 7.5 #2

corepack pnpm --filter @paperclipai/plugin-sdk ensure-build-deps  # see 7.5 #1

$CLEAN node scripts/run-vitest-stable.mjs --mode general --group general-server      > $SC/g1.log 2>&1
$CLEAN node scripts/run-vitest-stable.mjs --mode general --group general-workspaces-a > $SC/g2.log 2>&1
$CLEAN node scripts/run-vitest-stable.mjs --mode general --group general-workspaces-b > $SC/g3.log 2>&1
$CLEAN node scripts/run-vitest-stable.mjs --mode serialized                           > $SC/g4.log 2>&1

grep -hE "Test Files|Tests  " $SC/g*.log
```

Four separate processes, so one group's failures cannot suppress the others.
Budget ~30 min for `general-server` alone.

> ### The trap: `test:run` stops at the first failing group
>
> [`run-vitest-stable.mjs:298-300`](scripts/run-vitest-stable.mjs#L298-L300) is a
> hard exit inside the per-invocation helper:
>
> ```js
> if (result.status !== 0) {
>   process.exit(result.status ?? 1);
> }
> ```
>
> [`runGeneralSuites`](scripts/run-vitest-stable.mjs#L304) loops the groups
> calling it, so **the first failing group terminates the whole run** and groups
> 2-4 never start.
>
> On this host `general-server` *always* fails — the environmental failures in
> 7.5 #3 and #4 guarantee it. So `pnpm run test:run` can never reach
> `@paperclipai/ui`, the CLI, or the ~140 serialized suites. **Five of the eight
> change sets in §4 have their tests in `general-workspaces-a`**, which means the
> default command has never once exercised most of the fork's own code.
>
> The tell is the log: one `[test:run]` banner line means one group ran. Four
> banner lines means the suite actually completed.
>
> #### It also masks *projects within* a group — not just later groups
>
> Discovered 2026-08-30 (Session 12), and it changes how a group's numbers must
> be read. `general-workspaces-a` contains **two** vitest projects,
> `@paperclipai/ui` and `paperclipai` (the CLI). They report separate summary
> blocks, and the abort applies between them too: when the UI project failed,
> the run exited and **the CLI project never executed at all** — 0 of its 426
> tests. The group still printed a confident-looking
> `Test Files 1 failed | 503 passed` line, which is the UI project alone.
>
> That number is not the group. Fixing the single UI failure revealed a CLI
> failure (§7.5 #2b-2) that had been invisible for an unknown number of sessions.
>
> **Count the summary blocks, not just the banners.** `general-workspaces-a`
> must print **two** `Test Files` blocks. One block means a project was skipped
> and the group's result is incomplete, however green it looks:
>
> ```bash
> grep -cE '^ Test Files' $SC/g2.log     # expect 2 for general-workspaces-a
> ```
>
> #### `--mode serialized` is the worst case: it truncates per *file*
>
> [`runSerializedSuites`](scripts/run-vitest-stable.mjs#L380) loops the 140
> suites calling `runVitest` **once per file**, and `runVitest` exits the process
> on any non-zero status. **One failing suite therefore abandons every suite
> after it**, in `localeCompare` order.
>
> Measured 2026-08-30 (Session 12): the group stopped at
> `heartbeat-process-recovery.test.ts`, which is suite **60 of 140**. The other
> **80 suites (57%) never ran** — and the group's printed
> `Tests 1 failed | 110 passed` is only that last file's tally, not the group's.
> A reader who takes that line as the serialized result overstates coverage by
> more than half.
>
> **Get the real list and the real coverage:**
>
> ```bash
> # the authoritative 140-suite list, straight from the runner
> node scripts/run-vitest-stable.mjs --mode serialized --dry-run \
>   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>\
>       console.log(JSON.parse(s).selectedSerializedSuites.join("\n")))' \
>   > /tmp/serial-files.txt
>
> # run every one in its own process, WITHOUT the abort
> while IFS= read -r f; do
>   $CLEAN corepack pnpm exec vitest run --project @paperclipai/server \
>     "$f" --pool=forks --isolate > "/tmp/logs/$(echo "$f" | tr / _).log" 2>&1
>   printf '%s\t%s\n' "$?" "$f" >> /tmp/serial-results.tsv
> done < /tmp/serial-files.txt
> ```
>
> `--shard-index`/`--shard-count` do **not** solve this: each shard still aborts
> on its own first failure. Sharding narrows the loss, it does not remove it.
>
> **Consequence for this document.** Every serialized result recorded before
> Session 12 was truncated at its first failure by an unrecorded amount. Treat
> pre-Session-12 serialized tallies as lower bounds, not coverage.


`scripts/run-vitest-stable.mjs` splits the work rather than running one flat
vitest. Its modes:

| Mode | What it runs |
| --- | --- |
| `--mode all` (default, what `test:run` uses) | everything, group by group |
| `--mode general` | the parallel-safe suites, in three groups: `general-server` (server suites *excluding* the serialized ones), `general-workspaces-a` (`@paperclipai/ui`, `paperclipai`), `general-workspaces-b` (the remaining non-server workspaces) |
| `--mode serialized` | the ~140 server suites that must not run concurrently |

`--shard-index` / `--shard-count` are accepted for `serialized`,
`general --group general-server` and `general --group general-workspaces-a`;
shard durations come from `scripts/general-server-shard-durations.json` and
`scripts/serialized-shard-durations.json`. Use sharding to re-run a slice
quickly; use the four-process form above for the result that gets recorded.

The suite is long-running and vitest buffers heavily when stdout is not a TTY —
a log that has not grown for several minutes is normal, not a hang. Confirm with
`ps aux | grep [v]itest`.

### 7.2 Targeted suites — run these when §4 is in question

```bash
# fork change set 1 — reverse proxy / forward auth
corepack pnpm exec vitest run server/src/auth/proxy-header-auth.test.ts \
  server/src/middleware/proxy-header-actor.test.ts \
  server/src/__tests__/proxy-header-auth.integration.test.ts

# change sets 3 and 4 — credential vaults
corepack pnpm exec vitest run server/src/__tests__/codex-vault-login-service.test.ts \
  server/src/__tests__/claude-vault-login-service.test.ts \
  packages/adapters/codex-local/src/server/codex-vault.test.ts \
  packages/adapters/claude-local/src/server/claude-vault.test.ts

# change set 2 — PAPERCLIP_CODEX_HOME
corepack pnpm exec vitest run packages/adapters/codex-local/src/server/codex-home.test.ts \
  packages/adapter-utils/src/server-utils.test.ts

# change set 5 — create agent from a vault
corepack pnpm exec vitest run ui/src/lib/new-agent-preset.test.ts ui/src/pages/NewAgent.test.tsx

# change set 6 — invite auto-accept guard (18/18 expected)
corepack pnpm exec vitest run ui/src/pages/InviteLanding.test.tsx

# change set 9 — OPENROUTER_API_KEY reaches the codex launch env (9/9 expected)
corepack pnpm exec vitest run \
  packages/adapter-utils/src/acpx-engine/execute-identity.test.ts
```

**Change set 9 has an out-of-band check too**, because the failure is a runtime
401 rather than a type error. Against the real vault:

```bash
CODEX_HOME=/sysops/llm/openrouter/default \
  /vhome/paperclip/node_modules/.bin/codex exec --skip-git-repo-check \
  "Reply with exactly: PONG"
```

Expect `provider: openrouter` and `PONG`. Re-run it with
`env -u OPENROUTER_API_KEY` to see the failure mode the allowlist entry prevents:
`provider auth command 'sh' produced an empty token`, then `401 Unauthorized`.

### 7.3 Typecheck

```bash
corepack pnpm run typecheck
```

A rename upstream made that the fork did not follow shows up here rather than in
the tests.

### 7.4 Known-failure register

**A failure is not automatically the fork's fault.** Classify every one before
recording it:

| Class | How to tell | What to do |
| --- | --- | --- |
| **Fork-caused** | The failing assertion names a §4 file, or the test passes when the fork hunk is reverted | Fix it, or record it here with the reason it is being left |
| **Upstream copy drift** | The failure is a stale expected *string*, not behaviour — e.g. `"company"` → `"organization"` | Update the fork's expected literal; do not touch the guard being tested |
| **Environmental** | Port contention, embedded-Postgres startup, timing/flake; passes on a re-run of that suite alone | Record it as environmental with the re-run result |
| **Pre-existing upstream** | Fails on `$UPSTREAM_TIP` too — check with `git stash` + `git checkout $UPSTREAM_TIP` in a scratch worktree | Record it; it is upstream's, not ours |

Record every non-passing suite in the session entry (§7) with its class, even
when it is not ours. The value of the register is that a failure appearing twice
is recognised as standing rather than re-investigated from scratch.

---

### 7.5 Prerequisites and traps — read before believing a failure

Four things have produced confusing failures that were **not** real defects.
Check each before investigating a red suite.

#### 1. Build the plugin SDK first, or 12 suites collect nothing

```bash
corepack pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
```

`packages/plugins/sdk/dist/` does not exist after a fresh install. Without it,
twelve server suites fail at *import* time with:

```
Error: Failed to resolve entry for package "@paperclipai/plugin-sdk".
Error: Cannot find package '@paperclipai/plugin-sdk/testing'
```

They report **`(0 test)`**, not assertion failures — that is the signature.
`test:run:general` and `test:run:serialized` run `ensure-build-deps` themselves;
**plain `test:run` does not.** Affected: `plugin-worker-manager`,
`plugin-worker-manager-duplex`, `plugin-database`, `plugin-install-autobuild`,
`plugin-install-guard`, `plugin-loader-error-retry`, `plugin-lifecycle-restart`,
`plugin-sdk-testing`, `plugin-environment-driver-ready-recovery`,
`environment-test-harness`, `app-hmr-port`, `app-private-hostname-gate`,
`app-vite-dev-routing`, `feedback-flush-controller`.

#### 2. The deployment's own `PAPERCLIP_*` env leaks into the tests

```bash
env -u PAPERCLIP_CODEX_HOME corepack pnpm run test:run
```

**This is the most important line in this document.** The container exports
`PAPERCLIP_CODEX_HOME=/sysops/llm/openrouter/default` for the running
deployment. `server/src/__tests__/codex-local-execute.test.ts` builds a hermetic
sandbox — it redirects `HOME`, `PAPERCLIP_HOME`, `CODEX_HOME`, and deletes
`PAPERCLIP_INSTANCE_ID` and `PAPERCLIP_IN_WORKTREE` — but it **never touches
`PAPERCLIP_CODEX_HOME`**, because that variable does not exist upstream. It is
ours.

So the fork's override does its job and redirects the "managed home" *out of the
sandbox and onto the real vault*. What then happens to `/sysops/llm/openrouter/default`:

| Artifact | Where it comes from |
| --- | --- |
| `auth.json` → a vitest temp dir | `ensureSymlink` from the test's throwaway `CODEX_HOME`; **dangles** once vitest cleans up |
| `skills/paperclip` → the source checkout | the skill injection |
| `config.toml` re-staged, mode `0644` → `0600` | `ensureCopiedFile` |
| A `# BEGIN PAPERCLIP MANAGED MCP` block with a fake `pcgw_*` bearer | written by the MCP test, removed by a later test in the same file |

The visible symptom is three `codex-local-execute` assertion failures reading
`expected '/sysops/llm/openrouter/default' to be '/tmp/…'`. That message *is* the
tell.

**Production never does this**, because [`codex-home.ts:759`](packages/adapters/codex-local/src/server/codex-home.ts#L759)
is `if (!(await pathExists(source))) continue;` and the real source home has no
`auth.json` — the vault authenticates through `OPENROUTER_API_KEY` in its
`config.toml`. Only a test that plants an `auth.json` triggers the symlink.

**Forensic tell, if it happens again:** the vitest temp root is named by
[`run-vitest-stable.mjs:278`](scripts/run-vitest-stable.mjs#L278) as
`pcvt-<pid>-<invocation>-<rand>` (**p**aper**c**lip **v**i**t**est). A symlink
pointing into a `pcvt-*` path was made by a test run, never by the image or the
deployed server. A `skills/` entry pointing at `/Projects/paperclip/...` rather
than `/install/paperclip-release/...` says the same thing.

##### 2b. `PAPERCLIP_PUBLIC_URL` — two OAuth origin tests

Same class, found the same session. `server/src/__tests__/tool-access-service.test.ts`
stubs `PAPERCLIP_PUBLIC_URL` for most of its OAuth cases, but **two rely on it
being absent** and stub only the Slack client id/secret:

- `normalizes a direct numeric loopback origin for OAuth when no public URL is configured`
- `does not derive an OAuth callback origin from a non-loopback request host`

The container exports `PAPERCLIP_PUBLIC_URL=https://dev01.vps06.bringyouraito.life`,
so the code takes the configured-public-URL branch: the first test gets that host
instead of `http://localhost:3200/...`, and the second gets a `201` where it
expects `422 oauth_redirect_origin_unsupported`. The test names are the tell —
both say *"no public URL is configured"*.

Verified: with the variable cleared, all 30 OAuth cases in that file pass.

##### 2b-2. `PAPERCLIP_TELEMETRY_DISABLED` — the CLI telemetry suite

Found 2026-08-30 (Session 12), and the first one found in the **CLI** package
rather than the server. `cli/src/__tests__/telemetry.test.ts` →
`creates telemetry state only after the first event is tracked` asserts
`expect(client).not.toBeNull()`, but
[`shared/src/telemetry/config.ts:71`](packages/shared/src/telemetry/config.ts#L71)
returns `{ enabled: false }` whenever `PAPERCLIP_TELEMETRY_DISABLED === "1"`, so
`initTelemetry({ enabled: true })` hands back `null`.

The suite's `beforeEach` **does** scrub the environment — but only the five CI
variables (`CI`, `CONTINUOUS_INTEGRATION`, `BUILD_NUMBER`, `GITHUB_ACTIONS`,
`GITLAB_CI`). The container exports `PAPERCLIP_TELEMETRY_DISABLED`, which is not
on that list. The tell is the assertion message: `expected null not to be null`.

Verified: with the variable cleared, both cases pass.

##### 2c. Treat this as a class, not two bugs

The container exports ~24 `PAPERCLIP_*` variables for the live deployment and the
suite assumes a clean environment. **Three have bitten so far** —
`PAPERCLIP_CODEX_HOME`, `PAPERCLIP_PUBLIC_URL`, and now
`PAPERCLIP_TELEMETRY_DISABLED`. `PAPERCLIP_DEPLOYMENT_MODE=authenticated`,
`PAPERCLIP_PROXY_AUTH_ENABLED=true`, `PAPERCLIP_ALLOWED_HOSTNAMES` and
`PAPERCLIP_CONFIG` remain plausible next candidates.

> The third one is the reason to read this as a standing class rather than a
> list. It was not on the predicted-candidates list above, it lives in a
> different workspace package from the first two, and it surfaced only once an
> unrelated fix stopped masking its project (§7.1). Assume more exist.

Upstream already knows the class exists — [`run-vitest-stable.mjs:287`](scripts/run-vitest-stable.mjs#L287)
explicitly overrides `PAPERCLIP_HOME` and `TMPDIR` to sandbox paths before
spawning vitest. It just does not clear the rest.

**When a new failure's assertion mentions a host, URL, path, or mode that matches
something in `env | grep PAPERCLIP_`, suspect this first.** Confirm by re-running
that one file with the variable cleared before investigating anything else.

> **Upstream candidate.** Adding `delete process.env.PAPERCLIP_CODEX_HOME` to
> that suite's setup would make it honest, but it becomes another fork-carried
> patch to re-apply. `env -u` costs nothing and is the current answer.

#### 3. Upstream ships stale lockfiles — regenerate, do not fight it

```
ERR_PNPM_OUTDATED_LOCKFILE
specifiers in the lockfile don't match specs in package.json
```

Upstream lands `package.json` dependency changes without regenerating
`pnpm-lock.yaml`, usually from stacked PRs. It has happened repeatedly — #12318,
#12461, #12464, #12484 are all lockfile repairs, and it recurred immediately
after in #12339 (`agentmail`).

**The answer (decided 2026-08-29):**

```bash
corepack pnpm install --no-frozen-lockfile
```

This is exactly what upstream's own `chore(lockfile): refresh pnpm-lock.yaml`
commits do. It leaves a fork-carried delta in a **generated** file, which
upstream's next refresh overwrites — low friction, and not a change set worth
adding to §4. Do **not** hand-edit `package.json` to remove the dependency; that
is a real fork-carried change with no upside.

Afterwards, re-confirm the patches survived:

```bash
ls node_modules/.pnpm | grep -E 'embedded-postgres@|acpx@'
```

#### 4. Some failures are the machine, not the merge

`workspace-runtime*` and `local-service-supervisor` bind real ports, spawn
process trees and negotiate HTTPS exposure. `workspace-runtime.test.ts` alone has
a 123 s baseline in `general-server-shard-durations.json`; under load it takes
~220 s and sheds tests. `cursor-local-*` fails with exit **127** because
`cursor-agent` is not installed in the image. None of these are fork-touched
files. Re-run a suspect suite alone before classifying it.

---

## 8. Session log — append only


> **Numbering note.** The header at the top of this file calls the session log
> "§7". It is this section, **§8** — §7 is the test procedure. Kept as-is so old
> cross-references still resolve; read "§7 session log" as this section.

### 2026-08-30 — Session 12: verify the fork on `W4-20260830b` (upstream merges #33, #34, #35)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Branch:** `W4-20260830b` @ `a32055fd3`, upstream tip `001428a2d`.
**Scope:** the branch carries merges #33/#34/#35 on top of the last recorded
verification (Session 11, `W4-20260828b`, merge #29) — 111 non-merge commits.
The merge was already committed via the GitHub PR route; no local merge was
needed and **nothing was re-applied** (the §6.3 ancestor check case).

**Outcome: the merge broke nothing the fork carries, but it did break OpenRouter,
and it exposed a latent fork bug that had never been run.**

#### What came in

37 of the incoming commits are one upstream campaign: a native **`paperclip-runner`**
package plus an **ACPX profile boundary**. This is the §6.4 question-3 case —
upstream building its own version of ground the fork already occupies.

#### Register check (§4) — all intact

All 30 register files present. All three §4.1 collision files kept both sides.
All five `resolveManagedCodexHomeOverride` read sites present (line numbers have
drifted from `Codex-changes-instructions.md` §3A.3: heartbeat 1190→1337,
acpx-engine 1036→1217, codex-local execute 646→651). Only one register file was
touched by the incoming commits — `acpx-engine/execute.ts`, by #12387, purely
additive and nowhere near the fork's block.

| Change set | Suite | Result |
| --- | --- | --- |
| 1 reverse-proxy auth | 3 files | 28/28 |
| 2 `PAPERCLIP_CODEX_HOME` | `codex-home` + `server-utils` | 171/171 |
| 3+4 credential vaults | 4 files | 83/83 |
| 5 create-agent-from-vault | 2 files | 18/18 |
| 6 invite auto-accept guard | `InviteLanding` | 18/18 |
| `pnpm run typecheck` | all workspaces | clean, exit 0 |

#### Full suite — all four groups run to completion

| Group | Tests | Failures |
| --- | --- | --- |
| `general-server` | 5279 passed | 39 |
| `general-workspaces-a` | 4824 passed (UI only — see below) | 1 |
| `general-workspaces-b` | 73 passed | 0 |
| `serialized` | **truncated at suite 60 of 140** — see Finding 6 | 1 |

**Known-failure classification (§7.4):**

- **Environmental (36).** `workspace-runtime*` (32, ports/HTTPS exposure; one
  took 74 s), `cursor-local-*` (3, `cursor-agent` absent), `local-service-supervisor`
  (1), `plugin-worker-manager-duplex` (1, `DUPLEX_CHANNEL_OPEN_FAILED`). All seven
  files carry **zero** fork delta. Matches §7.5 #4.
- **Pre-existing upstream, flaky (1).** `heartbeat-process-recovery` →
  `reaps orphaned descendant process groups…` expects 2 heartbeat runs, gets 3.
  **Reproduced on a clean `001428a2d` worktree** with no fork code (passed run 1,
  failed run 2 — it is nondeterministic on this host, so a single green run is not
  evidence). Not ours.
- **Fork-caused (1) — fixed this session.** See Finding 3.

> **Two of the four rows above are incomplete, and that is Finding 6.** The
> abort-on-first-failure in `run-vitest-stable.mjs` fires *inside* a group, not
> only between groups:
>
> - `general-workspaces-a` holds two vitest projects. The UI failure aborted the
>   run before the `paperclipai` CLI project started, so 426 CLI tests never
>   executed and "4824 passed" is the UI project alone.
> - `serialized` loops **per file**. It stopped at suite 60 of 140, so 80 suites
>   never ran, and "110 passed" is only the last file's tally.
>
> Both were re-run to real completion afterwards. See Finding 6.

#### Finding 1 — upstream stale lockfile, patch-hash variant (§7.5 #3 recurrence)

`--frozen-lockfile` failed with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. Cause:
`0834a0c1f` (#12387) edited `patches/acpx@0.12.0.patch` **without regenerating
`pnpm-lock.yaml`**. The fork has zero delta on `package.json`, `pnpm-lock.yaml`
and `patches/`, so this is purely upstream's. Fixed with the documented
`corepack pnpm install --no-frozen-lockfile`; the delta is 3 lines (the acpx
hash only). `embedded-postgres` hash unchanged at
`55uhvnotpqyiy37rn3pqpukhei`, so the database suites' patch is unaffected.

> **New sub-case for §7.5 #3.** The trap previously described only *specifier*
> drift. A changed **patch file** produces the same class of failure with a
> different error string. Same answer.

#### Finding 2 — OpenRouter broken on the ACP lane (new fork-carried fix)

**Symptom:** Codex agents backed by the OpenRouter vault fail with
`provider auth command 'sh' produced an empty token` → `401 Unauthorized`.

**Cause:** #12387 added `projectAcpxInheritedHostEnvironment()` to the *shared*
ACP lane — a per-agent allowlist applied to the host env before the child spawn.
Before it, the lane spawned with `{ ...process.env, ...env }` (full passthrough).
`ACPX_INHERITED_PROVIDER_ENV_KEYS.codex` listed `OPENAI_API_KEY` and
`CODEX_API_KEY` but **not** `OPENROUTER_API_KEY` — upstream lists that key only
under `pi`, because upstream's Codex lane never targets a custom `model_provider`.
Ours does: `/sysops/llm/openrouter/default/config.toml` authenticates with
`command = "sh"; args = ["-c", 'printf %s "$OPENROUTER_API_KEY"']`, and that
command runs **inside the spawned child**.

`codex-local/src/server/acp.ts:161` sets `agent: "codex"`, so the Codex ACP lane
lands in exactly the wrong bucket. The CLI lane is **unaffected** —
`codex-local/src/server/execute.ts:1025` still does full passthrough.

**Verified against the real vault**, not by reading alone:

| Child env | Result |
| --- | --- |
| key absent (what the merged ACP lane produced) | `empty token` → 401 |
| key present | provider `openrouter`, model `openai/gpt-5.6-luna`, reply `PONG`, exit 0 |

**Fix (operator's choice, 2026-08-30): the one-line allowlist patch.** Adds
`OPENROUTER_API_KEY` to the `codex` set. Restores the existing global
deployment model with no per-agent configuration.

**This is a new fork-carried change — register it as change set 9** (see §4).
It lives in a §4.1 collision file, so expect it to need re-applying.

The rejected alternative remains valid as a migration target: adapter/agent
config env is merged **after** the projection and is never filtered
(`isForbiddenConfigEnvKey` blocks only `PAPERCLIP_API_KEY`), so binding
`OPENROUTER_API_KEY` as a company secret on each agent also works and carries no
fork patch. Retire change set 9 if that migration ever completes.

> **Also note:** `startup-banner.ts:138` reads `OPENROUTER_API_KEY` from the
> **server's** env, so the banner printed green throughout this outage. It is not
> evidence the key reaches an agent.

#### Finding 3 — fork-caused clipboard bug (pre-existing, fixed)

`ui/src/lib/clipboard-usage.test.ts` flagged `InstanceCodexVaults.tsx` and
`InstanceClaudeVaults.tsx` for calling `navigator.clipboard.writeText` directly
instead of `copyTextToClipboard` from `ui/src/lib/clipboard.ts`.

**Not caused by this merge** — the guard test dates to #10875 and both pages
violated it on `W4-20260828b` too. It had never been *seen* because
`general-workspaces-a` had never run to completion: this is the §7.1 `test:run`
trap, and this session is the first time the fork's own UI group finished.

It is a real bug, not a lint. The helper exists precisely because on a
non-secure context — which is what the fork's reverse-proxied deployment is —
`navigator.clipboard.writeText` can resolve **without copying** while the toast
reports success. These two pages exist to hand operators device-login codes.

Fixed: both now call `copyTextToClipboard`.

#### Finding 4 — convergence risk to record, no action yet

Upstream's new `packages/paperclip-runner` carries its own Codex/ACPX lane whose
sandbox sets `CODEX_HOME` (and, for Claude, `CLAUDE_CONFIG_DIR`) to a
sandbox-owned directory unconditionally, and whose env sanitizer
(`drivers/acpx/environment.ts`) strips everything outside a fixed allowlist
containing neither `PAPERCLIP_CODEX_HOME` nor `CODEX_HOME`.

**Change sets 2, 3 and 4 would silently not apply to that lane.** Nothing is
broken today: the lane needs `adapterType === "paperclip_runner"` *and* an enable
flag that defaults to `false` (`routes/adapters.ts:285`), and `paperclip_runner`
is force-added to the disabled set otherwise. Re-check this on every merge — if
that flag ever defaults on, the vault features stop applying without any test
going red.

#### Finding 5 — a third `PAPERCLIP_*` env leak (§7.5 #2 class)

Revealed once Finding 3's fix stopped masking the CLI project.
`cli/src/__tests__/telemetry.test.ts` →
`creates telemetry state only after the first event is tracked` fails with
`expected null not to be null`: the container exports
`PAPERCLIP_TELEMETRY_DISABLED`, `resolveTelemetryConfig()` short-circuits to
`{ enabled: false }`, and `initTelemetry()` returns `null`. The suite scrubs the
five CI variables but not this one.

Environmental, not ours — zero fork delta, and it passes 2/2 with the variable
cleared. **The standard `CLEAN` prefix in §7.1 now clears it**, and §7.5 gained
sub-section 2b-2. This is the third confirmed member of a class the doc already
predicted would grow; it was not on the predicted list and it lives in a
different workspace package from the first two.

#### Finding 6 — the suite has been under-running for an unknown number of sessions

The §7.1 trap was known to stop *later groups*. It also stops work **inside** a
group, which was not known and which invalidates part of this session's own
first-pass numbers:

| Group | Believed | Actual |
| --- | --- | --- |
| `general-workspaces-a` | 4825 tests, 1 failure | UI project only; the `paperclipai` CLI project (59 files, 426 tests) **never started** |
| `serialized` | "110 passed, 1 failed" | stopped at suite **60 of 140**; **80 suites never ran**, and the quoted line is one file's tally |

Mechanism: [`runVitest`](scripts/run-vitest-stable.mjs#L298) calls
`process.exit()` on any non-zero status.
[`runProjectGroup`](scripts/run-vitest-stable.mjs#L309) loops *projects* through
it and [`runSerializedSuites`](scripts/run-vitest-stable.mjs#L380) loops
*individual files* through it. So the blast radius is: first failing group kills
later groups, first failing project kills later projects, first failing
serialized suite kills the remaining ~half of the serialized lane.

This is why both new failures this session appeared only *after* an unrelated
fix: each fix unblocked a lane that had never executed. Finding 5 had been
sitting behind the clipboard bug.

**Re-run to real completion after the fixes:**

- `general-workspaces-a`: **two** summary blocks, UI 504/504 (4825 tests) and
  CLI 59/59 (426 tests), exit 0.
- `serialized`: swept all 140 suites one process each with the abort removed
  (recipe now in the §7.1 trap box).

§7.1 gained a documented detection recipe and the no-abort sweep. **Treat every
serialized tally recorded before this session as a lower bound, not coverage.**

#### Finding 7 — fork routes missing from the OpenAPI coverage guard (fork-caused, fixed)

**Found only because Finding 6's sweep reached it.** `openapi-routes.test.ts` →
`covers the mounted server routes exactly` is serialized suite **#115**, i.e. 55
suites past the abort point. It has never run in any recorded session.

`loadActualRoutes()` walks `server/src/routes/*.ts` and requires every file
containing a `router.<method>(` to be either in the test's `apiPrefixes` map
(and then fully present in the OpenAPI document) or in
`explicitOpenApiCoverageExclusions`. The fork's `codex-vaults.ts` and
`claude-vaults.ts` are in neither, so they land in `unknownRouteFiles`:

```
- unknownRouteFiles: []
+ unknownRouteFiles: ["claude-vaults.ts", "codex-vaults.ts"]
```

**Fixed by excluding them, not by documenting them.** The OpenAPI document is
upstream's published public contract; these are unpublished, fork-private,
instance-admin endpoints. That is the same rationale the existing entries
(`pipelines.ts`, `cases.ts`, `smoke-lab.ts`) carry. Verified 5/5.

**This is a fork-carried edit in an upstream test file — a new collision point.**
If upstream rewrites that exclusion set, the fork's two lines vanish and this
suite goes red again with the diff above. That diff *is* the tell; it names the
two files directly.

#### Full serialized coverage — the real number

After removing the abort (§7.1 recipe), all **140** suites ran:

| | |
| --- | --- |
| Suites run | 140 / 140 |
| Tests | **1997 passed, 2 failed** |
| `heartbeat-process-recovery` (#60) | pre-existing upstream flake — reproduced on a clean `001428a2d` worktree |
| `openapi-routes` (#115) | fork-caused, **fixed this session** (Finding 7) |

The previously-recorded serialized figure for this branch was "110 passed, 1
failed". The real figure is 1997 tests across 140 suites. That gap is the size of
the Finding 6 blind spot.

#### Changes left in the working tree (uncommitted, per §5.4)

| File | Change |
| --- | --- |
| `pnpm-lock.yaml` | regenerated acpx patch hash (Finding 1) |
| `packages/adapter-utils/src/acpx-engine/execute.ts` | `OPENROUTER_API_KEY` in the `codex` allowlist (Finding 2) |
| `packages/adapter-utils/src/acpx-engine/execute-identity.test.ts` | fork-owned expectation + regression guard (Finding 2) |
| `ui/src/pages/InstanceCodexVaults.tsx` | `copyTextToClipboard` (Finding 3) |
| `ui/src/pages/InstanceClaudeVaults.tsx` | `copyTextToClipboard` (Finding 3) |
| `server/src/__tests__/openapi-routes.test.ts` | vault routes added to the OpenAPI coverage exclusions (Finding 7) |

Post-fix verification: `typecheck` clean; `adapter-utils` 1021/1021;
`codex-local` + `claude-local` 654/655 (1 skipped); fork change sets 280/280;
`clipboard-usage` green; `openapi-routes` 5/5;
`general-workspaces-a` fully green across **both** projects (UI 4825, CLI 426);
serialized swept 140/140 → 1997 passed, 1 failing (the upstream flake).
