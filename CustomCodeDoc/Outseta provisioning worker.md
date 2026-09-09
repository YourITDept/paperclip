---
name: outseta-provisioning-worker
description: Change set 11 — the in-process worker that drains provisioning.provisioning_jobs into companies, users, memberships, secrets, agents and agent tasks. What the fork carries, what it depends on in upstream, how to verify it after a merge, and the failure modes that produce no error.
metadata:
  status: current
  owner: Chris (cwa@youritdept.com)
  written: 2026-09-08
  change-set: 11
  registered: Session 19 (2026-09-08)
---

# Change set 11 — the Outseta provisioning worker

> ## RULE 0 applies here as everywhere — never commit, push, or check anything in.
> Leave changes in the working tree, say what you touched, and stop. See
> [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md) §5.4.

## What it is, in one paragraph

An Outseta account signs up; a **callback container outside Paperclip** inserts
rows into that instance's `provisioning.provisioning_jobs` table; **this module,
running inside the Paperclip process, drains them** over the Postgres connection
it already holds. The point is that **no inbound port is opened on the Paperclip
container** — the traffic is outbound only. The queue is also a privilege
reduction: the callback container's Postgres role has `SELECT, INSERT` on one
table and nothing else, so it can *request* provisioning but only this worker can
*perform* it, and only through `accessService`.

```
Outseta ──callbacks──▶ callback container
                            │  resolve accountUid -> database_url
                            │  INSERT provisioning_jobs + pg_notify
                            ▼
                     instance Postgres
                            ▲
                            │  outbound only — no listening port
                     Paperclip container
                       worker: poll -> handlers -> accessService
```

## Why it is a change set and not just "some files"

Most of §4 is patches *inside* upstream files, where the risk is a merge
overwriting a hunk. **This one is different and its risk profile is different**,
which is the main thing this document exists to say:

| | Change sets 1, 6, 10 … | Change set 11 |
| --- | --- | --- |
| Shape | hunks inside upstream files | five net-new files + two lines |
| Merge risk | a conflict resolved badly | **net-new files never conflict** |
| Real exposure | the hunk vanishing | **upstream changing an API this calls** |

So the check that matters here is **not** "did the files survive" — they always
will. It is **"do the upstream services it calls still have the same
signatures?"** Nothing in a merge tells you that, and a typecheck only catches
the subset that changes types rather than behaviour.

## The footprint

**Five net-new files, fork-only.** Upstream has no equivalent.

| File | Lines | What it is |
| --- | --- | --- |
| `server/src/provisioning/store.ts` | 405 | `JOB_TYPES`, claim/succeed/park/fail SQL. Every statement schema-qualified |
| `server/src/provisioning/handlers.ts` | 1268 | The nine job handlers. **All policy lives here** |
| `server/src/provisioning/worker.ts` | 250 | The `setInterval` drain loop and failure classification |
| `server/src/provisioning/index.ts` | 85 | The one seam into the server; the enable gate |
| `server/src/provisioning/run-once.ts` | 107 | Drain once and exit, for verification |

**Two lines in `server/src/index.ts`** — the only edit to an upstream file, and
therefore the only §4.1 collision point:

```ts
:94    import { startProvisioningWorker } from "./provisioning/index.js";
:1824  const provisioningWorker = startProvisioningWorker(db as any, { heartbeat });
:1836  await provisioningWorker.stop();          // inside the shutdown handler
```

`index.ts` is a file upstream edits constantly. If those lines are lost, **the
build still succeeds and every test still passes** — the instance simply
onboards nobody, silently, for ever. See *Failure modes* below.

## The gate

Nothing in this module runs unless `PAPERCLIP_PROVISIONING_WORKER_ENABLED` is
truthy. **Default false**, deliberately: an ordinary Paperclip instance knows
nothing about Outseta and must not go looking for a schema that is not there.
When off, `startProvisioningWorker` returns an inert handle without retaining
`db`, registering a timer, or issuing a statement.

An unrecognised value is treated as false **and warns** — a typo like `ture`
would otherwise produce an instance that onboards nobody with nothing in the log
to say why, and this integration already has enough failures that produce no
error.

**It is not a security boundary.** It says "Outseta is configured here", nothing
more.

## The job vocabulary

```
instance.state   user.upsert   company.create   membership.set
membership.remove   company.reconcile   secret.set   agent.create   agent.task
```

