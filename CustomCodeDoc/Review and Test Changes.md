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

> ## RULE 0 — never commit, push, or otherwise check anything in
>
> **This is the operator's standing instruction and it overrides any inference
> you might draw from the task.** It applies to every agent and every session
> that touches this fork, including onboarding runs, and it is not softened by
> "the change is small", "the tests pass", "the procedure says to fix it", or
> the operator having approved a *previous* commit.
>
> **Never run:** `git commit`, `git push`, `git merge --commit`, `git rebase`,
> `git cherry-pick`, `git stash drop`, `git reset --hard`, `gh pr create`,
> `gh pr merge`, or any command that rewrites history or publishes a branch.
>
> **Do instead:** leave every change in the working tree, unstaged, and say
> plainly which files you touched and why. Then stop.
>
> **Why — this is the part worth understanding.** The operator reviews every
> change **visually in the VS Code IDE**, diff by diff. A commit made for them
> destroys that review: the diff collapses into history, an agent's edits become
> indistinguishable from their own, and the one checkpoint that catches a wrong
> call is gone. Leaving work uncommitted is not caution or ceremony — it is what
> makes the review possible at all. An agent that commits "to be helpful" has
> removed the human from the loop.
>
> **Ready-to-commit is the deliverable.** Finish the work completely, leave the
> tree clean of anything unrelated, and hand over a tree the operator can read in
> the IDE and commit themselves. "I have left N files modified, here is what each
> one does" is the correct end state — not "committed".
>
> **If you believe a commit is genuinely required**, stop and ask, naming the
> files and the reason. Explicit authorization for one commit authorizes that
> commit only; it never becomes a standing permission.
>
> Generated files count. A regenerated `pnpm-lock.yaml` is still a change the
> operator reviews and commits, not something to slip in because a tool wrote it.

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

> **Before the prompt below — and before any other reading — open
> [`SESSION-RESUME.md`](CustomCodeDoc/SESSION-RESUME.md).** It is the one file in
> this directory that describes *now* rather than history: the branch, the HEAD,
> what is uncommitted and why, and the single next action. It also carries the
> **disconnection protocol** (added 2026-09-04): when to checkpoint mid-work and
> what to write down before a session ends. Sessions have been dropping; that file
> is how the work resumes without re-deriving it. If its state table disagrees
> with `git status`, **git wins and the file is stale** — say so, then fix it.
>
> This §0 prompt covers an *upstream merge review*. For a bug fix or a feature,
> skip it: read `SESSION-RESUME.md`, open the work item's own document, and
> continue at its **Resume point**.

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

### 0.1 The four things the assistant must not assume

1. **Do not re-apply anything by reflex.** The fork now *merges upstream into a
   long-lived working branch* rather than re-branching from upstream. In that
   workflow the fork's changes are already in history and a cherry-pick would
   duplicate work that is present. Check first — §5.3.
2. **Do not commit, merge, or push — ever, without asking first and getting an
   answer.** The operator commits. Say what changed and stop.

   **This holds even when the operator appears to have told you to.** Phrases
   like *"let's check this in"*, *"go ahead and commit"*, *"let's get this in"*
   or *"push it"* are **not** sufficient authorization on their own. Ask a direct
   yes/no question naming exactly what you would commit, and **wait for the
   answer.** Reaffirmed 2026-09-04 after an assistant read "let's check this in"
   as the ask and made three commits unbidden.

   **It holds even when you have the rights.** Having permission is not the same
   as having been asked, and this project deliberately separates them: the
   operator reviews and validates every change on the way in, and a commit made
   for them removes the step that review depends on. The cost of asking is one
   sentence; the cost of not asking is a history the operator did not choose.

   The same applies to `git merge`, `git push`, `git rebase`, `git reset` and
   anything else that moves a ref or rewrites history. **Prepare the work, report
   it, and stop at the question.**
3. **Do not trust a bare `pnpm -v`.** See §3.3 — the pnpm on `PATH` is *not* the
   pinned version. Use `corepack pnpm` for anything whose result is quoted.
4. **Do not leave the reasoning until the end.** A diff survives a dropped
   connection; *why* a cause was ruled out, what was tried and abandoned, and what
   was deliberately left undone do not. Checkpoint into the work item's document
   as you go — the rule and its triggers are in
   [`SESSION-RESUME.md`](CustomCodeDoc/SESSION-RESUME.md).

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

Two of the files in `CustomCodeDoc/` are navigation rather than content, and are
the ones to open first:

| File | Lifetime | What it answers |
| --- | --- | --- |
| [`SESSION-RESUME.md`](CustomCodeDoc/SESSION-RESUME.md) | **overwritten — the only non-append-only file here** | *Where am I right now?* Branch, HEAD, the uncommitted files and why, the single next action, and the standing disconnection protocol. |
| [`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) | append-only, newest first | *What has this fork changed, and what state is each change in?* One dated entry per work item, with a strict status vocabulary — note that `LIVE-VERIFIED` means watched to work on a running instance, and a green test suite does not earn it. |

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

**Three change sets were retired by the operator in v6 (`88bca7b78`) and are no
longer carried.** They are kept in the table with their original numbers, marked
RETIRED, so the numbered references throughout §8 still resolve. Do not
"restore" them when a merge shows them absent — that is the intended state.
§4.2 says what replaced them.

| # | Change set | Its document | Principal files |
| --- | --- | --- | --- |
| 1 | **Reverse-proxy / forward-auth** — a `proxy_header` actor source resolved from `X-Forwarded-User`, off unless `PAPERCLIP_PROXY_AUTH_ENABLED=true` | [`ReverseProxyCustomChanges.md`](CustomCodeDoc/ReverseProxyCustomChanges.md), [`doc/REVERSE-PROXY-AUTH.md`](doc/REVERSE-PROXY-AUTH.md) | `server/src/auth/proxy-header-auth.ts`, `server/src/middleware/auth.ts`, `server/src/types/express.d.ts`, `server/src/services/authorization.ts`, `server/src/routes/authz.ts`, `server/src/realtime/live-events-ws.ts` |
| 2 | ~~**`PAPERCLIP_CODEX_HOME`** — relocates the Paperclip-*managed* Codex home without opting out of management~~ **RETIRED in v6 — see §4.2** | [`Codex-changes-instructions.md`](CustomCodeDoc/Codex-changes-instructions.md) (historical) | none — removed from `packages/adapter-utils/src/server-utils.ts`, `packages/adapter-utils/src/acpx-engine/execute.ts`, `packages/adapters/codex-local/src/server/{execute,codex-home,acp,test}.ts` |
| 3 | **Codex credential vaults** — provision `/sysops/llm/codex/<name>`, sign in, sign out, delete, from Settings | [`Codex device login web service.md`](CustomCodeDoc/Codex%20device%20login%20web%20service.md) | `server/src/services/codex-vault-login-service.ts`, `server/src/routes/codex-vaults.ts`, `ui/src/pages/InstanceCodexVaults.tsx`, `ui/src/api/codexVaults.ts`, `packages/adapters/codex-local/src/server/{codex-vault,host-login-pty}.ts` |
| 4 | **Claude credential vaults** — the sibling feature, `/sysops/llm/claude/<name>` and `CLAUDE_CONFIG_DIR` | [`Claude device login web service.md`](CustomCodeDoc/Claude%20device%20login%20web%20service.md) | `server/src/services/claude-vault-login-service.ts`, `server/src/routes/claude-vaults.ts`, `ui/src/pages/InstanceClaudeVaults.tsx`, `ui/src/api/claudeVaults.ts`, `packages/adapters/claude-local/src/server/{claude-vault,claude-host-login-pty}.ts` |
| 5 | **Create agent from a login vault** — a button that opens New Agent with the runtime and the vault directory prefilled | [`Create agent from a login vault.md`](CustomCodeDoc/Create%20agent%20from%20a%20login%20vault.md) | `ui/src/lib/new-agent-preset.ts`, `ui/src/components/CreateAgentFromLoginButton.tsx`, `ui/src/pages/NewAgent.tsx` |
| 6 | **Invite auto-accept guard** — `Boolean(invite) &&` as the first term of `shouldAutoAcceptHumanInvite` | [`Reviewing onboarding process and error messages.md`](CustomCodeDoc/Reviewing%20onboarding%20process%20and%20error%20messages.md), and `ReverseProxyCustomChanges.md` §0.1 #1 | `ui/src/pages/InviteLanding.tsx` |
| 7 | ~~**Startup banner** — the Codex Home and OpenRouter rows~~ **RETIRED in v6 — see §4.2** | — | none — rows and helpers removed from `server/src/startup-banner.ts`; `startup-banner.test.ts` deleted |
| 8 | **Local packaging scripts** | [`builds paperclip.md`](CustomCodeDoc/builds%20paperclip.md) | `scripts/pack-local.sh`, `scripts/reset-local.sh`, `releases/` |
| 9 | ~~**`OPENROUTER_API_KEY` in the ACPX `codex` host-env allowlist**~~ **RETIRED in v6 — see §4.2.** The key is now bound per-agent instead of inherited from the host | §8 Session 12, Finding 2 (historical) | none — entry removed from `ACPX_INHERITED_PROVIDER_ENV_KEYS` in `packages/adapter-utils/src/acpx-engine/execute.ts`; guard removed from `execute-identity.test.ts` |
| 10 | **Duplicate agent — retired-key drop and redacted-env restore** — a duplicate drops `runtimeConfig.modelProfiles` (rejected since upstream #12683) and names its source via a new optional `duplicateFromAgentId` so the server can restore `adapterConfig.env` values the client only ever held redacted | [`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md) | `ui/src/lib/duplicate-agent-payload.ts`, `packages/shared/src/validators/agent.ts` (`createAgentSchema`), `server/src/routes/agents.ts` (`restoreDuplicateSourceEnv`, wired into the create **and** hire paths) |

