# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-04 17:05

| | |
| --- | --- |
| **Branch** | `W7-20260904a` |
| **HEAD** | `2f5a2153c` — *Merge pull request #40 from paperclipai/master* |
| **Upstream tip merged** | `af3023f1e` (via `origin/FORK-20260904a`) |
| **Working tree** | **DIRTY — 5 files, uncommitted, intentionally** |
| **Active work item** | Change set 10 — duplicate agent "Validation error" |
| **Its document** | [`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md) |
| **State** | Code complete · unit-tested green · typecheck clean · **no blocking open items** · **not committed, not live-verified** |

### The uncommitted files, and why each is dirty

```
M packages/shared/src/validators/agent.ts                 duplicateFromAgentId on createAgentSchema
M server/src/routes/agents.ts                             restoreDuplicateSourceEnv + wired into create & hire; PATCH strips duplicateFromAgentId (O-1)
M server/src/__tests__/agent-permissions-routes.test.ts   6 new server tests (4 duplicate-restore, 2 for O-1)
M ui/src/lib/duplicate-agent-payload.ts                   drop modelProfiles; send duplicateFromAgentId
M ui/src/lib/duplicate-agent-payload.test.ts              3 new UI tests
```

**Do not `git checkout` or stash these without reading
[`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md) first.** They are
held uncommitted on purpose, under RULE 0 (§5.4 of
[`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md)):
*the operator reviews and commits.*

Documentation, also uncommitted (new files unless marked):

```
M  CustomCodeDoc/Review and Test Changes.md   change set 10 in §4/§4.1, §7.2 suites,
                                              §7.5 trap 6, §0/§0.1/§1.2, Session 17 log
?? CustomCodeDoc/Duplicate agent fix.md       change set 10 — the reasoning and open items
?? CustomCodeDoc/CHANGELOG.md                 this convention's running log
?? CustomCodeDoc/SESSION-RESUME.md            this file
```

### The very next action

**Live-verify §7 of [`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md),
then review and commit.** O-1 is closed; nothing else blocks.

The live checks, in order — the second one matters most, because a green create
does *not* prove it:

1. Duplicate an agent whose `runtimeConfig` contains `modelProfiles`
   (`SELECT id, name FROM agents WHERE runtime_config ? 'modelProfiles';`).
2. Open the copy and confirm `adapterConfig.env` holds the **real** vault
   directory, not `***REDACTED***`.
3. Duplicate an agent with no vault env, to confirm the opt-in restore left the
   ordinary case alone.

### Verified green as of the timestamp above

```
npx vitest run ui/src/lib/duplicate-agent-payload.test.ts             5/5
npx vitest run server/src/__tests__/agent-permissions-routes.test.ts  69/69
npx vitest run server/src/__tests__/openapi-routes.test.ts            5/5
cd packages/shared && npx tsc --noEmit                                clean
cd ui           && npx tsc -b                                         clean
cd server       && NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit   clean
```

### Open items carried, not fixed

**None are blocking.** All live in §8 of
[`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md).

| Id | Owner | One line |
| --- | --- | --- |
| ~~O-1~~ | change set 10 | ~~`duplicateFromAgentId` not stripped by the PATCH route~~ **FIXED 2026-09-04**, two tests, both proved to be real guards. |
| O-2 | its own change set | The UI drops Zod `details` on every API error, so all schema failures read "Validation error". This is why the reported bug was diagnosed by reading source rather than the toast. |
| O-3 | upstream, really | No migration strips `modelProfiles` from existing agent rows; each path sanitises for itself. Any fork path round-tripping a stored config through a create/update schema is exposed. |
| O-4 | change sets 3 and 4 | `PAPERCLIP_CODEX_VAULT_ROOT` / `PAPERCLIP_CLAUDE_VAULT_ROOT` override the vault roots but appear in no markdown, `.env.example`, or `docker/`. Documentation fix, not code. |
| O-5 | change set 3 | `/sysops/llm/openrouter/` is **not** a managed vault — just a directory beside the two real roots. §7.2 of `Review and Test Changes.md` now says so. |

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

### Before ending a session — deliberately or not

1. Update the **Current state** table here: branch, HEAD, dirty files, next action.
2. Add or amend the entry in [`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md).
3. Make sure the work item's own document has a **Resume point** with unchecked
   boxes for whatever is left. Unchecked boxes are the handover.
4. State explicitly what is **not** verified. A green unit test is not a live
   confirmation, and the difference must survive the disconnection.

### What goes where

| File | Lifetime | Holds |
| --- | --- | --- |
| `SESSION-RESUME.md` (this) | **overwritten** | Only what is true now: branch, dirty tree, next action |
| [`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) | append-only | One dated entry per work item; what changed and its status |
| Per-change-set docs | append-only | Root cause, reasoning, rejected alternatives, tests, open items |
| [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) | append-only | The standing procedure and the §4 register of what the fork carries |

### The rule that matters most

**Reasoning is the perishable part.** A diff survives a disconnection perfectly;
*why* a value was rejected, which approach was tried and abandoned, and what was
deliberately left undone do not. Write those down first and the code second.
