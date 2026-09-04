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