### 4.1 The files where fork and upstream both edit

These are the collision points. A merge conflict here is normal and both sides
are almost always kept:

- `server/src/app.ts` — the fork's vault route imports and `api.use(...)` mounts.
- `server/src/__tests__/openapi-routes.test.ts` — the fork's `codex-vaults.ts`
  and `claude-vaults.ts` entries in `explicitOpenApiCoverageExclusions`. Added
  as a collision point in Session 12. An upstream rewrite of that set drops them
  silently and the suite goes red naming both files.
- `ui/src/pages/NewAgent.tsx` and `ui/src/pages/NewAgent.test.tsx` — change set
  5's preset seeding. Added as a collision point in Session 15, and the first
  **semantic** collision the fork has hit: upstream gates a URL preset on adapter
  availability in an effect, the fork seeds it in the `useState` initializer that
  runs first. The initializer now carries the same gate. Full reasoning in
  [`Create agent from a login vault.md`](CustomCodeDoc/Create%20agent%20from%20a%20login%20vault.md) §8.
  The canary is upstream's own test, `"ignores a native-runner URL preset while
  the experimental adapter is disabled"` — it is load-bearing for the fork now.

- `packages/shared/src/validators/agent.ts` — change set 10's
  `duplicateFromAgentId` on `createAgentSchema`. Added as a collision point
  2026-09-04. Upstream edits this file constantly; the field is one line and easy
  to lose in a conflict resolution.
- `server/src/routes/agents.ts` — change set 10's `restoreDuplicateSourceEnv` and
  its two call sites. Added 2026-09-04. **This is the fork's first change in this
  file**, which is one of upstream's largest and most-churned. The canary is the
  four server tests named in §7.2: if a merge drops the `duplicateFromAgentId`
  destructuring from either route, they go red naming it. Note the two call sites
  are easy to half-resolve — the *hire* path is the one a conflict tends to drop,
  and losing it is silent until a board-approval company duplicates an agent.

**v6 removed two of the four.** `packages/adapter-utils/src/acpx-engine/execute.ts`
and `packages/adapters/codex-local/src/server/execute.ts` were collision points
only because change sets 2 and 9 lived in them. With both retired the fork now
carries nothing in either file, so an upstream change to `ACPX_INHERITED_PROVIDER_ENV_KEYS`
or to Codex home resolution is upstream's business alone — take it as-is.

### 4.2 What v6 retired, and what replaced it

Commit `88bca7b78` ("Looks like we fixed everything… We are now in v6") is a
single-parent commit on the fork branch, not a merge resolution. It deliberately
removed change sets 2, 7, and 9 and rewrote `onboard-paperclip-2.sh` in the same
commit to replace them. The thesis: **bind Codex credentials per-agent instead of
carrying fork patches that make host-level configuration work.**

What that means concretely:

- **A Codex vault is now handed off with a plain `CODEX_HOME`**, the escape hatch
  upstream already supports. Paperclip treats the home as self-managed — it does
  not seed auth, inject skills, merge `PAPERCLIP_CODEX_PROVIDERS`, or rewrite
  `config.toml` — so the vault's own `config.toml` is authoritative for the
  provider. `--model` layers on top as a CLI flag. This is the hand-off that
  change set 2 existed to avoid, now accepted on purpose.
- **`OPENROUTER_API_KEY` is bound as a per-agent `secret_ref`**, not inherited
  from the server environment. Resolved adapter env is merged *after* the ACPX
  host-env projection and is not filtered by it, so a bound key always reaches
  the child process. That is what makes the change set 9 allowlist entry
  unnecessary — and it is stated in `onboard-paperclip-2.sh` at the `ENV_JSON`
  block, which is the authority for this behaviour.
- **The banner rows went with them**, having nothing left to report.

**The one thing this does not cover.** A Codex agent whose OpenRouter key comes
*only* from the host environment — created through the UI, or predating the
script rewrite — now gets an empty auth token and a 401, with no test to catch
it. `pi` still carries `OPENROUTER_API_KEY` in the allowlist; `codex` no longer
does. Every Codex agent must therefore be created by `onboard-paperclip-2.sh`,
or have the key bound to it by hand. Treat a 401 with
`provider auth command 'sh' produced an empty token` as this diagnosis until
proven otherwise.

A second consequence, narrower: the pre-dispatch credential gate in
`heartbeat.ts` lost its provider-aware branch, so a *managed* home routed at a
non-OpenAI provider through `PAPERCLIP_CODEX_PROVIDERS` is now blocked for a
missing `OPENAI_API_KEY` before it ever reaches the merge that would have
configured it. `runtime-config.ts` still performs that merge, so the capability
exists but is unreachable on the managed path. Harmless while every Codex agent
uses an explicit `CODEX_HOME` vault; a dead end if one does not.

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

### 5.4 RULE 0 — do not commit, merge, or push. Ask, and wait for the answer.

The merge is left staged and uncommitted for review. The operator commits.
The tree is fully usable in this state: typecheck and the test suite both run
normally against a staged merge.

**This is not merge-specific.** It governs every change on this project — a merge,
a bug fix, a documentation edit, anything. The operator verifies and validates
each change on the way in, and that step cannot happen after the fact.

**Amended 2026-09-04, at the operator's direction.** The rule now requires an
explicit question, asked by the assistant and answered by the operator, before
any of these:

| | |
| --- | --- |
| `git commit` | including `--amend` |
| `git merge`, `git rebase`, `git cherry-pick` | anything that replays or moves history |
| `git push` | to any remote, any branch |
| `git reset`, `git restore`, `git checkout <ref>` | anything that discards or moves work |

**An instruction that sounds like permission is not permission.** *"Let's check
this in"*, *"go ahead"*, *"let's get this in"*, *"push it"* — treat each as the
start of the conversation, not the end of it. Ask a direct question naming the
exact commits, files, or refs involved, and **wait.**

