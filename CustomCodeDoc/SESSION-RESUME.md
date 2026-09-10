# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-10 (afternoon)

| | |
| --- | --- |
| **Branch** | `W8-20260909d` |
| **HEAD** | `43d912525` "Merge pull request #48 from paperclipai/master" |
| **Working tree** | Dirty — **25 files** (22 modified, 3 untracked), none committed. No merge in progress. |
| **Active work item** | **Permissions review for company-level roles** (see "The very next action") |
| **Parent work item** | Per-company vault scope — steps **1 and 2 are implemented**, not just groundwork |
| **Its document** | [`Codex device login web service.md`](CustomCodeDoc/Codex%20device%20login%20web%20service.md) § "Per-company vault scope" |

> **The two device-login documents are behind this file.** Their "Per-company
> vault scope" sections (written 13:03) still say *groundwork only, NOT wired up*
> and put the Resume point at step 1. Steps 1–2 were built afterwards, 13:21–14:27.
> Trust this file and git over those sections until they are updated.

PR #47 and #48 are both verified and committed (Sessions 22 and 23 in
[`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §8).

## What happened this session, in order

| Time | What |
| --- | --- |
| 13:06 | Previous version of this file written: vault scope parked at step 1. |
| 13:21–13:31 | **Steps 1–2 built.** Every vault function in both adapters takes `companyId` first; layout is `<root>/<companyId>/<name>`. Both login services key in-flight logins by `companyId:name`, and `agentsUsingVault` filters on `agents.companyId`. Routes take `companyId` from query or body and run `assertCompanyAccess` (`requireCompanyScope`). UI pages send `selectedCompanyId`. |
| 14:10–14:11 | Adapters, server and UI rebuilt. |
| 14:23 | Operator ran a Claude login into `claude_yid`. It failed at the code-submit step: *"A companyId is required to address a credential vault."* |
| 14:26–14:27 | **Fix:** [`ui/src/api/claudeVaults.ts`](ui/src/api/claudeVaults.ts) `submitCode` now sends `companyId`. New [`ui/src/api/vault-company-scope.test.ts`](ui/src/api/vault-company-scope.test.ts) (17 tests) checks every client method sends the scope. `verify-fork.sh` cs3+4 baseline 83 → **128**. |
| later | Operator restarted to reproduce. **The error from that restart was not captured**, and focus moved to permissions. |

## Verification — NOT re-run since the 13:21 edits

The last green (`./scripts/verify-fork.sh targeted`, exit 0) came **before** the
service, route and UI changes. None of the following has been confirmed:

- typecheck, after an adapter signature change (rebuild the adapters first — see the
  standing caution below)
- cs3+4 at its new count of **128**
- a live Claude login completing with the `submitCode` fix

## Known state that will surprise you

1. **`ui/dist` predates the fix.** It was built at 14:10 and the fix landed at 14:26. A
   production server (`node dist/index.js`) serving that build will still show the
   companyId error on Claude code submit. **Rebuild the UI**, or use `pnpm dev`,
   before retesting. `server/dist` and the adapter builds already have the scope
   changes.
2. **`claude_yid` has no credential**, only `settings.json`
   (`/sysops/llm/claude/7fbdb8d9-…/claude_yid`). Start the login again from the
   beginning.
3. **Legacy Codex vaults are invisible in the UI.** `codex_chris`, `codex_chris2`–`4`
   and `codex_test` still sit flat under `/sysops/llm/codex/`. The UI now lists only
   `<companyId>/…`. Agents bound to those paths keep working. Moving them is **step 3,
   which the operator does by hand** (their decision, 2026-09-10).
4. **Instance admins now need company membership to use the vault pages.**
   `assertCompanyAccess` checks `req.actor.companyIds`, which is built from
   memberships only ([`middleware/auth.ts:301`](server/src/middleware/auth.ts#L301),
   [`:555`](server/src/middleware/auth.ts#L555)). An instance admin who is not a
   member of the selected company gets *"User does not have access to this company"*.
   That is a behaviour change from before step 2. Deliberate or not is part of the
   next action.
5. **13 orphaned test processes are still running**. They are not builds, and all
   have ppid 1. 12 are stub servers from four full-suite runs (Sep 9 13:30, 15:06,
   18:46; Sep 10 00:53) with working directories in `/tmp/pv-*/t/paperclip-runtime-*`.
   Three are one CLI e2e server from Sep 10 01:35 (PIDs 482700/482711/482719, ~750 MB).
   None hold app ports 3100/5173/54329/3000. **Not stopped yet**, awaiting the
   operator. Clear them before any test run.

## Uncommitted, for the operator's review

```
Adapters — scoped vault API (companyId first on every function)
 M packages/adapters/codex-local/src/server/codex-vault.ts
 M packages/adapters/claude-local/src/server/claude-vault.ts
 M packages/adapters/codex-local/src/server/index.ts          exports the scope helpers
 M packages/adapters/claude-local/src/server/index.ts         same
 M packages/adapters/codex-local/src/server/codex-vault.test.ts
 M packages/adapters/claude-local/src/server/claude-vault.test.ts
 M packages/adapters/codex-local/src/server/host-login-pty.test.ts
?? packages/adapters/codex-local/src/server/codex-vault-company-scope.test.ts    14 boundary tests
?? packages/adapters/claude-local/src/server/claude-vault-company-scope.test.ts  14 boundary tests

Server — services and routes take and authorize the company
 M server/src/services/codex-vault-login-service.ts
 M server/src/services/claude-vault-login-service.ts
 M server/src/routes/codex-vaults.ts
 M server/src/routes/claude-vaults.ts
 M server/src/__tests__/codex-vault-login-service.test.ts
 M server/src/__tests__/claude-vault-login-service.test.ts

UI — every call sends selectedCompanyId
 M ui/src/api/codexVaults.ts
 M ui/src/api/claudeVaults.ts                                 includes the submitCode fix
 M ui/src/pages/InstanceCodexVaults.tsx
 M ui/src/pages/InstanceClaudeVaults.tsx
?? ui/src/api/vault-company-scope.test.ts                     17 client-scope tests

Tooling and docs
 M scripts/verify-fork.sh                                     cs3+4 83 -> 128, general-server 9 -> 8
 M CustomCodeDoc/Codex device login web service.md            scope write-up (resume point now stale)
 M CustomCodeDoc/Claude device login web service.md           mirrored (same)
 M CustomCodeDoc/Review and Test Changes.md                   §8 Session 23
 M CustomCodeDoc/SESSION-RESUME.md                            this file
```

## The very next action

**Review permissions for company-level roles.** In the operator's words: look at
the permissions for the non-owners and for the people who are just admins in each
company but are not admins of the instance.

This is the question step 4 of the vault plan depends on. Step 4 relaxes
`assertCanManageVaults` so a company admin can manage their own company's vaults.
**Review first and change nothing.** Relaxing the gate stays blocked until step 3,
the manual migration, is done, unless the operator decides otherwise.

### What is already known (read 2026-09-10, not yet exercised)

- **Roles:** `owner`, `admin`, `operator`, `viewer` for humans, plus `member`
  ([`packages/shared/src/constants.ts:962`](packages/shared/src/constants.ts#L962)).
- **The vault gate ignores company roles entirely.** `assertCanManageVaults`
  ([`routes/claude-vaults.ts:35`](server/src/routes/claude-vaults.ts#L35),
  [`routes/codex-vaults.ts:32`](server/src/routes/codex-vaults.ts#L32)) requires
  `local_implicit` or `isInstanceAdmin`. A company owner or admin who is not an
  instance admin gets 403 on every vault route today.
- **`assertCompanyAccess` does not tell admin apart from operator.**
  ([`routes/authz.ts:75`](server/src/routes/authz.ts#L75)) For a board user on a
  write method it only requires an active membership and blocks `viewer`.
  `owner`, `admin` and `operator` are treated the same. On GET it only requires
  membership, so a viewer passes. **Company-admin-only therefore needs a new role
  check**, because `assertCompanyAccess` alone would also let operators in.
- **Instance admins are not implicit company members** (see surprise #4 above).

### Questions to answer

1. For each role (owner / admin / operator / viewer), which vault actions should
   be allowed: list, create, start login, submit code, cancel, sign out, delete?
2. Should viewers see the vault list and the bound-agent counts at all?
3. Should an instance admin who is not a company member still manage that
   company's vaults? That was allowed before step 2 and is refused now.
4. Beyond vaults: which other fork routes use `assertInstanceAdmin` or
   `assertCompanyAccess` where a company role would be the right gate?

### Still pending from the vault work (O-10)

- Retest a Claude login end to end after rebuilding the UI. Capture the error if it
  recurs.
- Re-run `./scripts/verify-fork.sh targeted` (after the orphan cleanup and an
  adapter rebuild).
- Update the Resume point in both device-login docs to "steps 1–2 done".
- Step 3: operator moves legacy vault directories by hand.
- Step 4: relax the gate, informed by the permissions review.

> **Standing caution:** a green *server* typecheck after an adapter signature change
> proves nothing until the adapter package is rebuilt, because the server
> type-checks against the package's built `dist`.

### Deploying this build

Standing fork-specific checks:

- `provisioning: worker enabled` in the boot log (change set 11 — its loss is silent)
- Codex/Claude login tabs visible in Settings
- Open an agent and confirm the left nav lists Instructions → Revisions

New since PR #48:

- **16 migrations** (`0255`–`0270`) apply at boot. All DROPs are constraints or
  indexes, nearly all on new `chat_*` tables — no data loss — but watch the log
  through to completion.
- The agent list has **no per-row action buttons** (upstream `622376e99`);
  Assign Task / Run Heartbeat / Pause now live on the agent detail page.
- First deploy carrying the **vault directory as an organization secret**. Create
  an agent from `codex-logins` and confirm `CODEX_HOME` is a secret reference and
  `CODEX_HOME_<vault>` exists in Settings → Secrets.
- **If the uncommitted vault-scope work ships:** vault pages need a selected
  company, the operator must be a member of it, and flat legacy vaults will not
  appear until they are moved.

## Open items carried

| Id | Owner | One line |
| --- | --- | --- |
| **O-10** | change sets 3/4 | Per-company vault scope. Steps 1–2 **done, unverified**; 3 (manual migration) and 4 (relax gate) remain. |
| **O-13** | change sets 3/4 | The session routes (`login-sessions/:id`, `/code`, `/cancel`) authorize the request's `companyId` but never compare it to the session's own `companyId`. Lookup is by owner, so no cross-user exposure, but the scope is unused there. Seen in the Claude routes; check Codex. **New 2026-09-10.** |
| **O-11** | change set 5 | `ensureOrganizationDirectorySecret` reuses a secret on a NAME match without verifying its stored value. Upstream guards the same hazard in `assertAccountHomeSecretMatches`. |
| **O-12** | change sets 3/4 | The vault pages' "N agents use this vault" count matches the **plain** path in SQL, so it reads 0 once a home is a secret reference — and the delete warning stops firing. |
| ~~O-9~~ | upstream | **CLOSED 2026-09-10** — upstream fixed `native-codex-runner.integration.test.ts` in PR #48. |
| O-3 | upstream, really | No migration strips `modelProfiles` from existing rows. |
| O-4 | change sets 3 and 4 | `PAPERCLIP_CODEX_VAULT_ROOT` / `PAPERCLIP_CLAUDE_VAULT_ROOT` appear in no markdown, `.env.example`, or `docker/`. |
| O-5 | change set 3 | `/sysops/llm/openrouter/` is **not** a managed vault. |

---

## The disconnection protocol — do this every session

Adopted 2026-09-04 because sessions have been dropping mid-work.

### Before any long activity — check the machine (added 2026-09-09)

```bash
./scripts/verify-fork.sh guards     # runs the §7.0-pre preflight in ~10 seconds
free -g                             # or just this, if you only want the number
```

Do it before a compile, a build, `pnpm install`, a test run, or a deployment
test. Host state has now been mistaken for a code defect three times: an
OOM-killed typecheck reporting `exit 137` with zero `error TS`, and embedded-
Postgres collisions from abandoned runners. Both look like the code.

**Never kill `vscode-server`** — it is the operator's IDE *and their sign-in*.
It grows over hours; the fix is to log out and back in, not `kill`. The preflight
excludes it, and the Claude Code extension host, by design.

### On resume — before touching anything

1. **Read this file.** It is the only place that claims to be current.
2. `git status --short && git log --oneline -3` — confirm branch and HEAD match
   the table above. **If they do not, this file is stale — trust git, and say so.**
3. Open the active work item's document and go to its **Resume point**.
4. Re-run the verification commands listed there. Do not trust a recorded "green"
   across a disconnection.

> **After any upstream merge, `corepack pnpm install --no-frozen-lockfile` is step
> one.** Four merges, four `patchedDependencies` hash mismatches (§7.5 #3). Tests
> run before that step are invalid.

### While working — the checkpoint rule

**Write the finding down when you find it, not when the task ends.** Checkpoint
after any one of these, whichever comes first:

- [ ] A root cause is identified — record it *with the evidence*, before fixing it.
- [ ] A file is edited — add it to the dirty-file table above with a reason.
- [ ] A test run completes — record the command and the counts.
- [ ] A second, unrelated defect is found — give it an `O-n` open item.
- [ ] A decision is taken not to do something — record what and why.
- [ ] Roughly every 30 minutes of work regardless.