`company.reconcile` is the only one with no handler left; `membership.remove`
and `agent.task` were both built on 2026-09-08. **A name in `JOB_TYPES` with no handler parks and
waits; a name outside it fails permanently.** That asymmetry is deliberate and
is what makes it safe for the control plane to enqueue ahead of this side — the
enqueuer's keys are content-addressed, so a row that reaches a terminal state is
never re-queued, and a type we simply had not built yet would be dead for good.

**Adding a name to `JOB_TYPES` is therefore always the first step**, and it is
safe on its own.

## Default instructions on `agent.create` (added 2026-09-09)

**The defect, reported by the operator:** every agent provisioned from the queue
was created with an **empty instruction bundle** — no Execution Contract, no
final-disposition checklist, no work-product rules — while looking entirely
normal in the UI.

**Why, and it is a shape worth remembering.** Two code paths create agents and
only one of them seeds instructions:

| Path | Seeds instructions? |
| --- | --- |
| `agentRoutes` (API/UI) | **Yes** — calls `materializeDefaultInstructionsBundleForNewAgent` after its create |
| `server/src/provisioning/handlers.ts` | **No** — calls `agentService.create` directly |

`server/src/services/agents.ts` contains **no reference to instructions at all**.
The seeding lives in the *route*, not the service, so anything that calls the
service directly silently gets less. This module has always called the service
directly — that is deliberate, it is how the worker avoids HTTP — so the gap was
present from the day change set 11 was written, not introduced by a merge.

**Nothing detected it.** The agent row is valid, the adapter config is valid, the
adapter runs. The only symptom is an agent with no instructions, which reads as
"the model is being unhelpful" rather than "the bundle is empty."

### What it does now

`seedDefaultInstructions()` runs after `agentsSvc.create` and mirrors the route:

- skips adapters whose `supportsInstructionsBundle !== true` (`http`, `process`);
- skips when the config already names instructions, mirroring the route's
  `hasExplicitInstructionsBundle`;
- loads the role-keyed default from
  [`services/default-agent-instructions.ts`](server/src/services/default-agent-instructions.ts)
  — `ceo` gets `AGENTS.md`/`HEARTBEAT.md`/`SOUL.md`/`TOOLS.md`, everything else
  gets `AGENTS.md`. Provisioning sets no role, so agents land on `general` →
  the `default` bundle;
- materializes with `replaceExisting: false`, then writes the resulting
  `adapterConfig` back.

**Create only. `reconcileAgent` deliberately does not call it**, so a later queue
row can never overwrite instructions someone edited by hand — the same
merge-never-replace rule the rest of this module follows. The operator declined a
backfill of existing agents (2026-09-09): they will be recreated through the
provisioning skill instead.

**Never fatal.** A throw is logged and swallowed. The agent already exists by that
point, and failing the job would push it into a retry that finds the agent
present, takes the reconcile path, and therefore never seeds — the failure would
make the gap *permanent* rather than transient.

### Where it is written, and the trap that comes with it

`materializeManagedBundle` writes under `resolvePaperclipInstanceRoot()`, which is
derived from **`PAPERCLIP_HOME`**. Its test must redirect that variable or it
writes into the live deployment — the same class as
"Review and Test Changes.md" §7.5 #2b-4 and #2b-6.

### Covered by

`server/src/__tests__/provisioning-agent-instructions.test.ts` — 3 tests, in the
cs11 §7.2 suite (baseline 27 → **30**). One asserts the file's **contents**, not
just its existence: an empty `AGENTS.md` satisfies every structural check and is
exactly the bug.

## What it depends on in upstream — the list to re-check after every merge

This is the register entry that actually matters. After a merge, confirm each
still exists with a compatible signature. A typecheck catches the type-level
breaks; the ones that change *behaviour* under an unchanged signature are why
the suites in *Verifying it* are named.

