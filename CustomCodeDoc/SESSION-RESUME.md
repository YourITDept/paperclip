# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-09 00:05

| | |
| --- | --- |
| **Branch** | `W8-20260908c` |
| **HEAD** | `ad3ed43fe` "Changed for merge" · merge commit `c31befe27` |
| **Working tree** | **Dirty — documentation only.** The merge is committed (`c31befe27`). Full suite complete. |
| **Active work item** | Session 20 — upstream merge (14 commits, upstream tip `7ed122911`) |
| **Its document** | [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §8, Session 20 |
| **Rollback tag** | `pre-merge-backup-W8-20260908c` → `a134c5d83` |

> **This file was stale again** (it claimed `W8-20260908a` / `bcede974a`). Git
> won, per the protocol below. The operator has since committed the sidebar fix
> (`9f2672b46`) and `membership.remove` (`6e79cd1b9`).

### What is staged

`git merge --no-ff --no-commit FETCH_HEAD`, authorised 2026-09-08.
**14 commits, 350 files, +29937/−5967** — about four times the previous merge.

| File | Kind | Resolution |
| --- | --- | --- |
| `ui/src/pages/NewAgent.tsx` | **semantic** | Took upstream's. See below |
| `ui/src/pages/NewAgent.test.tsx` | **semantic** | Took upstream's |
| `pnpm-lock.yaml` | regenerate | Not a conflict — a `patchedDependencies` HASH mismatch. See below |

### CHANGE SET 5 IS DEGRADED — the thing to decide next

Upstream #13011 replaced the fork's 500-line `NewAgent.tsx` with a **14-line
wrapper** around a new `NewAgentSetup` (1149 lines), and deleted the §4.1 canary
test. The operator chose *take upstream's page, port later*.

Consequence, live now, and it is **worse than "the operator types it"** — that
was the first reading and it was wrong. The vault button still navigates and
still selects the runtime via `?adapterType=`, but:

- `parseNewAgentEnvPreset` is orphaned — nothing reads `?env=CODEX_HOME=…`; and
- **the new setup flow has no free-form environment field at all.**
  `NewAgentSetup.tsx:329` sets `envBindings: nextConnection?.env ?? {}` — env
  comes *only* from a selected connection. There is nowhere to type a vault
  path during creation.

So a vault-bound agent **cannot be created in one step any more.** The
capability is not lost — `AgentConfigForm` still carries the env editor and is
still rendered from `AgentDetail.tsx` — but the flow is now: create the agent,
then open Agent detail and set `CODEX_HOME` / `CLAUDE_CONFIG_DIR` by hand.

**Upstream has not converged on this.** Its new `SETUP_CREDENTIAL_KEYS`
(`ui/src/lib/agent-setup-fields.ts`) maps adapters to **API keys**
(`CURSOR_API_KEY`, `GEMINI_API_KEY`, …) and does not list `codex_local` or
`claude_local` at all. A vault *directory* is a different concern, so
"retire change set 5 and use upstream's flow" is **not** available on the
evidence — retiring it would lose a capability upstream does not provide.

**The cs5 suite reports 45 passing and that number means nothing about the fork's
half** — it is upstream's tests. `verify-fork.sh` now prints a WARN for this
exact case rather than letting a green suite hide it.

The port target, when it is decided, is
`ui/src/components/new-agent/NewAgentSetup.tsx` — a 1149-line file upstream is
actively rewriting, which is the argument for deciding it deliberately rather
than during a merge.

### The very next action

**Testing is COMPLETE. Nothing blocks a deployment test.**

The remaining work is a decision, not a task: **O-7**, change set 5. Port the
env preset into `ui/src/components/new-agent/NewAgentSetup.tsx`, or accept the
two-step create-then-edit flow permanently. Retiring it is not available —
upstream's credential mechanism does not cover vault directories.

Uncommitted, for review:

```
M CustomCodeDoc/Review and Test Changes.md    Session 20 entry, §7.5 #3 + #7, cs5 DEGRADED
M CustomCodeDoc/SESSION-RESUME.md             this file
```

### Final result — full suite, 2026-09-08

| Check | Result |
| --- | --- |
| Guards (14) | **all PASS**, one WARN (cs5 degraded, expected) |
| `typecheck` | **exit 0**, 0 `error TS` |
| §7.2 change-set suites (9) | **all PASS** — cs1 28, cs3+4 83, parity 4, cs5 45, cs6 19, cs10 5 + 69, openapi 6, cs11 27 |
| `general-server` | 15 failed, 505 passed, 2 skipped (522) |
| `general-workspaces-a` — UI | **566 / 566** |
| `general-workspaces-a` — CLI | **62 / 62** |
| `general-workspaces-b` | 1 failed, 92 passed |
| serialized, per file | **140 passed, 3 failed of 143** |

**No fork-caused failures.** The `general-server` failing set is **identical** to
Session 19 — not one new, not one gone. All 16 failures reproduce individually
on an idle machine (so none is contention), and all 14 implicated files are
**byte-identical to upstream `7ed122911`** — including `heartbeat.ts`, which
upstream rewrote across 5 commits in this merge.

**The CLI project went 1 failure → 62/62**, confirming Session 19's
`PAPERCLIP_NO_BROWSER` scrub actually fixed it.

### Deploying this build

Three new migrations (`0246`–`0248`). `PAPERCLIP_MIGRATION_AUTO_APPLY=true` is
set, so watch the boot log first. Then two fork-specific checks:

- `provisioning: worker enabled` in the log (change set 11 — its loss is silent)
- Codex/Claude login tabs visible in Settings (Session 19 shipped a regression
  here that went unnoticed for a week)

### Two mistakes made this session — both now fixed in the script

1. **Never edit `verify-fork.sh` while a run is executing it.** Bash tracks
   position by byte offset, so inserting lines mid-file makes the remainder
   execute garbled text. A 90-minute run was killed rather than trusted.
   Run a copy (`cp scripts/verify-fork.sh /tmp/…`) if the script must change.
2. **A copy must still resolve the repo root.** `cd "$(dirname "$0")/.."` from
   `/tmp` resolves to `/`; pnpm then walks the whole filesystem and every suite
   reports `Command "vitest" not found` or 0 tests — which looks **exactly** like
   §7.5 #1's missing-plugin-sdk signature and sends you to the wrong place. The
   script now resolves the root robustly and exits 2 with a clear message if it
   cannot.

### Findings so far

**Trap #3 in a new form.** `--frozen-lockfile` failed on `patchedDependencies`.
The entry *names* matched on all three sides — it was the **hashes**: upstream
edited two patch files (`acpx@0.13.1` +142 lines,
`@agentclientprotocol/codex-acp@1.6.2` +10) without regenerating the lockfile.
The fork carries no patch changes, so it is purely upstream's. Regenerated with
`--no-frozen-lockfile`; the diff is 17 lines and exactly those two hashes.

**Trap #5's abandoned processes are still happening.** A 9-hour-old
`paperclip-company-cli-e2e` held 714 MB and **ignored SIGTERM**, exactly as the
trap records. Cleared with `kill -9` before the run.

### Open items carried

| Id | Owner | One line |
| --- | --- | --- |
| **O-7** | change set 5 | Decide the port into `NewAgentSetup.tsx`, or retire the `?env=` half. **Degraded until then**, with a WARN in the guards. |
| O-3 | upstream, really | No migration strips `modelProfiles` from existing rows. |
| O-4 | change sets 3 and 4 | `PAPERCLIP_CODEX_VAULT_ROOT` / `PAPERCLIP_CLAUDE_VAULT_ROOT` appear in no markdown, `.env.example`, or `docker/`. |
| O-5 | change set 3 | `/sysops/llm/openrouter/` is **not** a managed vault. |

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
