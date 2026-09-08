# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-08 16:20

| | |
| --- | --- |
| **Branch** | `W8-20260908a` |
| **HEAD** | `bcede974a` "Updated the resume" · merge commit `e2339b7eb` |
| **Working tree** | **Dirty — one UI fix, documentation, one new script.** The merge itself is committed. |
| **Active work item** | Session 19 — upstream merge (8 commits, upstream tip `297d8741f`) |
| **Its document** | [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §8, Session 19 |
| **Rollback tag** | `pre-merge-backup-W8-20260908a` → `60a77857b` |

> **The previous version of this file was four days stale** (it claimed
> `W7-20260904a` / `df401863f`). Per the resume protocol below, git won. The
> change sets it described as uncommitted — the O-2 `validation-error-message`
> fix and the three doc edits — are all in history now.

### The merge is IN — committed by the operator

`git merge --no-ff --no-commit FETCH_HEAD` was authorised, staged by the
assistant, and **committed by the operator** as `e2339b7eb` at 12:54, with
`bcede974a` following for the resume file. That is the intended workflow: the
assistant stages and stops; the operator reviews and commits.

Three conflicts, all resolved:

| File | Kind | Resolution |
| --- | --- | --- |
| `server/src/types/express.d.ts` | adjacency | Both sides. Upstream's `identityContextId`, plus the fork's multi-line `source` union carrying `proxy_header` |
| `server/src/__tests__/openapi-routes.test.ts` | **semantic** | Operator chose: keep the fork's two entries only. Upstream emptied `explicitOpenApiCoverageExclusions` and moved its three into `apiPrefixes`; that is taken as-is, and `codex-vaults.ts` / `claude-vaults.ts` stay excluded |
| `pnpm-lock.yaml` | regenerate | Took upstream's (`392ab26b1` refreshed it). `--frozen-lockfile` then installed clean, which proves the fork carries no dependency divergence |

One repair that is **not** part of the merge and can be reviewed separately:

```
M server/src/__tests__/server-startup-feedback-export.test.ts
```

The §4.1 known-failing suite, red since Session 18. Now **18/18**. See *What was
learned* below — it was not the one-line fix §4.1 recorded.

### The very next action

**Nothing is blocking.** The merge is committed, the full suite has run, the
session entry is written (§8, Session 19) and change set 11 is registered.
What remains is uncommitted, for the operator to review and commit:

```
M ui/src/components/CompanySettingsSidebar.production.tsx   THE USER-VISIBLE FIX (below)
M CustomCodeDoc/Review and Test Changes.md    Session 19 entry, §7.0, procedural fixes
M CustomCodeDoc/SESSION-RESUME.md             this file
M CustomCodeDoc/CHANGELOG.md                  change set 11 entry
A CustomCodeDoc/Outseta provisioning worker.md  change set 11's document
A scripts/verify-fork.sh                      the procedure, executable (§7.0)
```

### The one user-visible fix in this tree

**"Codex logins" and "Claude logins" were missing from Settings in production
builds** — reported after testing the merged release. **Not caused by the
merge**, which changed none of those files. Upstream keeps a parallel
`.production` component family and `App.tsx:819` picks between them on
`streamlinedUiEnabled`; the fork's two nav entries existed in the streamlined
sidebar only. With the streamlined UI off, they vanished while **"Adapters" —
on the identical gate, one line above — stayed visible**, because that entry is
upstream's and lives in both files.

The pages were reachable by URL the whole time and every test passed. Fixed by
mirroring the pair into `CompanySettingsSidebar.production.tsx`. UI typecheck
clean; sidebar + nav suites 12/12; guarded in `verify-fork.sh`.

**Standing rule this earned:** when upstream adds a `.production` (or any
parallel) variant of a file the fork has patched, **assume the patch is missing
from the new one.** Nothing conflicts, nothing fails, no test notices.
`find ui/src -name "*.production.tsx"` lists 20 such files today.

**Before the next merge, run this instead of copying commands by hand:**

```bash
./scripts/verify-fork.sh guards     # ~3 min, before you touch anything
./scripts/verify-fork.sh targeted   # ~15 min, after the merge is staged
./scripts/verify-fork.sh full       # ~90 min, for the recorded result
```

Both fast lanes were run this session and pass, exit 0.

### Results — the whole run

| Check | Result |
| --- | --- |
| `corepack pnpm run typecheck` | **exit 0**, 0 `error TS` |
| `corepack pnpm install --frozen-lockfile` | clean; both patches applied (`embedded-postgres`, `acpx`) |
| `general-server` | 15 failed, 494 passed, 2 skipped (511 files) |
| `general-workspaces-a` — UI | **561/561 files, 5522/5522 tests** |
| `general-workspaces-a` — CLI | 1 failed, 61 passed — the one failure is the env leak below |
| `general-workspaces-b` | 1 failed, 85 passed |
| serialized, **re-run per file** | **3 failed of 143** (the script's own run truncated at 58) |
| Change set 1 — proxy header auth | **28/28** |
| Change sets 3+4 — credential vaults | **83/83** |
| Change set 5 — vault preset | **20/20** |
| Change set 6 — invite guard | **19/19** (§7.2 said 18; upstream added one) |
| Change set 10 — duplicate agent | **5/5** and **69/69** (§7.2 said 67) |
| `openapi-routes.test.ts` | **5/5** — the semantic-conflict canary |
| Provisioning (codex-home + `agent.task`) | **17/17** |
| `server-startup-feedback-export.test.ts` | **18/18** — red since Session 18 |

**No fork-caused failures.** All 20 failing suites are either already in the
register or provably upstream's — the evidence for each is in the Session 19
entry.

### What was learned — do not lose this

**1. `PAPERCLIP_NO_BROWSER` is a fourth member of the §7.5 #2 env-leak class**,
and its tell is different from the other three: it produces `Number of calls: 0`
rather than a wrong value. A variable that suppresses an action leaves an
*absence*, and an absence looks like broken code, not contamination. `$CLEAN` in
§7.1 now unsets it.

**2. Change set 11's real risk is inverted from the rest of §4.** The other
change sets are hunks inside upstream files, at risk of being overwritten. The
provisioning module is mostly net-new files that never conflict — what threatens
it is upstream changing an API its handlers call *under an unchanged signature*.
That list is now in `Outseta provisioning worker.md`. Its three `index.ts` lines
are the fork's worst silent failure: lose them and everything stays green while
the instance onboards nobody.

**3. §4.1's "one-line repair" for `server-startup-feedback-export.test.ts` was
wrong, and the shape matters more than the fix.** It needed **five** mock
exports: `agentWakeupRequests`, `documents`, `heartbeatRuns`, `issueDocuments`,
`issues`. They cannot be predicted — the import throws at *module scope*, so
vitest names one at a time and each is found by adding the last and re-running.
If the fork's provisioning imports widen again, expect the loop, not a line.

**4. The serialized truncation is worse than recorded** — 58 of 143 ran, 85
(59%) did not. One of the three real failures sits after the abort point and has
been invisible in every serialized run this fork has logged. Never quote a
serialized tally that came from the script.

**5. Byte-identity substitutes for the scratch-worktree check.** Six new
`heartbeat-*` failures after upstream rewrote `heartbeat.ts` by 345 lines were
classified as upstream's by proving the fork has never touched the file and that
both implementation and tests are byte-identical to the upstream tip. Cheaper
than a worktree with its own `node_modules`, and stated as an argument rather
than a measurement.

**6. The pre-merge baseline is worth taking.** Running the known-failing suite on
the clean tree *before* merging classified it as pre-existing in seconds instead
of investigating it as merge damage.

### Open items carried

| Id | Owner | One line |
| --- | --- | --- |
| ~~O-6~~ | this document | ~~Register the provisioning module as change set 11~~ **DONE 2026-09-08.** §4 row, §4.1 entry, §6.5 grep, §7.2 suites, `Outseta provisioning worker.md`, CHANGELOG entry. |
| O-3 | upstream, really | No migration strips `modelProfiles` from existing rows; each path sanitises for itself. |
| O-4 | change sets 3 and 4 | `PAPERCLIP_CODEX_VAULT_ROOT` / `PAPERCLIP_CLAUDE_VAULT_ROOT` override the vault roots but appear in no markdown, `.env.example`, or `docker/`. |
| O-5 | change set 3 | `/sysops/llm/openrouter/` is **not** a managed vault — just a directory beside the two real roots. |

---

## The disconnection protocol — do this every session

Adopted 2026-09-04 because sessions have been dropping mid-work. The cost of
these steps is small; the cost of reconstructing an hour of undocumented reasoning
from a diff is not.

### On resume — before touching anything

1. **Read this file.** It is the only place that claims to be current.
2. `git status --short && git log --oneline -3` — confirm the branch and HEAD
   match the table above. **If they do not, this file is stale — trust git, and
   say so rather than proceeding on the table.**
3. Open the active work item's document and go to its **Resume point** section.
4. Re-run the verification commands listed there. Do not trust a recorded "green"
   across a disconnection — the tree may have moved.

> **If you ever resume mid-merge** (not the case now — this one is committed):
> a staged, uncommitted tree is the intended state, not damage.
> `git status --short | grep -E '^(UU|AA|DU|UD)'` returning nothing means every
> conflict is resolved. To start over, `git merge --abort`; to discard the whole
> thing, `git reset --hard pre-merge-backup-<branch>`. **Neither without asking.**

### While working — the checkpoint rule

**Write the finding down when you find it, not when the task ends.** Specifically,
checkpoint after any one of these, whichever comes first:

- [ ] A root cause is identified — record it *with the evidence*, before fixing it.
- [ ] A file is edited — add it to the dirty-file table above with a reason.
- [ ] A test run completes — record the command and the counts.
- [ ] A second, unrelated defect is found — give it an `O-n` open item.
- [ ] A decision is taken not to do something — record what and why. This is the
      first thing lost in a disconnection and the most expensive to recover.
- [ ] Roughly every 30 minutes of work regardless.
