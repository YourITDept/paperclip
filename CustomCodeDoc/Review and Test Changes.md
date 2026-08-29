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

### 4.1 The three files where fork and upstream both edit

These are the collision points. A merge conflict here is normal and both sides
are almost always kept:

- `server/src/app.ts` — the fork's vault route imports and `api.use(...)` mounts.
- `packages/adapter-utils/src/acpx-engine/execute.ts` — the fork's
  `PAPERCLIP_CODEX_HOME` resolution and its provenance log line.
- `packages/adapters/codex-local/src/server/execute.ts` — the same override on
  the Codex CLI lane.

---

## 5. The review procedure

### 5.1 Establish what came in

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

### 5.2 Establish what the fork still carries

```bash
git diff --stat "$UPSTREAM_TIP" HEAD
```

Everything in that list is fork-carried. Cross-check it against §4: every change
set should be represented. A change set that has *vanished* from this list is the
alarm — it was lost in the merge.

### 5.3 Decide whether anything must be re-applied

```bash
git merge-base --is-ancestor ddcd436f5 HEAD && echo "add-on already carried — do NOT cherry-pick"
```

In the merge-into-a-working-branch workflow this always passes and **nothing is
re-applied**. Only a fresh re-branch from upstream needs
`ReverseProxyCustomChanges.md` §0.

### 5.4 Read the upstream changes against §4

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

### 5.5 Verify the merge kept both sides in the §4.1 collision files

```bash
grep -n "managedCodexHomeOverride\|PAPERCLIP_CODEX_HOME" packages/adapter-utils/src/acpx-engine/execute.ts
grep -n "codexVault\|claudeVault" server/src/app.ts server/src/routes/index.ts
```

---

## 6. The test procedure

### 6.1 Run the full suite

```bash
corepack pnpm run test:run 2>&1 | tee /tmp/full-test-run.log
```

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
quickly; use the plain command above for the result that gets recorded.

The suite is long-running and vitest buffers heavily when stdout is not a TTY —
a log that has not grown for several minutes is normal, not a hang. Confirm with
`ps aux | grep [v]itest`.

### 6.2 Targeted suites — run these when §4 is in question

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
```

### 6.3 Typecheck

```bash
corepack pnpm run typecheck
```

A rename upstream made that the fork did not follow shows up here rather than in
the tests.

### 6.4 Known-failure register

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

## 7. Session log — append only