| Upstream API | Used for | If it changes silently |
| --- | --- | --- |
| `accessService.ensureMembership` | every `membership.set` | a member with no access |
| `accessService.ensureRoleDefaultGrants` | every `membership.set` | **a member who signs in, sees the company, and can do nothing** — type-clean, looks like a bug |
| `accessService.promoteInstanceAdmin` / `demoteInstanceAdmin` | `user.upsert`, `membership.remove` | the owner cannot create companies |
| `accessService.archiveMember` | `membership.remove` | **a removed person keeps access.** Note this is used in preference to `setUserCompanyAccess`, whose UI-oriented guards refuse to remove an `owner`/`admin` or an instance admin — the Outseta primary contact arrives as `admin`, so that path refuses the common case |
| `authSessions` / `boardApiKeys` (`revoked_at`) | `membership.remove` | a live cookie or API key outlives the revocation |
| `companyService.create` / `update` | `company.create` | — |
| `agentService.create` / `update` | `agent.create` | — |
| `agentService.list(companyId, { includeTerminated })` | resolving an agent by name | **see the trap below** |
| `secretService.getByKey` / `create` / `rotate` | `secret.set`, and both of `agent.create`'s bindings | an agent bound to nothing, 401 on first run |
| `issueService.create` — `idempotencyKey`, `onDeduplicated`, `assigneeAgentId` | `agent.task` | **a re-queued task buys a second agent run.** That costs real money |
| `queueIssueAssignmentWakeup` + `heartbeat.wakeup` | `agent.task` | the issue is created and nobody is woken |
| `ISSUE_STATUSES` / `ISSUE_PRIORITIES` (`@paperclipai/shared`) | validating `agent.task` | an issue no board shows |
| `HttpError` + `assertAssignableAgent`'s `agent_not_assignable` details | mapping refusals to permanent failures | 5 retries on an answer that cannot change |

> **The `includeTerminated` trap, recorded because it nearly shipped.**
> `agentService.list` hides terminated agents by default. Resolving an agent by
> name without `includeTerminated: true` makes a task addressed to a *terminated*
> agent look exactly like one addressed to an agent that **does not exist yet** —
> so it PARKS, waiting for a condition that never arrives. `provisioning-check`
> on the control-plane side reports parked rows as information and never alerts,
> so it would have waited silently for ever. Found by a test, 2026-09-08.

## Failure modes that produce no error

The standing list for this module. None of these throws, and none turns a suite
red.

1. **The two `index.ts` lines lost in a merge.** Everything compiles, everything
   passes, and the instance onboards nobody. The only tell is the absence of
   `provisioning: worker enabled` in the boot log.
2. **A membership without grants.** `decidePrincipalGrant` needs an explicit
   `principal_permission_grants` row for everything except a narrow `tools:*`
   fallback, so a membership alone produces a person who signs in and can do
   nothing.
3. **`PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true`.** With a forward-auth cookie
   shared across subdomains, every Outseta-signed-in person presents a valid
   `X-Forwarded-User` on *every* instance. The only thing keeping account A's
   user out of account B's instance is the absence of a `user` row there.
   Auto-provision creates that row on sight. **Must be `false` on every
   instance, permanently.**
4. **`PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` set.** `resolveCloudTenantActor`
   deletes `instance_admin` rows on every authenticated request. One
   cloud-header request strips the instance-admin granted from Outseta and
   company creation stops working with nothing to explain why. **Never set it.**
5. **An unqualified table name.** `provisioning_jobs` unqualified resolves to
   `public`, finds nothing, and **does not error** — it just never sees a job.
   Every statement in `store.ts` says `provisioning.provisioning_jobs`. Neither
   side sets a `search_path`.
6. **A revocation that half-applies.** A person can hold memberships in several
   companies and each is archived in its own transaction, so a guard raised
   part-way would leave some archived and the job permanently failed — and
   because the enqueuer's keys are content-addressed, no later event re-queues
   it. The handler checks every target company for the last-owner condition
   **before** archiving anything, which makes the normal failure
   all-or-nothing. It is not a cross-company transaction; a database failure
   mid-loop can still split it.
7. **Deleting a user instead of archiving one.** 125 columns hold a user id and
   only 5 carry a foreign key to `user`. A `DELETE` succeeds, cascades those 5,
   and leaves up to 120 columns pointing at an id that no longer exists — with
   no error anywhere. `company_memberships.principal_id` is among the
   unconstrained ones because it is polymorphic.
8. **A parked job waiting for ever.** Parking is correct and deliberate, and
   `error_code` stays NULL so it stays out of the error report. There is no
   ceiling: park N times then fail is **not** implemented. A job parked on a
   condition that never arrives looks identical on day one and day thirty.

