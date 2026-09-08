# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-08 12:45

| | |
| --- | --- |
| **Branch** | `W8-20260908a` |
| **HEAD** | `60a77857b` "Packaged up compiled code for release W8-20260907a" |
| **Working tree** | **MERGE IN PROGRESS — staged, uncommitted, 175 files.** Upstream merge; conflicts resolved; awaiting the operator's review and commit. |
| **Active work item** | Session 19 — upstream merge (8 commits, upstream tip `297d8741f`) |
| **Its document** | [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §8, Session 19 |
| **Rollback tag** | `pre-merge-backup-W8-20260908a` → `60a77857b` |

> **The previous version of this file was four days stale** (it claimed
> `W7-20260904a` / `df401863f`). Per the resume protocol below, git won. The
> change sets it described as uncommitted — the O-2 `validation-error-message`
> fix and the three doc edits — are all in history now.

### What is staged

`git merge --no-ff --no-commit FETCH_HEAD`, authorised by the operator
2026-09-08. **The merge commit has not been made.** 175 files: 129 modified,
46 added.

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

**Read the four-group suite result**, then append the Session 19 entry to §8 of
`Review and Test Changes.md` and hand the tree over.

```bash
ls /tmp/paperclip-tests/complete.flag        # exists = finished
grep -hE "Test Files|Tests  " /tmp/paperclip-tests/g*.log
grep -cE '^ Test Files' /tmp/paperclip-tests/g2.log   # MUST be 2 — see §7.1
```

Everything before it is done: typecheck exit 0 with zero `error TS`, and every
§7.2 targeted suite green (counts in the table below).

### Verified so far

| Check | Result |
| --- | --- |
| `corepack pnpm run typecheck` | **exit 0**, 0 `error TS` |
| `corepack pnpm install --frozen-lockfile` | clean; both patches applied (`embedded-postgres`, `acpx`) |
| Change set 1 — proxy header auth | 3 files, **28/28** |
| Change sets 3+4 — credential vaults | 4 files, **83/83** |
| Change set 5 — vault preset | 2 files, **20/20** |
| Change set 6 — invite guard | **19/19** (§7.2 says 18 — upstream added one) |
| Change set 10 — duplicate agent | **5/5** and **69/69** (§7.2 says 67 — upstream added two) |
| `openapi-routes.test.ts` | **5/5** — proves the semantic resolution is right in both directions |
| Provisioning (codex-home + agent.task) | **17/17** |
| `server-startup-feedback-export.test.ts` | **18/18** — was red since Session 18 |

### What was learned — do not lose this

**1. §4.1's "one-line repair" for `server-startup-feedback-export.test.ts` was
wrong, and the shape of the fix matters more than the fix.** It needed **five**
mock exports, not one: `agentWakeupRequests`, `documents`, `heartbeatRuns`,
`issueDocuments`, `issues`. They cannot be predicted — each is found by adding
the previous one, re-running, and reading the next name out of the error. The
import throws at *module scope*, so the signature is `Tests: no tests` plus
`No "<name>" export is defined`, never an assertion failure. If the fork's
provisioning imports widen again, expect the loop, not a line.

**2. The provisioning module is NOT in the §4 register**, and it should be. It
is the fork's largest carried change (`server/src/provisioning/`, five files,
plus two lines in `server/src/index.ts`) and nothing in the review procedure
protects it. It survived this merge by luck rather than by check — see the
Session 19 entry for the specific reason it was never at risk this time.

**3. The pre-merge baseline is worth taking.** Running the known-failing suite
on the clean tree *before* merging is what let it be classified as pre-existing
in seconds rather than investigated as merge damage.

### Open items carried

| Id | Owner | One line |
| --- | --- | --- |
| **O-6** | this document | Register the provisioning module as change set 11 in §4, with `server/src/index.ts` as a §4.1 collision point. **Not done — proposed only.** |
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

> **If you resume mid-merge:** the tree is staged and uncommitted and that is
> the intended state, not damage. `git status --short | grep -E '^(UU|AA|DU|UD)'`
> returning nothing means every conflict is resolved. To start over,
> `git merge --abort`; to discard the whole thing,
> `git reset --hard pre-merge-backup-W8-20260908a`. **Neither without asking.**

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
