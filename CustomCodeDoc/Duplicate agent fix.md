# Duplicate agent — the "Validation error" fix

**Change set:** 10 (new — see §4 of [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md))
**Status:** Implemented and unit-tested on `W7-20260904a`. **Not yet committed, and
not yet reproduced-then-confirmed against a live instance by the operator.**
**Amended 2026-09-04:** open item O-1 is now **fixed** (§8), with two new tests.
Two further open items opened, O-4 and O-5.
**Owner:** chris@anderson-family.com · **Performed by:** Claude Opus 5 (Claude Code)
**Created:** 2026-09-04
**Resume point:** §7. If the session dropped, read §7 first, then §8.

> Append-only, like the rest of this directory. Do not rewrite this document —
> amend it, and date what you add.

---

## 1. The symptom

Duplicating an agent from the UI fails with a toast reading exactly:

```
Could not duplicate agent
Validation error
```

No field name, no detail. The agent is not created.

---

## 2. Why the message is empty — and why that matters

The bare string is not a mystery, it is a plumbing gap. Two independent things
combine:

1. The server *does* say which field failed.
   [`server/src/middleware/validate.ts:45`](server/src/middleware/validate.ts#L45)
   throws `unprocessable("Validation error", err.issues)`, and
   [`server/src/middleware/error-handler.ts:147`](server/src/middleware/error-handler.ts#L147)
   serialises that as `{ error: "Validation error", details: [...] }`. The Zod
   issues — including the offending path — are in `details`.

2. The client throws that detail away.
   `ApiError` ([`ui/src/api/client.ts:6-16`](ui/src/api/client.ts#L6-L16)) keeps the
   body on `error.body`, but the duplicate mutation's `onError`
   ([`ui/src/components/AgentActionButtons.tsx:340-344`](ui/src/components/AgentActionButtons.tsx#L340-L344))
   renders `err.message` alone. `message` is the top-level `"Validation error"`.
   `details` is sat on `error.body` and never read.

**So every schema rejection on this path looks identical, whatever the cause.**
That is why this took a code read rather than a glance at the toast, and it is
logged as open item **O-2** in §8.

---

## 3. Root cause — `runtimeConfig.modelProfiles`

Upstream commit `4b6de5327`, *"Remove cheap model profiles (#12683)"* (2026-09-01,
which arrived in this fork with the 2026-09-04 merge) added an active rejection
to `agentRuntimeConfigSchema`
([`packages/shared/src/validators/agent.ts:62-73`](packages/shared/src/validators/agent.ts#L62-L73)):

```ts
export const agentRuntimeConfigSchema = z.object({ ... })
  .catchall(z.unknown())
  .superRefine((value, ctx) => {
    if (Object.prototype.hasOwnProperty.call(value, "modelProfiles")) {
      ctx.addIssue({ ..., path: ["modelProfiles"],
        message: "runtimeConfig.modelProfiles is no longer supported" });
    }
  });
```

Note the shape: the schema is `.catchall(z.unknown())`, so it is *permissive about
unknown keys in general* — `modelProfiles` is singled out and rejected by name.

The collision:

- **Agent rows written before #12683 still carry `modelProfiles`.** Removing the
  key from the schema did not rewrite existing rows; there is no migration that
  strips it. The value simply sits in the stored `runtimeConfig` JSON until that
  row is next written.
- **A duplicate copies `runtimeConfig` wholesale.** `buildDuplicateAgentPayload`
  read the source agent's `runtimeConfig` with `cloneRecord` and posted it back
  verbatim.
- `POST /api/companies/:companyId/agents` validates with `createAgentSchema`,
  which embeds `agentRuntimeConfigSchema`, which rejects the key.

**Result: any agent old enough to predate #12683 cannot be duplicated, and the
operator is told only "Validation error" about a field they never set and cannot
see in the UI.**

### 3.1 The upstream precedent for the fix

Upstream already solved the identical problem on its own copy path.
[`server/src/services/company-portability.ts:1316-1318`](server/src/services/company-portability.ts#L1316-L1318)
— `sanitizeImportedAgentRuntimeConfig` — does exactly one thing first:

```ts
const next = clonePortableRecord(runtimeConfig) ?? {};
delete next.modelProfiles;
```

Company import drops the retired key rather than failing the import. **Duplicate
is the same kind of operation and should behave the same way.** That makes the
fix conventional rather than novel, which is what we want in a forked file.

---

## 4. The second bug, found while fixing the first

Fixing `modelProfiles` gets the create to return 201 — and produces a **broken
agent**, silently. This one would not have surfaced until the copy was first run.

Every plain `adapterConfig.env` binding is redacted on its way out of the server
(`redactAgentEnvBinding`), so what a client holds after reading an agent is:

```json
{ "env": { "CODEX_HOME": { "type": "plain", "value": "***REDACTED***" } } }
```

Duplicate reads the agent, then posts it back. **The client has never held the
real value and cannot send it.** So the copy was created pointing at a literal
`***REDACTED***` path — for our fork that is typically a credential vault
directory (`/sysops/llm/codex/<name>`, `/sysops/llm/claude/<name>` — change sets
3 and 4). It validates fine, it persists fine, and it fails much later at run
time with an error that looks nothing like its cause.

**The update path already solves this round trip.** `restoreRedactedAgentEnv`
puts the real values back by comparing against the row being updated. A *create*
has no such row — so the caller must name one.

---

## 5. The fix

Five files. Two independent defects, fixed independently.

### 5.1 Defect 1 — drop the retired key (client side)

[`ui/src/lib/duplicate-agent-payload.ts`](ui/src/lib/duplicate-agent-payload.ts)

```ts
const RETIRED_RUNTIME_CONFIG_KEYS = ["modelProfiles"] as const;
```

`runtimeConfig` is cloned and the retired keys deleted before the payload is
built. The clone matters: the source `AgentDetail` in the React Query cache must
not be mutated, and there is a test that asserts exactly that (§6).

The named-constant form is deliberate — the next retirement is one array entry,
not another patch to this function.

### 5.2 Defect 2 — name the source so the server can restore (both sides)

| File | Change |
| --- | --- |
| [`ui/src/lib/duplicate-agent-payload.ts`](ui/src/lib/duplicate-agent-payload.ts) | Adds `duplicateFromAgentId: agent.id` to the payload; `"id"` added to the `DuplicateAgentSource` pick |
| [`packages/shared/src/validators/agent.ts`](packages/shared/src/validators/agent.ts) | `duplicateFromAgentId: z.string().guid().optional()` on `createAgentSchema` |
| [`server/src/routes/agents.ts`](server/src/routes/agents.ts) | New `restoreDuplicateSourceEnv()`; destructured out of the body and applied on **both** the create and the hire path |

`restoreDuplicateSourceEnv` loads the named agent, checks it, and delegates the
actual merge to the existing `restoreRedactedAgentEnv` — so create and update
share one implementation of the restore rule.

### 5.3 The three security properties, and where each is enforced

This field lets a caller pull a value out of another agent's row. It is worth
being explicit about why that is safe:

1. **Same company only.** `source.companyId !== companyId` → 400. A cross-company
   id is refused *with the same error as an id that does not exist*, so the
   response cannot be used to probe for agent ids in companies the caller cannot
   see.
2. **Same permission as reading the original.** `assertCanReadConfigurations(req,
   source.companyId)` — carrying a value into a copy is never easier than
   reading the source directly.
3. **Nothing is echoed back.** Only keys the client sent as the redaction marker
   *and* that the source actually has are restored, server-side, into the value
   being persisted. No restored value appears in the response.

### 5.4 Two placement decisions worth keeping

- **The hire path gets it too.** A company that requires board approval routes
  the duplicate to `POST /agent-hires` instead — see the 409 fallback at
  [`AgentActionButtons.tsx:321-329`](ui/src/components/AgentActionButtons.tsx#L321-L329).
  Without the restore there, approval would materialise an agent holding the
  marker. Same bug, different door.
- **The restore runs *before* the adapter-config asserts**, not after, so every
  downstream guard inspects the values that will actually be persisted rather
  than the redaction marker.

### 5.5 The PATCH-route strip (added 2026-09-04, closing O-1)

[`server/src/routes/agents.ts:4683`](server/src/routes/agents.ts#L4683) —
`delete patchData.duplicateFromAgentId;`, immediately after the two existing
strips for `replaceAdapterConfig` and `applyStoredClaudeLogin`. Same pattern,
same reason: it is not an agent column. Full reasoning and the canary proof in
§8, O-1.

### 5.6 A note on the test fixture path (added 2026-09-04, from O-4)

The server tests use `"/sysops/llm/codex/duplicate-source"` as the plain env value
being round-tripped. **It is an arbitrary opaque fixture and the tests assert
nothing about it** — only that whatever went in comes back out. It is shaped like
a managed Codex vault directory so the failure mode reads realistically, and it is
commented in the test to say exactly that, because the earlier value
(`/sysops/llm/openrouter/default`) read as though the suite depended on a real
host path. It does not, and a test that read this from the environment would stop
being deterministic. The *production* root is configurable — see O-4.

---

## 6. Tests added

| Suite | Test | What breaks without the fix |
| --- | --- | --- |
| `ui/src/lib/duplicate-agent-payload.test.ts` | names the source agent so the server can restore redacted vault env | payload has no `duplicateFromAgentId`; copy persists the marker |
| " | drops retired runtimeConfig keys the create API rejects | create is refused, `"Validation error"` — **the reported symptom** |
| " | leaves the source agent's own config untouched | the cached `AgentDetail` is mutated by a read-only helper |
| `server/src/__tests__/agent-permissions-routes.test.ts` | restores redacted env from the named duplicate source on create | copy is created with `***REDACTED***` as a real value |
| " | restores redacted env on the hire path a duplicate falls back to | same, via board approval |
| " | refuses a duplicate source in another company | cross-tenant read of an env value |
| " | leaves a create without a duplicate source untouched | the restore stops being opt-in |
| " | drops duplicateFromAgentId from an update instead of writing it as a column *(added 2026-09-04, O-1)* | the field reaches `svc.update` as if it were an agent column |
| " | keeps a profile-only update on the profile gate when duplicateFromAgentId rides along *(added 2026-09-04, O-1)* | a profile-only edit is silently pushed onto the stricter gate |

The create test also asserts `expect(createCallArgs).not.toHaveProperty("duplicateFromAgentId")`
— the field is a restore *instruction*, not an agent column, and must not reach
the service layer. The cross-company test asserts the foreign value is absent
from the response body, not merely that the status is 400.

---

## 7. Verification status — the resume point

Run 2026-09-04 on `W7-20260904a` @ `2f5a2153c`, working tree dirty (this change).

| Check | Command | Result |
| --- | --- | --- |
| UI duplicate payload | `npx vitest run ui/src/lib/duplicate-agent-payload.test.ts` | **5/5 pass** |
| Server agent permissions | `npx vitest run server/src/__tests__/agent-permissions-routes.test.ts` | **69/69 pass** (67 before the O-1 tests) |
| OpenAPI coverage (new schema field) | `npx vitest run server/src/__tests__/openapi-routes.test.ts` | **5/5 pass** |
| Typecheck — shared | `cd packages/shared && npx tsc --noEmit` | **clean** |
| Typecheck — ui | `cd ui && npx tsc -b` | **clean** |
| Typecheck — server | `cd server && NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit` | **clean** |

> `--reporter=basic` no longer exists in vitest 4.1.11 and fails with
> `Failed to load url basic`. Use the default reporter.

**Not yet done — this is where to pick up:**

- [ ] **Live repro before the fix.** The bug has been traced in the code but
      never watched to fail. Find an agent whose stored `runtimeConfig` contains
      `modelProfiles`, duplicate it on a build *without* this change, confirm the
      "Validation error" toast. Query for candidates with:
      ```sql
      SELECT id, name FROM agents WHERE runtime_config ? 'modelProfiles';
      ```
- [ ] **Live confirm after the fix.** Duplicate the same agent with the change
      applied. Then open the copy and check its `adapterConfig.env` resolves to
      the real vault directory, **not** `***REDACTED***`. Both halves matter —
      the second is the §4 defect and a green create does not prove it.
- [ ] **Duplicate an agent that has no vault env at all**, to confirm the opt-in
      restore did not disturb the ordinary case.
- [ ] **Operator review and commit.** Nothing here is committed. RULE 0 of
      [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §5.4
      stands: the operator commits.
- [ ] Add change set 10 to the §4 register — **done 2026-09-04**, see that file.

---

## 8. Open items

### O-1 — `duplicateFromAgentId` leaks into `updateAgentSchema` (found 2026-09-04, **FIXED 2026-09-04**)

`updateAgentSchema` is derived from `createAgentSchema`
([`packages/shared/src/validators/agent.ts:143-153`](packages/shared/src/validators/agent.ts#L143-L153)):

```ts
export const updateAgentSchema = objectWithoutDefaults(
  createAgentSchema.omit({ permissions: true }),
).partial().extend({ ... });
```

So **adding the field to `createAgentSchema` also made it a valid key on
`PATCH /api/agents/:id`**, where it means nothing. The PATCH route explicitly
strips its two sibling non-column flags — `replaceAdapterConfig` and
`applyStoredClaudeLogin` ([`server/src/routes/agents.ts:4664-4671`](server/src/routes/agents.ts#L4664-L4671))
— but nothing strips this one, so it would flow into `patchData` → `svc.update`
→ Drizzle `.set()`.

**Assessed severity: low, and fail-closed.** Two consequences, both bounded:

1. The unknown key reaches Drizzle's `.set()`. `updateAgent` passes
   `{...normalizedPatch}` through with no column whitelist
   ([`server/src/services/agents.ts:676`, `:720-722`](server/src/services/agents.ts#L720-L722)).
   Drizzle builds its SET clause from the table's own columns, so an unknown key
   is expected to be ignored — **this has not been verified empirically here, and
   the doc should not be read as claiming it was.**
2. `profileOnlyChange` ([`agents.ts:4806-4809`](server/src/routes/agents.ts#L4806-L4809))
   requires *every* key in `patchData` to be a profile-consent field. An extra key
   makes that false, sending the request to the stricter `assertCanUpdateAgent`
   gate instead of `assertCanApplyAgentProfileChange`. That is a *tightening*, not
   a bypass — hence fail-closed.

**The fix, in the established pattern of the two lines above it:**

```ts
// Not an agent column. It is a create-time restore instruction and has no
// meaning on an update, which restores from the row being updated instead.
delete patchData.duplicateFromAgentId;
```

> **RESOLVED 2026-09-04**, at the operator's direction. The rest of this entry is
> the original finding, kept as written. The resolution follows.

#### Resolution

The three lines above were applied verbatim at
[`server/src/routes/agents.ts:4683`](server/src/routes/agents.ts#L4683), directly
after the `applyStoredClaudeLogin` strip, with a comment saying why an update has
nothing to restore from a named source.

Two tests were added to `agent-permissions-routes.test.ts`, and **both were
confirmed to be real guards** by temporarily removing the fix and watching them go
red — the same discipline §7.3 of [`SYNC-2026-09-04.md`](CustomCodeDoc/SYNC-2026-09-04.md)
applied to the change-set-6 canary:

```
× drops duplicateFromAgentId from an update instead of writing it as a column
× keeps a profile-only update on the profile gate when duplicateFromAgentId rides along
Tests  2 failed | 67 passed (69)
```

**That run also settled the empirical question the finding above left open.** The
first failure was:

```
AssertionError: expected { …(2) } to not have property "duplicateFromAgentId"
- Expected: undefined
+ Received: "11111111-1111-4111-8111-111111111111"
```

So the field **did** reach `svc.update` — the route was passing it straight
through. What happened *inside* Drizzle's `.set()` is now moot and was never
established here; the key no longer gets that far. The earlier caveat in this
entry ("this has not been verified empirically") is superseded by the line above
for the *route* half of the claim, and simply retired for the ORM half.

The second test pins the `profileOnlyChange` consequence directly: it asserts
`Object.keys(updateCallArgs)` is exactly `["title"]`, so a patch carrying the
stray key is now indistinguishable from one sent without it.

**With this, change set 10 has no blocking open items.** O-2 through O-5 are all
follow-ups outside the reported bug.

### O-2 — the UI discards Zod `details` on every API error (found 2026-09-04, NOT fixed)

Per §2. `ApiError.body` carries `{ error, details }`; every toast on this path
renders `err.message` alone, so *all* schema rejections read "Validation error".
This is the reason a one-key problem cost a code read.

Not fixed here because it is a cross-cutting UI concern, not part of this bug —
it touches error rendering for every mutation, not just duplicate. Worth its own
change set. The minimum useful version is to append the first issue's `path` and
`message` from `body.details` when present.

### O-3 — no migration strips `modelProfiles` from existing rows

The client-side drop fixes *duplicate*. Any other path that round-trips a stored
`runtimeConfig` through `createAgentSchema` or `updateAgentSchema` will hit the
same rejection for the same rows. Upstream's own answer so far is per-path
sanitising (§3.1), not a migration. Flagged, not owned by this fork.

---

### O-4 — the vault roots are configurable, and that fact is documented nowhere (found 2026-09-04, NOT fixed)

Raised by the operator reading the test fixture `"/sysops/llm/openrouter/default"`
and asking, reasonably, why a path like that is hardcoded.

**In the test it is not hardcoded configuration — it is an opaque fixture**, and a
test should not read its expected values from the environment or it stops being
deterministic. That part was a false alarm, and the fixture has been renamed and
commented to say so (§5.5).

**But the question exposed a real documentation gap.** Production does *not*
hardcode these paths — both vault roots are already overridable:

| Constant | Default | Override |
| --- | --- | --- |
| `DEFAULT_CODEX_VAULT_ROOT` ([`codex-vault.ts:36`](packages/adapters/codex-local/src/server/codex-vault.ts#L36)) | `/sysops/llm/codex` | `PAPERCLIP_CODEX_VAULT_ROOT` |
| `DEFAULT_CLAUDE_VAULT_ROOT` ([`claude-vault.ts:53`](packages/adapters/claude-local/src/server/claude-vault.ts#L53)) | `/sysops/llm/claude` | `PAPERCLIP_CLAUDE_VAULT_ROOT` |

Both resolve through `resolveVaultRoot(env)`, and the source comment is explicit
that the value "is never taken from a request" — the override is an operator
control, not a client input, which is the correct shape for it.

**Neither environment variable appears in any markdown, in `.env.example`, or in
`docker/`.** Verified 2026-09-04:

```bash
grep -rn "VAULT_ROOT" .env.example docker/ scripts/ CustomCodeDoc/*.md doc/   # no matches
```

So an operator who wants to relocate the vaults has no way to discover the knob
short of reading the adapter source — which is exactly what just happened. **The
fix is documentation, not code:** add both keys to `.env.example` and to §2 of
[`Codex device login web service.md`](CustomCodeDoc/Codex%20device%20login%20web%20service.md)
and [`Claude device login web service.md`](CustomCodeDoc/Claude%20device%20login%20web%20service.md),
which are change sets 3 and 4 and where an operator would look first. Not done
here because it belongs to those change sets, not to this one.

### O-5 — `/sysops/llm/openrouter/default` is not a managed vault (found 2026-09-04, NOT fixed)

Noticed while answering O-4. §7.2 of
[`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md)
gives an out-of-band check using `CODEX_HOME=/sysops/llm/openrouter/default`. The
managed vault roots are `/sysops/llm/codex` and `/sysops/llm/claude`, so
`/sysops/llm/openrouter/` is **a sibling directory the vault service does not
create, validate, list, or delete** — an operator-created Codex home that happens
to live next door.

That is not wrong, but it is easy to misread as a third vault kind, and the vault
UI will never show it. Worth one clarifying sentence in §7.2. Flagged, not fixed.

---

## 9. Files touched

As of 2026-09-04, after the O-1 fix:

```
packages/shared/src/validators/agent.ts               +14
server/src/routes/agents.ts                           +73 -3
server/src/__tests__/agent-permissions-routes.test.ts +243
ui/src/lib/duplicate-agent-payload.ts                 +26 -3
ui/src/lib/duplicate-agent-payload.test.ts            +53
                                                 406 insertions, 3 deletions
```

Three of the five files are tests. That ratio is deliberate: two of the three
defects here (the redacted-env restore, and O-1) fail *silently* in production and
have no natural symptom, so a test is the only thing that will notice a regression.

**Fork/upstream collision risk:** `packages/shared/src/validators/agent.ts` and
`server/src/routes/agents.ts` are both *heavily* edited upstream and now carry
fork changes. They are added to the §4.1 collision list in
[`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md).
The canary is the four server tests in §6: if an upstream merge drops the
`duplicateFromAgentId` destructuring from either route, they go red naming it.

---

_(appended as work proceeds)_