**Having the rights is not being asked.** The assistant may well be able to
commit. That is precisely why the rule is written down: the constraint is a
review process, not a permissions boundary, and a permissions check will never
enforce it.

**What to do instead:** finish the work, run the checks, report what changed and
what it would take to commit it — then stop on the question. Leaving a clean,
staged, fully-tested tree *is* the deliverable.

> **Why this was reaffirmed.** On 2026-09-04 an assistant read "let's check this
> in" as the ask contemplated by this section and made three commits. The work
> itself was fine and the commits were local, but the operator had not reviewed
> them, which is the entire point. Nothing about the assistant's rights would
> have prevented it — only this rule does.

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
grep -n "codexVault\|claudeVault" server/src/app.ts server/src/routes/index.ts
grep -n "codex-vaults\|claude-vaults" server/src/__tests__/openapi-routes.test.ts
```

The two `execute.ts` greps that used to live here were dropped in v6 along with
change sets 2 and 9 (§4.2). If you find yourself reaching for them, the answer
you want is "nothing fork-carried is in those files any more."

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

# change set 2 — RETIRED in v6 (§4.2). These two suites still exist and still
# pass, but they now cover upstream's Codex home behaviour, not a fork patch.
corepack pnpm exec vitest run packages/adapters/codex-local/src/server/codex-home.test.ts \
  packages/adapter-utils/src/server-utils.test.ts

# change set 5 — create agent from a vault
corepack pnpm exec vitest run ui/src/lib/new-agent-preset.test.ts ui/src/pages/NewAgent.test.tsx

# change set 6 — invite auto-accept guard (18/18 expected)
corepack pnpm exec vitest run ui/src/pages/InviteLanding.test.tsx

# change set 9 — RETIRED in v6 (§4.2). The suite remains; the OPENROUTER_API_KEY
# guard inside it is gone, so it no longer proves anything about the Codex lane.
corepack pnpm exec vitest run \
  packages/adapter-utils/src/acpx-engine/execute-identity.test.ts

# change set 10 — duplicate agent (added 2026-09-04)
# 5/5 and 67/67 expected. The server suite is the §4.1 canary for the fork's
# first change in server/src/routes/agents.ts.
corepack pnpm exec vitest run ui/src/lib/duplicate-agent-payload.test.ts
corepack pnpm exec vitest run \
  server/src/__tests__/agent-permissions-routes.test.ts

# change set 10 also adds a field to createAgentSchema, which feeds the generated
# OpenAPI document. 5/5 expected.
corepack pnpm exec vitest run server/src/__tests__/openapi-routes.test.ts
```

> **`--reporter=basic` is gone in vitest 4.1.11** and fails with
> `Failed to load url basic (resolved id: basic)`. That is a missing reporter, not
> a broken suite — drop the flag and use the default reporter. Noted 2026-09-04
> after it looked briefly like a test-infrastructure failure.

**The out-of-band vault check is now the only check for the OpenRouter path**,
because v6 removed the regression guard that made the failure a red test. The
failure is a runtime 401 rather than a type error, so run this against the real
vault whenever Codex credential wiring is in question:

```bash
CODEX_HOME=/sysops/llm/openrouter/default \
  /vhome/paperclip/node_modules/.bin/codex exec --skip-git-repo-check \
  "Reply with exactly: PONG"
```

