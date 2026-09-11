# CustomCodeDoc — change log

Append-only. **Newest first.** One entry per work item, added when the work starts
and amended as it moves — not written up at the end, because the end is exactly
what a dropped connection takes away.

**Scope:** changes *this fork* makes. Upstream merges get an entry too, because
they are the thing most likely to undo a fork change, but the detail lives in the
`SYNC-*.md` documents rather than here.

**Status vocabulary — used strictly:**

| Status | Means |
| --- | --- |
| `IN PROGRESS` | Being worked now. `SESSION-RESUME.md` points at it. |
| `AWAITING REVIEW` | Code complete, tests green, **uncommitted**. The operator commits (RULE 0). |
| `COMMITTED` | On the branch. Not necessarily released. |
| `LIVE-VERIFIED` | Watched to work on a running instance, not merely unit-tested. **A green suite does not earn this.** |
| `RETIRED` | Deliberately removed. Kept here so old references resolve. |

---

## 2026-09-11 — Change set 11: agent instructions in the `agent.create` payload

**Status:** `AWAITING REVIEW` — uncommitted on `W8-20260909e` @ `ec65a3a4e`
**Document:** [`Provisioning agent instructions.md`](CustomCodeDoc/Provisioning%20agent%20instructions.md)

**The ask (operator):** let the onboarding tooling send an agent's instructions,
to add to or replace the default bundle. **Constraint:** with no instructions
sent, behave exactly as before.

**What changed.** `agent.create` accepts an optional `instructions`:

- a string, appended to `AGENTS.md`;
- `{ files, mode: "append" }` (the default), which adds each file after the
  default file of the same name;
- `{ files, mode: "replace", entryFile? }`, which uses only the given files.

**It is validated before the agent is created**, so bad input fails
permanently (`invalid_instructions`, `instructions_not_supported`) with no agent
left behind. Instructions are written on **create only**; an existing agent is
logged and left alone.

**The no-instructions path is unchanged:** same code path, same log line, and the
three original tests pass unmodified.

**Tests:** `provisioning-agent-instructions.test.ts` 17/17 (3 original + 14
new); all provisioning suites 48/48; server `tsc` clean. `verify-fork.sh`
"cs11 provisioning" baseline 30 → 44.

**Not `LIVE-VERIFIED`.**

---

## 2026-09-11 — Change set 11: claim provisioning jobs in `sequence` order

**Status:** `COMMITTED` — `ec65a3a4e` on `W8-20260909e` (operator, 2026-09-11 21:25: "All seems to be working with the creation of the sequence number")
**Document:** [`Outseta provisioning worker.md`](CustomCodeDoc/Outseta%20provisioning%20worker.md)
§ "Claim order: `sequence`"

**The report (onboarding side):** memberships were claimed before the company
they name, and parked for 5 minutes. `created_at` cannot carry insertion order:
its default `now()` is the transaction's start time, so every row one insert
writes ties. The tooling worked around it with `now() + index seconds`, which
spread a 28-job plan 27 seconds into the future, and a separate per-user command
a second later sorted into the middle of it. Seen three times on `db_dev071`
today (`TES`/`TESA`, `PRO`, `PROJ`).

**What changed.** One line in `server/src/provisioning/store.ts` `claimOne`:
`ORDER BY created_at` → `ORDER BY sequence`. `created_at` stays as the time a
job was queued.

**No schema change on this side, and none needed.** The request asked for the
column in the fork's drizzle schema with a migration. The fork has neither for
this table: `packages/db` defines no `provisioning_jobs`, no migration touches it,
and nothing in `server/src/provisioning/` creates it. `database.js` owns the DDL
and adds `sequence bigint GENERATED ALWAYS AS IDENTITY` plus
`provisioning_jobs_sequence_idx`. This side only ever `UPDATE`s the table, so
`GENERATED ALWAYS` refusing writes cannot affect it.

**Consequence of not owning the column:** a queue created before `database.js`
added it now fails the claim with `42703 column "sequence" does not exist`.
`guard()` passes only missing-table and missing-schema errors through as "idle",
so this surfaces as an error rather than a silent stall.

**Verified** on `db_dev071`: the exact claim statement, run inside a transaction
and rolled back, parses and returns `sequence` 1. **No automated test covers the
claim SQL**; the provisioning suites call the handlers directly.