## Verifying it after a merge

**Typecheck is necessary and not sufficient** — it catches signature changes,
not behavioural ones.

```bash
# 27/27 expected. The only coverage of this module.
$CLEAN corepack pnpm exec vitest run --project @paperclipai/server \
  server/src/__tests__/provisioning-agent-codex-home.test.ts \
  server/src/__tests__/provisioning-agent-task.test.ts \
  server/src/__tests__/provisioning-membership-remove.test.ts

# the two lines in index.ts — the §4.1 collision point
grep -n "startProvisioningWorker\|provisioningWorker.stop" server/src/index.ts
# expect 3 hits: the import, the start, the stop
```

Both suites use the embedded-Postgres harness and exercise the real services, so
they fail if an upstream service changes behaviour underneath — which is exactly
the risk this change set has and the file-level checks cannot see.

**What they do NOT cover**, stated so nobody reads 27 green tests as more than
they are: `instance.state`, `user.upsert`, `company.create` and `membership.set`
have no unit tests on this side. They were verified live on `db_dev92` in an
earlier session and have not regressed, but a merge that broke
`ensureRoleDefaultGrants` would not be caught here.

**The live check**, which no suite replaces:

```bash
PAPERCLIP_PROVISIONING_WORKER_ENABLED=true DATABASE_URL="postgres://…" \
  node server/dist/provisioning/run-once.js
# {"ok":true,"processed":N}
```

## The other half of the contract

The control-plane side — the callback container, the plan catalogue, the enqueuer
— lives in a **different repository**, `Octobot-Onboard`, under
`outseta-paperclip-integration/`. It is not in this fork and does not ship with
it.

| Document there | What it holds |
| --- | --- |
| `docs/04-AGENT-PROVISIONING.md` | `secret.set` / `agent.create` payload contract |
| `docs/06-AGENT-TASKS.md` | `agent.task` payload contract |
| `docs/07-PAPERCLIP-SIDE-NOTES.md` | notes *out* of this fork, back to the control plane |
| `docs/99-AGENT-NOTES.md` | notes *into* this fork, from the control plane |
| `docs/testing/*.sql` | hand-runnable queue seeds |

**`99-` and `07-` are a pair and neither is a conversation** — each is one-way,
newest-first, and a later entry supersedes rather than edits an earlier one.
If you are changing a payload's meaning, the note goes in `07-`.

> **The authority for the table DDL is `database.js` in `Octobot-Onboard`, not
> this fork.** The tables are created at database-provisioning time, before
> Paperclip has ever started, because the first thing queued is the instance
> owner and it has to be waiting when the container first boots. **Do not add a
> Drizzle migration that creates them** — a migration creating
> `provisioning_jobs` in `public` makes `inspectMigrations` count non-empty
> `public` tables with no journal, and the instance comes up with nothing else
> created. That is why the tables live in a `provisioning` schema.

## History

| When | What |
| --- | --- |
| 2026-09-06 (Session 18) | Module first merged; `server-startup-feedback-export.test.ts` went red as a side effect (§4.1) |
| 2026-09-07 | `codexHome` on `agent.create` changed from a path to a **secret key**; `agent.create` gained reconcile-on-existing |
| 2026-09-08 | `agent.task` added — the first job type that **spends money on being applied** |
| 2026-09-08 | `membership.remove` built — the only job type that REVOKES. Archives memberships, reassigns open issues, revokes sessions and API keys; guards the last owner and the last instance admin |
| 2026-09-08 (Session 19) | Registered as change set 11. `server-startup-feedback-export.test.ts` repaired, 18/18 |

## Open

| Id | One line |
| --- | --- |
| — | **No budget cap.** `agent.task` dispatches paid agent runs and nothing reads `monthlyBudgetAmount` on either side. A dispatch capability landed before a spend cap; deliberate, but that is the order it happened in |
| — | **The enqueue grant is now wider than its name.** Anything holding `INSERT` on `provisioning_jobs` can make agents *act*, not just provision. The role in `registry.sql` is unchanged and still correct, but what it authorises is not what it authorised last week |
| — | **No park ceiling** (failure mode 6 above) |
| — | **`agent.create` does not reconcile a terminated same-name agent** — it creates a second under a deduplicated name. Left deliberately; reviving a terminated agent is a policy call, not a handler default |
