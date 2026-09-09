# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-09 19:45

| | |
| --- | --- |
| **Branch** | `W8-20260909b` |
| **HEAD** | `93da2d008` "Merge pull request #47 from paperclipai/master" |
| **Working tree** | Dirty — **2 files**, both reviewable. No merge in progress. |
| **Active work item** | Session 22 — verifying PR #47 (13 commits, upstream tip `7d84b183f`) |
| **Its document** | [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §8, Session 22 |

The Session 21 merge and the O-8 override are **committed** — they are in history
below `93da2d008`. Nothing from that session is outstanding.

## Verification of PR #47 — COMPLETE

`./scripts/verify-fork.sh full` — **exit 1**, correctly, on one upstream failure.

| Check | Result |
| --- | --- |
| Guards (22) | **all PASS** — every fork hunk survived the GitHub merge |
| `typecheck` | **exit 0**, 0 `error TS` |
| §7.2 suites (10) | **all PASS at baseline** |
| `general-server` | 9 failed, 519 passed, 2 skipped (530) |
| `general-workspaces-a` | **566/566** UI · **62/62** CLI |
| `general-workspaces-b` | **0 failed** (was 1) |
| serialized, per file | **0 failed of 144** |

**No fork defect.** The single non-baseline failure,
`native-codex-runner.integration.test.ts`, is upstream's — it reproduces alone,
both files are byte-identical to upstream, neither reads `enableNativeRunner`, and
the runner binary is current. Baseline raised 8 → 9.

**`github-launcher` is FIXED** by `82f662656`, whose `fix(runner)` title conceals
that it changes shared `adapter-utils` code. Baseline lowered 1 → 0.

## Uncommitted, for the operator's review

```
M pnpm-lock.yaml                            8 lines, one patch hash — §7.5 #3, FOURTH recurrence
M scripts/verify-fork.sh                    group baselines: general-server 8->9, workspaces-b 1->0
M CustomCodeDoc/Review and Test Changes.md  §8 Session 22
M CustomCodeDoc/SESSION-RESUME.md           this file
```

`pnpm-lock.yaml` is generated but **still yours to review and commit** (RULE 0).

## The very next action

1. Review the four files above and commit. **RULE 0 — the operator commits.**
2. Deployment test, if you are shipping this build.

### Deploying this build

Standing fork-specific checks:

- `provisioning: worker enabled` in the boot log (change set 11 — its loss is silent)
- Codex/Claude login tabs visible in Settings
- Open an agent and confirm the left nav lists Instructions → Revisions

New to this build:

- **The agent list no longer has per-row action buttons** (`622376e99`), in the
  production shell too. Assign Task / Run Heartbeat / Pause now live on the agent
  detail page. This is upstream's deliberate change, not a regression.

## Open items carried

| Id | Owner | One line |
| --- | --- | --- |
| **O-9** | upstream | `native-codex-runner.integration.test.ts` returns `runTerminalState: "failed"`. Introduced by PR #47, likely `668110469`. Baseline 9 until upstream fixes it. **New.** |
| O-8-follow | change set 11 | Consider making the provisioning worker inert under `NODE_ENV=test`. `startServer()` gained another `setInterval` in `35fdc0c66`; the §7.5 #2b-5 surface keeps widening. |
| O-3 | upstream, really | No migration strips `modelProfiles` from existing rows. |
| O-4 | change sets 3 and 4 | `PAPERCLIP_CODEX_VAULT_ROOT` / `PAPERCLIP_CLAUDE_VAULT_ROOT` appear in no markdown, `.env.example`, or `docker/`. |
| O-5 | change set 3 | `/sysops/llm/openrouter/` is **not** a managed vault. |

---

## The disconnection protocol — do this every session

Adopted 2026-09-04 because sessions have been dropping mid-work.

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