**Rollout step 3** (onboarding side drops the `+ index seconds` offset) is safe
only once a server running this build is draining the queue.

**Not `LIVE-VERIFIED`.**

---

## 2026-09-11 — Change set 12: agents missing from the `paperclip` skill page

**Status:** `AWAITING REVIEW` — uncommitted on `W8-20260909e` @ `6333848f6`
**Documents:** this entry; the provisioning half is in
[`Outseta provisioning worker.md`](CustomCodeDoc/Outseta%20provisioning%20worker.md)
§ "Default `paperclip` skill on `agent.create`"

**The report (operator):** `paperclip` is the standard skill for every agent, but
its skill page lists no agents.

**Why.** The skill page lists an agent only when the skill is in that agent's
*saved* skill list (`adapterConfig.paperclipSkillSync`, read by `usage()` in
`company-skills.ts`). Claude and Codex agents get `paperclip` mounted at run time
without it ever being saved (`resolveLegacyPaperclipDesiredSkillNames`), so the
agents had the skill and the page could not see them. Neither creation path
saved it:

| Path | Saved skills before |
| --- | --- |
| `agentRoutes` create / hire — New Agent page, Create-from-login, hire approvals | CEO only: `defaultRoleSkillSelections` returned nothing for any other role |
| `server/src/provisioning/handlers.ts` `agent.create` | None: `adapterConfig` is built from `env` and `model` only |

**What changed.**

- `routes/agents.ts` `defaultRoleSkillSelections`: non-CEO roles on
  skills-capable adapters now get `paperclipai/paperclip/paperclip`. CEOs still
  get the five core skills; `paperclip_runner` gets nothing, since it rejects the
  legacy skill. Requested skills still union with the default.
- `provisioning/handlers.ts`: `withDefaultPaperclipSkill` saves the same key on
  create. Adapters without skill sync (`http`, `process`) are left alone.

**Operator decisions (2026-09-11):** `paperclip` only for non-CEO agents, not the
five core skills. **New agents only**: `reconcileAgent` does not add it and no
backfill was run, so agents created before this still show nothing on the skill
page until the skill is ticked on their Skills tab.

**Tests.**

- New `provisioning-agent-skills.test.ts`: 4/4 (Codex, Claude, `http` untouched,
  existing agent untouched).
- `agent-skills-routes.test.ts`: upstream's "does not add default skills to
  non-CEO hires" now asserts the opposite, plus a direct-create test. 36/37; the
  one failure (`paperclip_runner` CEO defaults, 500) failed the same way before
  the change.
- `agent-adapter-validation-routes.test.ts` and `agent-permissions-routes.test.ts`:
  their `companySkillService` mocks gained `resolveRequestedSkillEntries`. Without
  it a non-CEO `claude_local`/`codex_local` create reaches an undefined mock and
  500s. Adapter-validation 32/32.
- Server `tsc --noEmit` clean.

**Not clean on this host, and not this change:** 18 permissions tests and all 5
hire-idempotency tests fail with `Adapter "process" is not available on this
instance`. This host's adapter allowlist admits only `claude_local` and
`codex_local` and survives `env -u PAPERCLIP_ADAPTERS`. The refusal comes from
`assertSelectableAdapterType`, which runs before skill defaults are chosen.

**Not `LIVE-VERIFIED`.** No agent has been created on a running instance and
watched to appear on the skill page.

---

## 2026-09-08 — Change set 11: Outseta provisioning worker (registered)

**Status:** `COMMITTED` — on `W8-20260908a`. Registration itself is
`AWAITING REVIEW` (documentation, uncommitted).
**Document:** [`Outseta provisioning worker.md`](CustomCodeDoc/Outseta%20provisioning%20worker.md)

**Not new code — new bookkeeping.** The module has been on the branch since
Session 18 and grew through 2026-09-07/08, but it was never entered in the §4
register, so no merge review had ever been told to check it. Session 19 found
that gap while merging upstream `297d8741f` and closed it.

