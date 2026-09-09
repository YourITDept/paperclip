# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-09 16:05

| | |
| --- | --- |
| **Branch** | `W8-20260909a` |
| **HEAD** | `1bf2c3176` "Merge branch 'W8-20260908c' …" |
| **Working tree** | **Mid-merge, staged, uncommitted.** `MERGE_HEAD` = `5acf56658`. This is the intended state, not damage. |
| **Active work item** | Session 21 — upstream merge (5 commits, upstream tip `5acf56658`) |
| **Its document** | [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §8, Session 21 |
| **Rollback tag** | `pre-merge-backup-W8-20260909a` → `1bf2c3176` |

> **The previous copy of this file was stale** (it claimed `W8-20260908c` /
> `ad3ed43fe`). Git won, per the protocol below. Since then the operator cut
> `W8-20260909a` and committed `c5560d16f` (the agent-nav fix and the O-7 port).

### Testing is COMPLETE — targeted green, full suite classified

**Targeted** (`./scripts/verify-fork.sh targeted`) — **exit 0, all PASS.**
22 guards, typecheck 0 `error TS`, and 10 change-set suites at baseline:
cs1 28 · cs3+4 83 · parity 4 · cs5 48 · cs6 19 · cs10 5 and 69 · openapi 6 ·
cs11 27 · **cs11 startup wiring (db mock) 18** (new to this lane).

**Full** (`./scripts/verify-fork.sh full`) — **exit 1, and correctly so.**

| Group | Result | Scored |
| --- | --- | --- |
| `general-server` | 9 failed, 513 passed, 2 skipped (524) | FAIL vs baseline 8 |
| `general-workspaces-a` UI / CLI | **565/565** · **62/62** | PASS |
| `general-workspaces-b` | 1 failed, 164 passed (165) | PASS (baseline 1) |
| serialized, per file | **0 failed of 144** | PASS |

**Nothing here is a fork defect.** Of `general-server`'s 9: eight are standing
upstream failures (byte-identical to `5acf56658`; none of their subjects is among
the 86 files the fork carries), and the ninth —
`provisioning-membership-remove.test.ts`, fork-carried — is an embedded-Postgres
prefix collision that passes **10/10** alone. Baseline stays 8 on purpose so a
genuine ninth is not hidden.

### Changes being kept — the review inventory

Everything below is **uncommitted and staged for review in the IDE**. Read the
*unstaged* half of the `MM`/`AM` files separately from the staged half: the staged
half is upstream's merge content, the unstaged half is the fork's change on top.

#### 1. The merge itself — 191 files, staged, `MERGE_HEAD` = `5acf56658`

Upstream `paperclipai/master`, 5 commits (#12950, #13062, #13064, #13063, #13068).
Two conflicts, both adjacency, both change set 10, both kept-both. One new
migration, `0249`.

#### 2. Fork change #4 (O-8) — Paperclip Runner held OFF

**Why:** #13068 flipped `enableNativeRunner` on by default for self-hosted.
Paperclip Runner is an experimental second execution path — a Rust daemon whose
ADR is still `Status: Proposed`. The operator wants it exercised in a dedicated
Rust environment first. Also stops `pnpm dev` building runnerd.

| File | Δ | What |
| --- | --- | --- |
| `packages/shared/src/validators/instance.ts` | +6 −1 | schema default → `false` |
| `packages/shared/src/feature-catalog.ts` | +7 −4 | `selfHostedDefault` → `false` (must match the schema) |
| `server/src/services/instance-settings.ts` | +4 −2 | read-time `?? false` + parse-failure fallback |
| `server/src/__tests__/instance-settings-cloud-defaults.test.ts` | +32 −6 | 6 assertions marked `FORK #4`, 1 marked `FORK #3` |

Full reasoning: [`ReverseProxyCustomChanges.md`](CustomCodeDoc/ReverseProxyCustomChanges.md) §0.1 #4.
**Reversible** — restore `true` at all four sites and the six assertions.

#### 3. `scripts/verify-fork.sh` — six fixes, all from this session's failures

| Fix | Why it is being kept |
| --- | --- |
| `PAPERCLIP_HOME` redirected in the scrub | 5th env leak. Made the cs10 canary report 18/69 failed — indistinguishable from the merge dropping a fork hunk. §7.5 #2b-4. |
| `PAPERCLIP_PROVISIONING_WORKER_ENABLED` unset | 6th. Change set 11's worker registers a `setInterval` that displaces the callback an upstream test captures. §7.5 #2b-5. |
| `PAPERCLIP_ADAPTERS` / `_FILE` unset **+ scratch home wiped per run** | 7th/8th, and the only ones that **write to disk**: `startServer()` reconciles them into `adapter-settings.json`, poisoning later suites and the next run. Both halves needed. §7.5 #2b-6. |
| `-u` flags ordered before the `VAR=VAL` | `env` stops option parsing at the first assignment; a `-u` after it becomes the command and every suite reports `0 passed`. Broke it, fixed it, wrote the constraint into the file. |
| `fork_default_off` guard ×3 | **There was no guard for the fork's flag defaults at all.** |
| §7.1 groups scored; `cs11 startup wiring` added to the targeted lane | `full` used to exit **0** with ten failing files. The db-mock canary ran only in the 90-minute lane. |

#### 4. `pnpm-lock.yaml` (+7 −7) — generated, not authored

Two `patchedDependencies` hashes. Upstream changed two patch files without
regenerating; `--frozen-lockfile` refuses until this is done. Third recurrence of
§7.5 #3. **RULE 0 counts generated files — this is still yours to review.**

#### 5. Documentation

| File | Δ | What |
| --- | --- | --- |
| `Review and Test Changes.md` | +265 −6 | §8 Session 21, §7.5 #2b-4 (the fifth env leak), §4 cs5 restored, §4.1 gains `Layout.production.tsx` |
| `ReverseProxyCustomChanges.md` | +79 | fork change #4, and a correction to #3's stale "no runtime consumers" claim |
| `SESSION-RESUME.md` | +85 −111 | this file |

#### Not changed, deliberately

- `/shared/paperclip/adapter-settings.json` — live instance state. It disables 14
  adapter types, which is what made the cs10 canary look broken. The *test
  environment* was wrong, not the deployment.
- Upstream's `enableNativeRunner` behaviour itself — only the default moved. An
  explicit stored `true` still wins, and the Settings toggle works normally.

### The very next action

**A decision, then a deployment test.** Nothing blocks either.

1. Review the staged merge **and the O-8 override** in the IDE, then commit.
   **RULE 0 — the operator commits, not the assistant.**
2. Optionally run `./scripts/verify-fork.sh full` (~90 min) before deploying.

> **O-8 is decided and applied.** `enableNativeRunner` is held OFF as fork change
> #4 (ReverseProxyCustomChanges §0.1 #4). Paperclip Runner gets tested in a
> dedicated Rust environment before the fork adopts it.

### Deploying this build

One new migration (`0249`). `PAPERCLIP_MIGRATION_AUTO_APPLY=true` is set, so
watch the boot log first. Then the two standing fork-specific checks:

- `provisioning: worker enabled` in the log (change set 11 — its loss is silent)
- Codex/Claude login tabs visible in Settings (Session 19 shipped a regression
  here that went unnoticed for a week)

And one new to this build:

- **Open an agent and confirm the left nav lists Instructions / Skills / Runtime
  / Secrets / Tools / Permissions / API Keys / Revisions.** Session 21 Finding 4
  — that nav was absent in the production shell after #13011, with every route
  still resolving and every suite still green.

### Findings this session

**A fifth `PAPERCLIP_*` env leak, and the worst-behaved one yet.**
`PAPERCLIP_HOME=/shared/paperclip` is the live instance state, read straight off
disk by `adapter-plugin-store.ts`. It made the **cs10 canary** report 18/69
failed — impersonating exactly the "merge dropped a fork hunk" signal that suite
exists to raise. Hermetic home → 69/69. Full account at §7.5 #2b-4.

**The scoping trap.** The compare URL said upstream was one commit ahead; that
was relative to `W8-20260908d`, not an ancestor of this branch. From here it is
five. Always check `git log --oneline HEAD..FETCH_HEAD`.

**A fork default arrived red and nothing caught it.** #13068's new
`instance-settings-cloud-defaults.test.ts` asserts `enableStreamlinedUi` is
`true`; fork change #3 makes it `false`. Typecheck is clean, no §7.2 suite covers
the file, and the guards grep the source rather than upstream's assertions about
it. Found only because O-8 sent us into that file. `verify-fork.sh` now carries a
`fork_default_off` guard for all three flag defaults — **there was none before.**

**I hit §7.5 #7 myself:** edited `verify-fork.sh` mid-run and garbled the running
copy. One wasted run. The temptation arrives exactly when you decide to add a
guard.

### Open items carried

| Id | Owner | One line |
| --- | --- | --- |
| ~~O-8~~ | fork defaults | **CLOSED 2026-09-09.** `enableNativeRunner` held OFF as fork change #4. Revisit after the Rust environment test. |
| ~~O-7~~ | change set 5 | **CLOSED 2026-09-09.** The preset is ported into `NewAgentSetup`; the guard prints `wired`. |
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

> **You are resuming mid-merge right now.** A staged, uncommitted tree is the
> intended state, not damage.
> `git status --short | grep -E '^(UU|AA|DU|UD)'` returning nothing means every
> conflict is resolved — it does, as of this writing.
> To start over, `git merge --abort`; to discard the whole thing,
> `git reset --hard pre-merge-backup-W8-20260909a`. **Neither without asking.**

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