> **`/sysops/llm/openrouter/` is not a managed vault.** The vault service owns
> `/sysops/llm/codex` and `/sysops/llm/claude` only (`DEFAULT_CODEX_VAULT_ROOT`,
> `DEFAULT_CLAUDE_VAULT_ROOT` — each overridable with `PAPERCLIP_CODEX_VAULT_ROOT`
> / `PAPERCLIP_CLAUDE_VAULT_ROOT`). The OpenRouter directory is an
> operator-created Codex home that merely lives next door, so it will never appear
> in the vault UI and is not created, validated or deleted by it. Noted 2026-09-04
> as open item O-5 of [`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md).

Expect `provider: openrouter` and `PONG`. Re-run it with
`env -u OPENROUTER_API_KEY` to see the failure mode: `provider auth command 'sh'
produced an empty token`, then `401 Unauthorized`. Under v6 that is also what an
agent looks like when its key was never bound as a `secret_ref` — the host
environment no longer supplies it. Confirm the binding with:

```bash
paperclipai agent get <agent-id> --json | jq '.adapterConfig.env'
```

Expect `CODEX_HOME` as a `plain` value and `OPENROUTER_API_KEY` as a
`secret_ref`. An agent missing the second one will 401 on its first real run.

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

Five things have produced confusing failures that were **not** real defects.
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
env -u PAPERCLIP_PUBLIC_URL -u PAPERCLIP_TELEMETRY_DISABLED corepack pnpm run test:run
```

**The class is the important part of this section; keep reading to 2c.** The
container exports ~24 `PAPERCLIP_*` variables for the live deployment and the
suite assumes a clean environment.

> **The original case here — `PAPERCLIP_CODEX_HOME` — can no longer fire.** v6
> removed every reader of that variable (§4.2); `grep -rn PAPERCLIP_CODEX_HOME`
> over `server/src ui/src cli/src packages scripts` returns nothing. Unsetting it
> is now harmless but pointless. The account below is kept because it is the
> clearest worked example of the class, and because the *contamination it caused*
> is real and may still be on disk — see the forensic tell at the end.

The container exports
`PAPERCLIP_CODEX_HOME=/sysops/llm/openrouter/default` for the running
deployment. `server/src/__tests__/codex-local-execute.test.ts` builds a hermetic
sandbox — it redirects `HOME`, `PAPERCLIP_HOME`, `CODEX_HOME`, and deletes
`PAPERCLIP_INSTANCE_ID` and `PAPERCLIP_IN_WORKTREE` — but it **never touched
`PAPERCLIP_CODEX_HOME`**, because that variable did not exist upstream. It was
ours.

So the fork's override did its job and redirected the "managed home" *out of the
sandbox and onto the real vault*. What then happened to `/sysops/llm/openrouter/default`:

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
`PAPERCLIP_CODEX_HOME` (retired in v6, no longer reachable),
`PAPERCLIP_PUBLIC_URL`, and `PAPERCLIP_TELEMETRY_DISABLED`, leaving two live.
`PAPERCLIP_DEPLOYMENT_MODE=authenticated`,
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

**The second variant — a patch file, not a specifier (added Session 15).** The
same class of staleness also arrives with a *different* error code, and the
message points at `package.json` even though `package.json` is fine:

```
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.
The current "patchedDependencies" configuration doesn't match the lockfile
```

Here `patchedDependencies` is **identical** in merge-base, fork and upstream —
nothing about the configuration changed. pnpm stores a *content hash* of every
patch file, and upstream had rewritten `patches/acpx@0.13.1.patch` without
refreshing the lockfile (`560e7e48b`/#12608; also Session 12's Finding 1). The
hash in the lockfile describes a patch that no longer exists.

**Tell the two apart before reaching for a fix**, because the wrong diagnosis
sends you hunting a dependency change that never happened:

```bash
git diff --stat HEAD FETCH_HEAD -- pnpm-lock.yaml patches/
```

A `patches/` file in that list and an untouched lockfile is this variant. The
remedy is the same `--no-frozen-lockfile` regeneration; the resulting diff should
be confined to patch hashes and any new workspace importers upstream forgot to
record. Anything else in that diff deserves a second look.

#### 4. Some failures are the machine, not the merge

`workspace-runtime*` and `local-service-supervisor` bind real ports, spawn
process trees and negotiate HTTPS exposure. `workspace-runtime.test.ts` alone has
a 123 s baseline in `general-server-shard-durations.json`; under load it takes
~220 s and sheds tests. `cursor-local-*` fails with exit **127** because
`cursor-agent` is not installed in the image. None of these are fork-touched
files. Re-run a suspect suite alone before classifying it.

#### 5. Exit 137 is memory, not a type error — do not run typecheck beside the suite

**Added Session 15.** `pnpm run typecheck` died three times running with:

```
ui typecheck: Killed          …then…    server typecheck: Killed
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL   Exit status 137
```

**137 = 128 + 9 = SIGKILL — the OOM killer, not `tsc`.** The signature is that
the *count of `error TS` lines is zero*: a real type failure prints errors and
exits 1 or 2. Check that first:

```bash
grep -cE 'error TS' <log>     # 0 + exit 137  ->  memory, re-run it alone
```

Two things make this newly easy to hit:

- The host has **15 GB**, and the server typecheck now runs
  `prepare:runner-vendor`, which builds upstream's Rust runner binary before
  `tsc` starts. That is new with the Paperclip Runner subsystem.
- The four-group suite holds ~8 vitest processes. Typecheck and the suite
  **cannot** run concurrently on this host. Which project gets killed varies
  with timing, which makes it look like a moving code fault rather than a
  resource limit.

Also check for **leftover runs from earlier sessions**. Session 15 found four
abandoned `paperclip-company-cli-e2e` processes, 11 hours to 1.5 days old,
holding ~2.5 GB between them; they ignored `SIGTERM` and needed `kill -9`.
Clearing them moved available memory from 4 GB to 7 GB and the typecheck passed
immediately:

```bash
ps -eo pid,rss,etime,cmd --sort=-rss | head -12
```

Run typecheck **alone**, before or after the suite, never beside it.

#### 6. `--reporter=basic` was removed in vitest 4 — the error looks like broken infrastructure

**Added Session 17.** The pin is now `vitest@4.1.11` (§3.1), and the `basic`
reporter is gone from it. Passing the flag produces:

```
Error: Failed to load url basic (resolved id: basic). Does the file exist?
    at prepareVitest (…/vitest/dist/chunks/cli-api.…js)
```

**Read that carefully: it is a missing *reporter module*, not a failing suite.**
Nothing ran. The stack is entirely inside vitest's own CLI bootstrap — no test
file is named anywhere in it — which is the tell. It is easy to lose several
minutes here because the wording suggests a resolution problem in the project.

**Fix: drop the flag.** The default reporter is what `basic` approximated:

```bash
corepack pnpm exec vitest run <path>          # right
corepack pnpm exec vitest run <path> --reporter=basic   # fails, vitest 4
```

Checked 2026-09-04: **no script, config or CI workflow in this repo passes the
flag**, so there is nothing to repair in-tree — it only bites when a flag is typed
by hand, or copied from a pre-v4 note. `--reporter=verbose` and `--reporter=dot`
both still exist if per-test output is wanted.

---

## 8. Session log — append only


> **Numbering note.** The header at the top of this file calls the session log
> "§7". It is this section, **§8** — §7 is the test procedure. Kept as-is so old
> cross-references still resolve; read "§7 session log" as this section.

### 2026-09-04 — Session 17: duplicate agent "Validation error" on `W7-20260904a`

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Branch:** `W7-20260904a` @ `2f5a2153c` (post-merge, upstream `af3023f1e`)
**Scope:** a bug report, not a merge review — the first entry in this log that is.
**Left uncommitted per RULE 0.**

> **Numbering.** The 2026-09-04 upstream sync — Session 16 — is written up in
> [`SYNC-2026-09-04.md`](CustomCodeDoc/SYNC-2026-09-04.md) rather than here, so
> there is no Session 16 entry in this section. The gap is deliberate.

#### The report

Duplicating an agent toasted `Could not duplicate agent / Validation error`. No
field named.

#### Finding 1 — the toast is uninformative by construction, and it cost time

The server *does* return the failing path: `validate.ts:45` throws
`unprocessable("Validation error", err.issues)` and the error handler serialises
it as `{ error, details }`. The UI keeps that body on `ApiError.body` but every
toast on this path renders `err.message` alone — the top-level string. **So every
schema rejection anywhere in this flow produces byte-identical output.** Diagnosis
had to come from reading the schema rather than the error. Logged as open item
O-2 in the change-set document; not fixed here because it is cross-cutting UI
error rendering, not this bug.

#### Finding 2 — an upstream retirement met an unmigrated row

Upstream `4b6de5327` (#12683, 2026-09-01, which arrived in the 09-04 merge) added
a `superRefine` to `agentRuntimeConfigSchema` that rejects `runtimeConfig.modelProfiles`
by name. Nothing migrates the key out of existing agent rows, and duplicate copied
`runtimeConfig` wholesale — so **any agent predating #12683 became
un-duplicatable.** Upstream had already hit the same wall on its own copy path and
answered it by dropping the key (`sanitizeImportedAgentRuntimeConfig`,
`company-portability.ts:1318`); the fix follows that precedent rather than
inventing one.

**This is the shape to watch for in future merges:** upstream retires a config key
with a validator rejection, not a migration. The rejection is instant and total;
the rows change only when next written. Any fork path that round-trips a stored
config through a create/update schema is exposed.

#### Finding 3 — the fix, alone, would have produced a silently broken agent

With `modelProfiles` dropped the create returns 201 — and writes an agent whose
`adapterConfig.env` values are the literal string `***REDACTED***`, because that
is what the client was given when it read the source. **For this fork that is a
credential vault directory** (change sets 3 and 4), so the copy fails at run time,
long after, with an error resembling nothing. The update path already solves this
round trip against the row being updated; a create has no such row, so the caller
now names one (`duplicateFromAgentId`) and the server restores server-side, gated
on same-company and on the same permission as reading the source. Applied to the
**hire** path as well — a board-approval company routes duplicates there, and
missing it would mean approval materialises the broken agent.

#### Results

| Check | Result |
| --- | --- |
| `ui/src/lib/duplicate-agent-payload.test.ts` | 5/5 |
| `server/src/__tests__/agent-permissions-routes.test.ts` | 69/69 (67 before the O-1 tests) |
| `server/src/__tests__/openapi-routes.test.ts` | 5/5 |
| typecheck — shared, ui, server | clean |

**Not live-verified.** The bug was traced in code and never watched to fail or to
be fixed on a running instance. The live checklist is §7 of
[`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md).

#### Carried forward — then closed the same session

O-1 — adding the field to `createAgentSchema` also admits it on `updateAgentSchema`
(derived via `.omit().partial()`), and the PATCH route does not strip it the way it
strips its two sibling non-column flags. Low severity and fail-closed, but it
should be decided before change set 10 is committed.

> **Amendment, same session.** The operator directed the fix, and it was applied:
> one `delete patchData.duplicateFromAgentId;` at `agents.ts:4683`, plus two tests
> (69/69). **Both tests were proved to be real guards** by removing the fix and
> watching them go red — and that run also answered the question the finding had
> left open, printing `+ Received: "11111111-…"`, i.e. the field really was
> reaching `svc.update`. Change set 10 now has no blocking open items.

#### Finding 4 — a hardcoded-looking test fixture, and the real gap behind it

The operator, reading the new tests, asked why
`const vaultDirectory = "/sysops/llm/openrouter/default"` was hardcoded rather
than configurable.

**In the test, correctly so** — it is an opaque fixture and the assertions are
"what went in came back out"; a test that read the value from the environment
would stop being deterministic. It has been renamed to
`/sysops/llm/codex/duplicate-source` and commented to say so, because the old
value read as though the suite depended on a real host path.

**But the question found a genuine gap.** Production does not hardcode these
paths — `DEFAULT_CODEX_VAULT_ROOT` and `DEFAULT_CLAUDE_VAULT_ROOT` are already
overridable with `PAPERCLIP_CODEX_VAULT_ROOT` and `PAPERCLIP_CLAUDE_VAULT_ROOT`,
resolved through `resolveVaultRoot(env)` and deliberately never taken from a
request. **Neither key appears in any markdown, in `.env.example`, or in
`docker/`** (`grep -rn "VAULT_ROOT"` over all four: no matches). An operator
wanting to relocate the vaults can only find the knob by reading adapter source —
which is what just happened. Logged as O-4 against change sets 3 and 4, which own
those files.

A related misreading was fixed in §7.2 above: `/sysops/llm/openrouter/` sits
beside the two vault roots but **is not a managed vault** — the service neither
creates nor lists it. Logged as O-5.

#### Finding 5 — `--reporter=basic` is gone in vitest 4

Cost a few minutes looking like broken test infrastructure. Written up as trap 6
in §7.5; nothing in-tree passes the flag, so there was nothing to repair.

#### Also this session — the disconnection convention

At the operator's request after repeated dropped connections: added
[`SESSION-RESUME.md`](CustomCodeDoc/SESSION-RESUME.md) and
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md), and wired both into §0, §0.1 and
§1.2 above. The principle: **reasoning is the perishable part.** The diff survives
a disconnection intact; why an approach was abandoned and what was deliberately
left undone do not.

---

### 2026-09-01 — Session 15: local upstream merge into `W6-20260901a` (14 commits)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Branch:** `W6-20260901a` @ `3003ce14c` · **Upstream:** `paperclipai/master`
@ `1955b0e2d` · **Merge base:** `9f9a950d0` (#12593, the lockfile-refresh chore)
**Scope:** take the upstream merge locally (the PR route was not used), resolve
conflicts, verify the §4 register, run the suite.
**Left uncommitted per RULE 0** — the operator reviews and commits.

#### What came in

14 upstream commits, 721 files, +173k/-30k. Almost all of it is the new
**Paperclip Runner** subsystem (#12608, #12616, #12617, #12638-#12641, #12652-#12654,
#12656) plus managed-OAuth fixes (#12619, #12623). None of it touches the fork's
server-side change sets.

#### Finding 1 — the merge is only 2 files wide, and `merge-tree` proves it first

`git merge-tree --write-tree` (§5.2 step 4) named the entire conflict set before
anything was modified: `ui/src/pages/NewAgent.tsx` and its test. Nine files were
touched by *both* sides; seven auto-merged with both hunks intact (`.gitignore`,
`environment-config.ts`, `tool-access.ts`, `index.css`, `queryKeys.ts`,
`InviteLanding.tsx`, `InviteLanding.test.tsx` — the §0.1 canary file among them,
guard present at `InviteLanding.tsx:320`).

#### Finding 2 — `pnpm install --frozen-lockfile` fails, and it is upstream's bug

```
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.
The current "patchedDependencies" configuration doesn't match the lockfile
```

**This is not a merge artefact and not the fork's fault.** `pnpm-lock.yaml` is
byte-identical across merge-base, fork HEAD and upstream tip — nobody edited it.
Upstream `560e7e48b` (#12608) rewrote `patches/acpx@0.13.1.patch` by 184 lines
**without refreshing the lockfile**, and pnpm stores a *content hash* of each
patch file. Upstream master alone fails the same way; their periodic
`chore(lockfile): refresh pnpm-lock.yaml` bot had not yet run.

Regenerating with `--no-frozen-lockfile` produced a 216-line diff that is
entirely upstream's unrecorded work:

| Change | What it is |
| --- | --- |
| `acpx@0.13.1` hash `klzqvo4xom3l6xnrgmyg2xpqci` → `lzpwjtiaybzoijy455dfycwavu` | the rewritten patch's real hash |
| new `packages/paperclip-eval-kernel` importer | a workspace #12653 added and never recorded |
| new `packages/paperclip-runner` deps | the runner subsystem's own dependencies |

**This is the second time.** Session 12's Finding 1 was the same acpx patch-hash
regeneration. Treat `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` after an upstream merge
as *expected* until upstream's lockfile bot catches up, and check whether the
regenerated diff is confined to patch hashes and new importers before worrying.

#### Finding 3 — the first *semantic* conflict the fork has hit

Two of the three conflict hunks were ordinary adjacency and both sides were kept:

- **`NewAgent.tsx` effect deps** — upstream added `adapterRegistryLoaded`/
  `disabledTypes`, the fork had `presetEnvBindings`. The effect body reads all
  four; the union is the exhaustive-deps-correct array.
- **`NewAgent.test.tsx` router mock** — both sides had independently invented a
  `useSearchParams` mock (the fork's `routerSearch` string ref, upstream's
  `mockSearchParams`). One `vi.mock` factory can only supply one implementation,
  so the fork's was folded into upstream's and its two preset tests rewritten to
  drive it. The fork's `primeApiMocks()` extraction was kept and upstream's
  mock resets moved into the two `beforeEach` blocks.

The third was **not** adjacency, and §5.3 was followed — raised with the
operator rather than resolved unilaterally. Upstream `1955b0e2d` gates a URL
adapter preset on availability inside a `useEffect`; change set 5 seeds the
preset in the `useState` **initializer**, which runs first and did not consult
the gate. A link naming a disabled experimental runtime therefore reached the
form, and upstream's own new test caught it.

**Operator's decision: honour upstream's gate.** The initializer now reads it,
with the two registry hooks hoisted above the create-values state. The accepted
cost is that on a cold react-query cache the registry has not arrived, so the
initializer declines to seed and the preset comes through the effect — the path
§3.3 of the change set 5 doc preferred to avoid. Warm cache, the normal flow,
still seeds in the initializer. Full write-up:
[`Create agent from a login vault.md`](CustomCodeDoc/Create%20agent%20from%20a%20login%20vault.md) §8.

#### §4 register audit — all live change sets present

| # | Change set | State after merge |
| --- | --- | --- |
| 1 | Reverse-proxy / forward-auth | present; precedence still bearer → cloud (`auth.ts:255`) → proxy (`:265`) → session (`:277`); `proxy_header` still threaded through `environment-config.ts` and `tool-access.ts` |
| 3 | Codex credential vaults | present; routes mounted `app.ts:556` |
| 4 | Claude credential vaults | present; routes mounted `app.ts:557` |
| 5 | Create agent from a login vault | present; **modified this session** — see Finding 3 |
| 6 | Invite auto-accept guard | present, `InviteLanding.tsx:320` |
| 8 | Local packaging scripts | present |
| 2, 7, 9 | RETIRED in v6 | correctly absent; not restored |

`git merge-base --is-ancestor ddcd436f5 HEAD` passes — the add-on is carried in
history, nothing was cherry-picked (§6.3).

#### Targeted verification

```
ui/src/lib/new-agent-preset.test.ts + NewAgent.test.tsx + InviteLanding.test.tsx
  → 39 passed (39), 3 files
```

Before the Finding 3 fix this was 38/39 with upstream's gate test failing; after,
all four preset-related tests pass — the fork's 2 and upstream's 2 together.

#### Finding 4 — typecheck is clean, but only when it runs alone

`corepack pnpm run typecheck` → **exit 0, zero errors, zero kills**, across every
project including `server` and `cli`. Given the merge moved 721 files, this is
the check that would have surfaced an upstream rename the fork failed to follow.
Nothing was found.

Getting that result took four attempts, and the three failures were **all
memory**, not code — exit 137 with zero `error TS` lines. New §7.5 trap #5
records the signature and the cause. The contributing factor was four abandoned
`paperclip-company-cli-e2e` runs from previous sessions, 11 hours to 1.5 days
old, holding ~2.5 GB; the operator authorised clearing them along with a stale
`paperclipai run`. Available memory went 4 GB → 7 GB and typecheck passed on the
next attempt.

**Operational note for the next session:** typecheck and the four-group suite
cannot run concurrently on this 15 GB host, and the server typecheck now builds
upstream's Rust runner binary first. Run them in sequence.

#### Suite ordering — run `general-server` last, not first

§7.1 lists the four groups server-first. On this host that is the wrong order:
§7.5 #4 records that `general-server` reliably fails for environmental reasons
and it costs ~30 minutes, while **five of the eight §4 change sets have their
tests in `general-workspaces-a`**. A first run this session spent 30 minutes on
`general-server` and never reached the groups that exercise the fork. Prefer:

```
general-workspaces-a  →  general-workspaces-b  →  serialized  →  general-server
```

#### Full suite — all four groups, run in the corrected order

| Group | Result |
| --- | --- |
| `general-workspaces-a` | **exit 0** — UI 527 files / 5128 tests, CLI 59 files / 426 tests. **Two summary blocks**, so neither project was skipped (§7.1) |
| `general-workspaces-b` | **exit 0** — 12 project blocks, 2928 passed, 11 skipped |
| `serialized` | **exit 0** — **141/141 suites, 2056 passed, zero failures.** The group ran to completion for the first time since the abort was documented; Session 12 had to strip the abort by hand to get past suite 60 |
| `general-server` | exit 1 — 472 passed / 7 failed files; 5627 passed, 39 failed, 10 skipped |

**~16,165 tests passed. Every one of the 39 failures is in `general-server` and
every one is already classified — none is attributable to this merge.**

**Failure classification (§7.4).** Identical to Session 14's, file for file. Six
of the seven are **environmental**, all named in §7.5 #4: `workspace-runtime.test.ts`,
`workspace-runtime-exposure-reservation.test.ts`,
`services/workspace-runtime-exposure.test.ts`, `local-service-supervisor.test.ts`,
and the two `cursor-local-*` files.

The seventh, `cli-invocation-safety.test.ts`, is the **known fork-caused failure
from v6** already recorded in Session 14 — the `--pnpm` comment lines in the two
onboard scripts whose trailing prose defeats the guard's logical-line extraction.
It was left unfixed pending the operator's call and **still is**. Confirmed
pre-existing rather than merge-caused: the test file is untouched by this merge
(`git log HEAD..FETCH_HEAD -- server/src/__tests__/cli-invocation-safety.test.ts`
is empty) and the offending lines are present at `HEAD`.

> **It reported five lines, not three — and two of them were this document.**
> Session 14 recorded the failure by pasting the guard's output into the log. The
> guard scans `CustomCodeDoc/`, so the pasted evidence became two more offending
> lines for the next run: the register was manufacturing its own findings.
> **When quoting this guard's output, wrap the phrase in backticks** —
> `` `pnpm paperclipai` `` — because for a `.md` file the guard trusts a backtick
> span adjacent to the marker and extracts only the phrase inside it. That is why
> the one quoted line that already had backticks never tripped. Fixed in the
> Session 14 entry by amendment; Session 15's own additions add none.

#### Finding 5 — the v6 CLI-guard failure is fixed, on the operator's instruction

Session 14 left `cli-invocation-safety.test.ts` failing and recorded the fix it
recommended without applying it. The operator authorised it this session and it
was done exactly as recommended: **reword the comments so the phrase ends the
line.** The upstream test was not touched, `DOC_PHRASES` was not widened, and the
extraction was not relaxed.

Three comments, all in the fork's own onboard scripts:

| File | Was | Now |
| --- | --- | --- |
| `onboard-paperclip-1.sh:18` | `(pnpm paperclipai, via tsx)` | trailing prose moved ahead; line ends `The form run is` / `pnpm paperclipai` |
| `onboard-paperclip-1.sh:100` | `` `pnpm paperclipai` -> tsx over `` | ends `The form run is pnpm paperclipai` |
| `onboard-paperclip-2.sh:209` | `(pnpm paperclipai,` | ends `The form run is` / `pnpm paperclipai` |

A fourth and fifth offender were **this document** — see the amendment on the
Session 14 entry. Fixed by backticking the quoted phrase.

```
cli-invocation-safety.test.ts   37 passed (37)
```

Both scripts pass `bash -n`, every changed line is a comment, and the executable
bits are unchanged — no behavioural change to onboarding.

#### Changes left in the working tree (uncommitted, per §5.4)

The merge itself is staged (721 files). Beyond it:

| File | Change | Why |
| --- | --- | --- |
| `ui/src/pages/NewAgent.tsx` | conflict resolution + availability gate | Finding 3 |
| `ui/src/pages/NewAgent.test.tsx` | conflict resolution, mocks unified | Finding 3 |
| `pnpm-lock.yaml` | regenerated (+180/−36) | Finding 2 — upstream's unrecorded work, not a fork change |
| `CustomCodeDoc/onboard-paperclip-1.sh` | 2 comments reworded | Finding 5 |
| `CustomCodeDoc/onboard-paperclip-2.sh` | 1 comment reworded | Finding 5 |
| `CustomCodeDoc/Create agent from a login vault.md` | new §8 | Finding 3 rationale |
| `CustomCodeDoc/Review and Test Changes.md` | §4.1 collision point, §7.5 traps 3+5, Session 14 amendment, this entry | — |

`CustomCodeDoc/l` was deleted during `pnpm install` and restored from `HEAD`; it
is a tracked scratch file, not part of the merge.

### 2026-09-01 — Session 14: v6 retirement review on `W6-20260831a` (upstream merge #38)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Branch:** `W6-20260831a` @ `21f2ed861`. Upstream merge #38 was a lockfile
refresh only (`9f9a950d0`); all source change came from the fork's own
`88bca7b78`, a single-parent commit, not a merge resolution.
**Scope:** full documentation review, full four-group suite, §4 register audit.

**Outcome: three change sets were retired on purpose, six survive intact, and
the suite is green apart from the standing environmental set plus one new
fork-caused failure that v6 introduced.**

**The retirement.** Change sets 2, 7 and 9 are gone, removed deliberately by
`88bca7b78`, which rewrote `onboard-paperclip-2.sh` in the same commit to
replace them with a `CODEX_HOME` hand-off plus per-agent `secret_ref` binding.
Confirmed operator intent this session. Recorded in §4.2; §4.1, §6.5, §7.2 and
§7.5 #2 updated to match; `Codex-changes-instructions.md` marked historical.
The removal is clean — every removed symbol greps to zero references.

Change sets 1, 3, 4, 5, 6 and 8 were verified present file by file: vault
services and routes, both vault UI pages, `new-agent-preset.ts`,
`CreateAgentFromLoginButton.tsx`, the `proxy_header` actor source, the
`Boolean(invite) &&` guard at `InviteLanding.tsx:307`, both `app.ts` mounts,
and both `openapi-routes.test.ts` exclusions.

**Test results** (four groups, per §7.1, with the §7.5 #1 SDK build and the
`CLEAN` env):

| Group | Result |
| --- | --- |
| `general-server` | 39 failed / 5436 passed / 9 skipped — 7 files |
| `general-workspaces-a` | 504 passed + 59 passed — **two blocks, so the §7.1 truncation did not bite** |
| `general-workspaces-b` | 12 blocks, all passed |
| `serialized` | 142 files, all passed |

**Failure classification (§7.4).** Six of the seven failing files are
**environmental**, all named in §7.5 #4: `workspace-runtime.test.ts`,
`workspace-runtime-exposure-reservation.test.ts`,
`services/workspace-runtime-exposure.test.ts`, `local-service-supervisor.test.ts`,
and the two `cursor-local-*` files, which fail with exit **127** exactly as
documented because `cursor-agent` is not installed in the image.

The seventh is **fork-caused and new in v6**:
`cli-invocation-safety.test.ts` → *"allows only exact-allowlist pnpm paperclipai
commands on every guidance surface"*. Three comment lines added by `88bca7b78`
describe the new `--pnpm` flag and mention `pnpm paperclipai` followed by
trailing prose:

```
CustomCodeDoc/onboard-paperclip-1.sh:18:  (`pnpm paperclipai`, via tsx)
CustomCodeDoc/onboard-paperclip-1.sh:100: `pnpm paperclipai` -> tsx over
CustomCodeDoc/onboard-paperclip-2.sh:103: (`pnpm paperclipai`,
```

> **Amendment, 2026-09-01 (Session 15).** Backticks were added around the phrase
> in the first and third quoted lines above. The entry is otherwise unchanged —
> this is not a rewrite of the finding. As quoted originally those two lines were
> themselves guard violations, so recording the failure re-created it inside this
> document; the middle line never tripped because it already carried backticks,
> which is the `.md` span rule doing its job. The underlying comments in the two
> onboard scripts were reworded in Session 15 and the suite is now green.

The bare phrase `pnpm paperclipai` is already in the guard's `DOC_PHRASES`, so
prose mentions are fine in principle. The trip is the *trailing text*: for `.sh`
files the guard deliberately extracts to the logical line end and refuses to
treat a quote, backtick or paren as a boundary, so the whole tail becomes the
"command" and fails the allowlist.

**Recommended fix — reword the three comments so the phrase ends the line.** Do
not add these to `DOC_PHRASES` and do not relax the extraction: that is an
upstream test file, editing it creates a new fork-carried change in a file §4
does not list, and it would weaken a fail-closed guard to accommodate a comment.
Left unfixed this session pending the operator's call.

**Change made this session: `onboard-paperclip-2.sh` verifies the credential
itself.** The script previously ended by printing a `codex exec … PONG` command
for the operator to run later — the one check that catches an agent which looks
configured and 401s on its first real task, left as homework. It now runs that
probe in phase 6, reports `codex: PONG — provider: openrouter` beside the other
counts, and on failure prints the provider's own error, sets the verify status
and exits non-zero. Skippable with `--skip-credential-check`; skipped
automatically with a stated reason when there is no `--codex-home`, no
`OPENROUTER_API_KEY` in the shell, or no `codex` binary.

Writing it surfaced a latent bug worth knowing independently: **`codex exec`
appends stdin to the prompt and blocks until EOF.** Run without redirecting
stdin it hangs on "Reading additional input from stdin..." for the full timeout
— which is what an operator running the documented command from an interactive
SSH session would hit, and it looks exactly like a hung provider call. The probe
redirects `< /dev/null`; the by-hand form in `Paperclip Onboarding Steps.md` now
does too. All five paths were exercised: happy path against the real vault, a
forced 401 with a bogus key, and the three skip conditions.

**Second change: `--add-agent`, for adding an agent to an existing company.**
There was no way to do this except re-running the whole script, which re-locks
instance ownership on every pass — revoking every live bootstrap invite as a
side effect of adding an agent — mints another set of invite links, and on a
mistyped `--company` creates a second company and puts the agent in it.
`--add-agent` implies `--only agent,task`, never touches ownership or invites,
refuses to create a company (listing the ones that do exist, with ids, when the
name misses), and reuses the company's existing OpenRouter secret. Added
`--company-id <uuid>` alongside it, which resolves ahead of the phase gate
because an id is an instruction to use *that* company. `--owner-email` is still
required to mint the run's key, and the error now says plainly that in this mode
it does not reassign ownership.

**Third change: `--secret-identity` / `--secret-name`, and a guard on rotation.** The
secret name and key were env-only (`ONBOARD_SECRET_*`) and undocumented in
`--help`, so there was no way to give a second agent its own OpenRouter
credential. Both are flags now. The trap they expose is worth stating plainly:
**every lookup matches on the secret KEY, never the name**, so changing only the
name is a no-op, and reusing the same key with a different value *rotates the
existing secret in place* and re-credentials every agent already bound to it.
Correct for a tenant standing up; silently destructive while adding an agent. So
`--add-agent` now refuses to rotate any existing secret and names both
alternatives — a new `--secret-identity` for a separate credential, or an explicit
`--only secrets` run without `--add-agent` for a real rotation. Passing
`--secret-identity` under `--add-agent` switches the secrets phase back on, since
that phase is the only thing that creates one.

`--secret-env` completes the set: the env var the secret binds to in
`adapterConfig.env` was hardcoded to `OPENROUTER_API_KEY`, so a vault whose auth
command read anything else would get a secret bound to a name nothing looks at —
configured-looking, 401 on first run. It is now a flag, defaulting to the old
literal, validated as a shell variable name (it becomes both an `env`
assignment in the probe and a JSON object key), and the probe supplies the key
under that same name instead of relying on an ambient `OPENROUTER_API_KEY`.
The three are independent and worth stating together, because confusing them is
the failure mode: **name** is a label matched on by nothing, **key** is the
identity inside Paperclip, **env** is the variable inside the agent process.

**Incident found while testing the above: a live OpenRouter key is stored in a
plaintext identity column.** An operator run passed the credential *value* to
`--secret-identity`, which takes an identifier. Nothing caught it — the API's own
validator is `/^[a-zA-Z0-9_.-]{1,120}$/` and an OpenRouter token satisfies it —
so the key landed in `company_secrets.key`, which `secrets list` prints in full,
while the encrypted value column took whatever was in the ambient environment.
No error, and the agents work, so the leak is silent. It also put the key in
argv, readable by any process on the host via `ps`.

State on `Bring your AI to Life` (`e9403aa6`) at the time of writing: secret
`fe0d751a` "OpenRouterDeepseekKey" carries the token as its key, and
`OpenRouter Deepseek Agent 2` and `3` are bound to it. `7b272dd2`
"OpenRouter" (key `openrouter_api_key`) is correct and carries the other two
agents. **The disclosed key needs rotating at OpenRouter, not just deleting
here** — deleting the secret does not un-disclose it, and the same token is the
one in `/sysops/llm/openrouter/*/config.toml` auth commands and the container
environment.

Two guards added. `--secret-identity` now refuses a value that looks like a
credential — a known token prefix (`sk-`, `pk-`, `ghp_`, `xoxb-`), a
byte-for-byte match against `$OPENROUTER_API_KEY`, or 60+ characters with no
underscore — and names where the credential actually goes. Separately, when a
secret is found by key and `--secret-name` differs from its stored name, the run
now says the name was ignored and gives the `secrets update --payload-json`
command to relabel it; that silence was the operator-visible symptom that
surfaced the whole thing.

**Follow-on: `--secret-key` renamed to `--secret-identity` and the old spelling
refused.** The operator's read — that "key" names the credential, not the
identity — is the same read that caused the leak above, so the flag was the
defect rather than the operator. Paperclip's own UI, API, CLI and DB column all
call this field **"Key"**, which is why the script matched it; the script now
deliberately diverges and says which platform field it means.

`--secret-key` and `ONBOARD_SECRET_KEY` are **errors**, not aliases, and that is
the load-bearing decision. Aliasing to the identity would preserve the trap.
Aliasing to the credential — the intuitive reading — would silently turn an
older, correct `--secret-key openrouter_api_key_deepseek` into a run storing
that literal string as the API key: the same failure mode, inverted, and equally
silent. Refusing is the only mapping that cannot corrupt something quietly. The
error names both destinations, so either intent lands in one step.

Two placement bugs surfaced while doing it, both the same shape as the earlier
`credential_check` one: guards written into the argument loop, which runs before
`die()` and the other helpers are defined. The flag case now reports the way the
loop's own unknown-argument branch does; the env-var guard moved below the
helpers. Worth noting as a pattern in this script — anything validating an
argument must sit after the helper block, not beside the parser.

Both vaults were probed directly and answer `PONG`:
`/sysops/llm/openrouter/default` (`openai/gpt-5.6-luna`) and
`/sysops/llm/openrouter/deepseek-v4-flash-0731`
(`deepseek/deepseek-v4-flash-0731`). Worth recording because the vault paths are
under `/sysops/llm/openrouter/<name>` — a bare `/sysops/llm/<name>` does not
exist, and Codex fails on it at run time rather than at agent-create time.

**Also found: live contamination in the OpenRouter vault.**
`/sysops/llm/openrouter/default/auth.json` is a dangling symlink into
`/tmp/pcvt-126226-1-SZOm9T/...`, dated 2026-08-31 00:21 — the §7.5 #2 artifact,
created before v6 by a test run. `config.toml` is intact and correct and
`skills/` are real directories, so that symlink is the only damage. It cannot
recur now that nothing reads `PAPERCLIP_CODEX_HOME`. Left in place, unfixed,
pending the operator's call.

---

### 2026-08-31 — Session 13: verify the fork on `W5-20260830a` (upstream merge #36)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Branch:** `W5-20260830a` @ `28998bf27` — identical content to `W4-20260830c`,
re-cut into the W5 bucket. Upstream tip `3623a369a`.
**Scope:** merge #36, seven ACPX commits (#12398–#12404).

**Outcome: the merge broke nothing. Every Session 12 fix survived it.**

#### Session 12's fixes all survived merge #36

| Fix | State |
| --- | --- |
| Change set 9 — `OPENROUTER_API_KEY` in the codex allowlist | present |
| Regression guard in `execute-identity.test.ts` | present, passing |
| `copyTextToClipboard` in both vault pages | present, zero `navigator.clipboard` left |
| Vault routes in the OpenAPI coverage exclusions | present |
| Regenerated lockfile | committed by the operator |

#### What upstream actually changed

**Every upstream change is confined to `packages/paperclip-runner/`, the patches,
and packaging. Zero fork register files were touched** — confirmed by diffing
upstream tip to upstream tip (`001428a2d..3623a369a`), which shows
`acpx-engine/execute.ts` unchanged.

> **Method note worth keeping.** Diffing the *fork tip* against the upstream tip
> renders the fork's own additions as deletions, which reads like upstream ripped
> out the fork's code. It does not mean that. Always diff **upstream-tip to
> upstream-tip** to see what a merge actually brought.

#### OpenRouter — re-verified end to end on this branch

| Check | Result |
| --- | --- |
| Launch-env probe, host-env only (the deployment's global setup) | `OPENROUTER_API_KEY` **PRESENT** |
| Real Codex run against `/sysops/llm/openrouter/default` | `provider: openrouter`, `openai/gpt-5.6-luna`, `PONG`, exit 0 |

#### Finding 8 — stale lockfile, third occurrence (§7.5 #3)

Upstream added `acpx@0.13.1` and `@agentclientprotocol/codex-acp@1.6.2` to
`patchedDependencies` without regenerating the lockfile. `--frozen-lockfile`
failed with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. Fixed with
`--no-frozen-lockfile`; **all four patches now apply and `embedded-postgres`
kept its hash** (`55uhvnotpqyiy37rn3pqpukhei`). With that lockfile committed,
`--frozen-lockfile` succeeds again — verified.

The regenerated lockfile also pulled in **`skillflag@0.2.1`**, a new transitive
dependency arriving via `acpx@0.13.1`. Recorded because it entered the tree by
version bump rather than deliberate choice.

#### Finding 9 — the pnpm-10 trap is now half defused

Upstream duplicated `patchedDependencies` into `pnpm-workspace.yaml` but left
`overrides` in `package.json` only. `builds paperclip.md` §4.1 has been rewritten
to say which half is safe: patches survive a pnpm-10 bump, `rollup`/`react`/
`react-dom` overrides still would not.

#### Finding 10 — a patched dependency that the packaging does not carry

`@paperclipai/adapter-codex-local` now depends on
`@agentclientprotocol/codex-acp: ^1.6.2` and declares **no `bundleDependencies`**,
so `scripts/pack-local.sh` ships it unpatched — a packed install resolves it from
the public registry, and `^` can drift off the tested version. The two
long-standing bundled patches were verified genuinely present *and patched* in
the deployed tree by marker, not by version:

| Bundled dep | Marker | Deployed tree |
| --- | --- | --- |
| `acpx` in `adapter-utils` | `promotePrefixedAuthEnvironment` | patched |
| `embedded-postgres` in `db` | `LC_MESSAGES` | patched |

Harmless today — the `codex-acp` patch is gated on
`PAPERCLIP_ACPX_ISOLATED_CONTEXT`, which only the native runner sets and the
fork's ACP lane never does. It becomes real if upstream ungates it. Recorded in
`builds paperclip.md` §4.1 as a packaging trap with a marker-based verification
recipe. **`pack-local.sh` has no verification step of its own** — seven build
steps, none checking the output.

#### The ACPX "sandbox" is not an OS sandbox — terminology, recorded once

Asked directly this session, and worth pinning because the word is overloaded
five ways in this tree:

| Layer | What it is | Applies to this deployment |
| --- | --- | --- |
| Docker container | real kernel isolation | always |
| Paperclip execution target | `local` vs `remote`; `transport: "sandbox"` = a remote cloud provider (daytona, e2b, modal, …) | `local` |
| Paperclip local confinement | real OS confinement via **bwrap** (`--unshare-pid/ipc/uts`, optional `--unshare-net`) | available (`/usr/bin/bwrap`), opt-in, off |
| Codex CLI's own sandbox | Codex's built-in; the `sandbox: read-only` seen in run output | on by default |
| ACPX "runtime sandbox" | **not OS isolation** — a private 0700 home directory plus an env allowlist | native runner only, off |

Setting `filesystemScope` or `networkScope` on an agent **silently forces it onto
the CLI engine** ([`acp.ts:107`](packages/adapters/codex-local/src/server/acp.ts#L107));
with `engine: "acp"` set explicitly it is a hard error instead.

#### Full suite — all four groups, run to real completion

| Group | Coverage | Tests | Failures |
| --- | --- | --- | --- |
| `general-server` | full | 5280 passed | 38 |
| `general-workspaces-a` | **2 summary blocks** (UI + CLI) | 4825 + 426 | **0** |
| `general-workspaces-b` | full (12 blocks) | 693 + others | **0** |
| `serialized` | **140/140 swept, no abort** | **1998 passed** | **1** |
| `typecheck` | all workspaces | — | clean |

**Every failure classified:**

- **Environmental (38, `general-server`).** Six files: `workspace-runtime*` (ports
  and HTTPS exposure), `cursor-local-*` (`cursor-agent` absent),
  `local-service-supervisor`. All carry zero fork delta. §7.5 #4.
- **Pre-existing upstream flake (1, serialized #60).** `heartbeat-process-recovery`
  → `reaps orphaned descendant process groups…`, expects 2 heartbeat runs, gets 3.
  Reproduced on a clean `001428a2d` worktree in Session 12 with no fork code
  present. Fails on a solo re-run here too, so it is deterministic on this host
  rather than load-related — but it is upstream's.
- **Nothing fork-caused.**

**Session 12's two fork fixes are confirmed working by this run:** `openapi-routes`
(serialized #115) now passes **5/5** — it was the fork-caused failure found when
the sweep first reached it — and the CLI project runs green, which the clipboard
fix unblocked. The serialized total moved 1997 → 1998 for exactly that reason.

> **Sweep hygiene — a mistake worth recording.** The first attempt at this
> sweep was driven by a multi-line *inline* Bash command. Its newlines were
> collapsed, so `echo "G3_EXIT=$?"` became an argument to vitest and the `rm` of
> the previous run's results never executed as its own statement. The stale
> results file from Session 12 was then read as a completed run and briefly
> reported as this branch's result. **The tell was that it showed
> `openapi-routes` failing — a bug already fixed and committed.** A result that
> contradicts a known fix is stale until proven otherwise. Drive the sweep from
> `serial-sweep.sh` (a file), and check the results file's mtime before quoting
> it.

#### Documentation updated this session

- **RULE 0** added at the top of this file — never commit, push, or check
  anything in — with the operator's reason: every diff is reviewed visually in
  the VS Code IDE, and a commit made for them destroys that review. Cross-linked
  from `ReverseProxyCustomChanges.md`, `builds paperclip.md`, and
  `Codex-changes-instructions.md`.
- `builds paperclip.md` §4.1 rewritten (four patches, dual manifest, the half-
  defused pnpm-10 trap, the packaging trap and its verification recipe); status
  line moved to `W5-20260830a`.

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