**What the fork carries:** five net-new files under `server/src/provisioning/`
(2115 lines) plus **three lines in `server/src/index.ts`** — the import, the
`startProvisioningWorker(db, { heartbeat })` call, and `stop()` in the shutdown
handler. An Outseta signup provisions an instance through a job queue the
callback container inserts into, so **no inbound port is opened on the Paperclip
container**. Off unless `PAPERCLIP_PROVISIONING_WORKER_ENABLED=true`.

**Why registering it matters more than it sounds.** §6.2 cross-checks the
post-merge diff against the §4 list and treats a vanished change set as the
alarm. Until now this one was not on that list. Worse, it is the fork's **worst
silent-failure risk**: lose the three `index.ts` lines in a conflict resolution
and the build succeeds, the typecheck passes and every suite stays green while
the instance onboards nobody, for ever. The provisioning suites do not catch it
— they construct the handlers directly and never import `index.ts`.

**The risk profile is inverted from the rest of §4**, which is the substance of
the new document. The other change sets are hunks inside upstream files, at risk
of being overwritten. This one is mostly net-new files that never conflict; what
threatens it is **upstream changing an API its handlers call under an unchanged
signature** — `issueService.create`'s `idempotencyKey`/`onDeduplicated`,
`accessService.ensureRoleDefaultGrants`, `agentService.list`'s
`includeTerminated`, `heartbeat.wakeup`. That list is now written down with what
each silently breaks.

**Coverage, stated honestly:** 17 tests across two suites cover `secret.set`,
`agent.create` and `agent.task`. `instance.state`, `user.upsert`,
`company.create` and `membership.set` have **no unit tests on this side** — they
were verified live on `db_dev92` and have not regressed, but a merge breaking
`ensureRoleDefaultGrants` would not be caught. Not `LIVE-VERIFIED` for the newer
job types: no `agent.task` has been watched to completion on a running instance.

**Open:** no budget cap on `agent.task` (it dispatches paid agent runs); the
enqueue role is now a work-dispatch capability rather than a provisioning one;
no park ceiling.

---

## 2026-09-04 — Change set 10: duplicate agent fails with "Validation error"

**Status:** `AWAITING REVIEW` — uncommitted on `W7-20260904a` @ `2f5a2153c`
**Document:** [`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md)
**Reported by:** chris@anderson-family.com — duplicating an agent in the UI toasts
`Could not duplicate agent / Validation error`, with no field named.

**Two independent defects, both fixed:**

1. **The reported one.** Upstream `4b6de5327` (#12683, "Remove cheap model
   profiles") made `runtimeConfig.modelProfiles` an *active rejection* in
   `agentRuntimeConfigSchema`. Agent rows written before that commit still carry
   the key — nothing migrates it away — and duplicate copied `runtimeConfig`
   wholesale, so the create was refused. The client now drops retired keys before
   posting, matching what upstream already does on company import
   (`sanitizeImportedAgentRuntimeConfig`).

2. **Found while fixing it, would not have surfaced until run time.**
   `adapterConfig.env` values reach the client redacted, so a duplicate posted
   back `***REDACTED***` as a literal value — for this fork, typically a
   credential vault directory (change sets 3 and 4). The copy was created broken
   and failed much later. A new optional `duplicateFromAgentId` names the source
   so the server restores the real values, gated on same-company **and** on the
   same permission as reading the source. Applied on the hire path too, since a
   board-approval company routes duplicates there.

**Touched:** `packages/shared/src/validators/agent.ts`, `server/src/routes/agents.ts`,
`ui/src/lib/duplicate-agent-payload.ts` + both test files (7 new tests).

**Verified:** UI 5/5 · server agent-permissions 69/69 · openapi 5/5 · typecheck
clean across shared, ui, server.
**Not verified:** never reproduced or confirmed on a live instance. See §7 of the
document for the live checklist.

**Open items carried:** O-2 (the UI discards Zod `details`, which is why the toast
was bare), O-3 (no migration strips `modelProfiles` from existing rows), O-4 (the
vault-root env vars exist but are documented nowhere), O-5 (`/sysops/llm/openrouter/`
is not a managed vault). **None blocking.**

> **Amended 2026-09-04 — O-1 fixed, at the operator's direction.**
> `duplicateFromAgentId` was reaching `PATCH /api/agents/:id` too, because
> `updateAgentSchema` is derived from `createAgentSchema`, and the route stripped
> its two sibling non-column flags but not this one. One `delete` at
> `agents.ts:4683` plus two tests (server suite 67 → 69). Both new tests were
> **proved to be real guards** by removing the fix and watching them fail; that run
> also confirmed empirically that the field had been reaching `svc.update`, which
> the original finding could only infer. Change set 10 now has **no blocking open
> items** and is ready for the live checks in §7 of its document.

**New fork/upstream collision points:** `packages/shared/src/validators/agent.ts`
and `server/src/routes/agents.ts` — added to §4.1 of
[`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md).

