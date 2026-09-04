# SESSION-RESUME — read this first

**Purpose:** one file that always answers *"what was I doing, and what is the very
next action?"* after a dropped connection.

**Convention (standing, adopted 2026-09-04 at the operator's request):** this file
is **overwritten**, not appended. It describes *now*. The history lives in
[`CHANGELOG.md`](CustomCodeDoc/CHANGELOG.md) and in the per-change-set documents.
It is the one file in this directory that is not append-only.

---

## Current state — updated 2026-09-04 17:55

| | |
| --- | --- |
| **Branch** | `W7-20260904a` |
| **HEAD** | `df401863f` (this clone) · the build clone `/Projects/W7-20260904a` is one ahead at `0a3040984`, its packaging commit |
| **Working tree** | **DIRTY — 6 files, uncommitted. The operator is checking these in.** |
| **Active work item** | Change set 10 — duplicate agent "Validation error" |
| **Its document** | [`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md) |
| **State** | Change set 10 committed and pushed · **root cause still unconfirmed** — see below |

### Uncommitted, and what each is

```
?? ui/src/lib/validation-error-message.ts       O-2 fix: extract Zod details from ApiError.body
?? ui/src/lib/validation-error-message.test.ts  5 tests
M  ui/src/components/AgentActionButtons.tsx     duplicate toast uses apiErrorMessage()
M  CustomCodeDoc/Review and Test Changes.md     RULE 0 rewritten (§5.4, §0.1 rule 2)
M  CustomCodeDoc/SESSION-RESUME.md              this file
M  CustomCodeDoc/builds paperclip.md            traps 6 and 7 — decode --version; partial packs
```

**The O-2 fix must be in the next build to be useful** — it is the thing that will
finally name the failing field.

Verified: `ui/src/lib/validation-error-message.test.ts` 5/5, affected UI suites
17/17, `cd ui && npx tsc -b` clean.

### The very next action

**Re-pack, install, and read the new toast.**

```bash
cd /Projects/W7-20260904a
./scripts/pack-local.sh 2>&1 | tee /tmp/pack.log
ls releases/local/paperclipai-0.0.0-local.*.tgz releases/local/install.sh   # both must exist
# install from that bundle, restart the server, then:
paperclipai --version    # must NOT be 0.0.0-local.a32055fd
```

Then duplicate the agent. The toast will read
`Validation error: <field> — <reason>` instead of the bare string.

### What is still unknown — do not skip this

**The root cause of the reported bug was never confirmed.** `runtimeConfig.modelProfiles`
was diagnosed by reading schema source, and the fix for it is correct and shipped
— but the failure reproduced on a binary that never contained the fix
(`0.0.0-local.a32055fd`, 2026-08-30, 185 commits behind), so **the report has
still not been tested against the fix.** Two outcomes are open:

1. The duplicate now succeeds → `modelProfiles` was the cause, and §7 of the
   change-set document can finally be ticked.
2. It still fails → the new toast names the real field. `icon` and `role` are the
   likely candidates: both are `z.enum(...)` in `createAgentSchema`, so a stored
   value retired upstream fails in exactly the same way `modelProfiles` did. The
   fix would follow the same shape.

### Why an hour went missing, in one line

The installed binary was five days old, and nothing in the UI said so. **Decode
`paperclipai --version` first** — trap 6 of
[`builds paperclip.md`](CustomCodeDoc/builds%20paperclip.md).

### Open items carried

**None blocking.** All in §8 of
[`Duplicate agent fix.md`](CustomCodeDoc/Duplicate%20agent%20fix.md).

| Id | Owner | One line |
| --- | --- | --- |
| ~~O-1~~ | change set 10 | ~~`duplicateFromAgentId` not stripped by the PATCH route~~ **FIXED**, two tests, both proved real guards. |
| ~~O-2~~ | change set 10 | ~~UI discards Zod `details`~~ **FIXED 2026-09-04, uncommitted.** `apiErrorMessage()` in `ui/src/lib/validation-error-message.ts`. |
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

### RULE 0 — never commit, merge or push without asking

Prepare the work. Run the checks. Report what changed. **Then stop and ask a
direct question, and wait for the answer.**

This applies to `git commit`, `git merge`, `git rebase`, `git push`, `git reset`
and anything else that moves a ref or rewrites history. It applies **even when the
operator's own words sound like permission** — *"let's check this in"*, *"go
ahead"*, *"push it"* — and **even when the assistant has the rights to do it.**
The constraint is the operator's review process, not a permissions boundary, so
nothing in the tooling will enforce it. Full text and the reason: §5.4 and §0.1
rule 2 of [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md).

A clean, staged, fully-tested tree with a written-up next action **is** the
finished deliverable. Handing it over uncommitted is not an unfinished job.

### The rule that matters most

**Reasoning is the perishable part.** A diff survives a disconnection perfectly;
*why* a value was rejected, which approach was tried and abandoned, and what was
deliberately left undone do not. Write those down first and the code second.