---

## 2026-09-04 — Two standing traps recorded, from questions asked mid-review

**Status:** `AWAITING REVIEW` — documentation only, no code
**Documents:** `Review and Test Changes.md` §7.2 and §7.5 trap 6;
[`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md) O-4 and O-5

1. **`--reporter=basic` was removed in vitest 4** and fails with
   `Failed to load url basic`, which reads like broken project infrastructure but
   is a missing reporter module — the stack never names a test file. Nothing
   in-tree passes the flag, so this is a hand-typed / copied-from-old-notes trap
   only. Now trap 6 in §7.5.
2. **The vault roots are configurable and nobody could have known.**
   `PAPERCLIP_CODEX_VAULT_ROOT` and `PAPERCLIP_CLAUDE_VAULT_ROOT` override
   `/sysops/llm/codex` and `/sysops/llm/claude`, and appear in **no** markdown,
   `.env.example`, or `docker/`. Logged as O-4 against change sets 3 and 4. While
   confirming it, also found that `/sysops/llm/openrouter/` — used by §7.2's
   out-of-band check — is *not* a managed vault at all, just a directory next
   door; §7.2 now says so (O-5).

Both came from the operator reading the diff and asking why a value was hardcoded.
The first answer was "it is a test fixture, and correctly hardcoded"; the second
was the real finding. **Worth recording as a pattern: the question that turns out
to be a false alarm is often adjacent to one that is not.**

---

## 2026-09-04 — Documentation convention: survive a dropped connection

**Status:** `COMMITTED` once the operator takes it — new files, no code touched
**Reason:** sessions have been disconnecting mid-work, and the reasoning behind a
change is the part a diff cannot reconstruct.

Added [`SESSION-RESUME.md`](CustomCodeDoc/SESSION-RESUME.md) — a single
**overwritten** file holding branch, HEAD, the dirty-file table and the one next
action, plus the standing protocol: what to read on resume, when to checkpoint
mid-work, and what to write before a session ends. Added this change log. Both
are pointed to from §1.2 and §0 of `Review and Test Changes.md`.

---

## Backfill — entries before this convention existed

Reconstructed from the documents named in each row, not from independent
verification. Detail lives in those documents.

| Date | Work | Status | Document |
| --- | --- | --- | --- |
| 2026-09-04 | Session 16 — upstream merge to `af3023f1e` (95 commits) into `W7-20260903a`; all six live change sets verified intact; full suite, typecheck and a live embedded-Postgres smoke test | `COMMITTED` (`2f5a2153c`, PR #40) | [`SYNC-2026-09-04.md`](CustomCodeDoc/SYNC-2026-09-04.md) |
| 2026-09-01 | Session 15 — local upstream merge into `W6-20260901a` (14 commits); first *semantic* collision in `NewAgent.tsx`, change set 5 | `COMMITTED` | `Review and Test Changes.md` §8 |
| 2026-09-01 | Session 14 — v6 retirement review on `W6-20260831a` (merge #38) | `COMMITTED` | `Review and Test Changes.md` §8 |
| 2026-08-31 | Session 13 — verify the fork on `W5-20260830a` (merge #36) | `COMMITTED` | `Review and Test Changes.md` §8 |
| 2026-08-30 | Session 12 — verify the fork on `W4-20260830b` (merges #33-#35) | `COMMITTED` | `Review and Test Changes.md` §8 |
| — | Change sets 2, 7, 9 removed in v6 (`88bca7b78`) | `RETIRED` | `Review and Test Changes.md` §4.2 |
| — | Change sets 1, 3, 4, 5, 6, 8 — the live fork register | `COMMITTED` | `Review and Test Changes.md` §4 |
