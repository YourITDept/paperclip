---
name: paperclipai-cli-reference
description: What the paperclipai CLI can do from a script — the full command surface, how to authenticate headlessly, and the exact bootstrap chain for creating a company, secrets and agents without using the web UI. Written for onboarding and environment-migration work.
metadata:
  status: current
  owner: Chris (cwa@youritdept.com)
  written: 2026-08-31
  verified-against: W5-20260830a (28998bf27)
---

# `paperclipai` from the command line — capability reference

> **RULE 0 applies here too.** Never commit, push, or check anything in. See the
> top of [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md).

**Upstream's own CLI documentation is [`doc/CLI.md`](doc/CLI.md)** (1081 lines) —
read it for per-command flags and the shell-safety matrix. **This file answers a
different question:** *what can be done headlessly, in what order, and where does
that break down.* It exists because the onboarding scripts in this directory need
that answer and upstream's doc does not organise around it.

---

## 1. The CLI is two different things

| Layer | Where | What it does | Needs a running server |
| --- | --- | --- | --- |
| **Local / lifecycle** | `cli/src/commands/*.ts` | `install`, `uninstall`, `update`, `onboard`, `doctor`, `env`, `channels`, `configure`, `db:backup`, `allowed-hostname`, `run`, `heartbeat`, `auth bootstrap-ceo` | no — some write the DB directly |
| **API client** | `cli/src/commands/client/*.ts` | everything else: companies, agents, secrets, tokens, issues, skills, plugins, routines … | **yes** — HTTP against `/api` |

The distinction matters for onboarding: the first layer can act on a stopped
instance, the second cannot.

---

## 2. Authentication — the part that decides whether onboarding can be headless

The API-client layer resolves its credential in this order
([`client/common.ts`](cli/src/commands/client/common.ts)):

1. `--api-key` on the command line
2. **`PAPERCLIP_API_KEY` in the environment**  ← the one to use in scripts
3. the stored board credential from `paperclipai auth login`

`PAPERCLIP_API_URL` sets the base URL. **So once a token exists, every command in
§4 is scriptable with no interactive step at all.**

### 2.1 Getting that first token — and the one real gate

`paperclipai auth login` is a browser-approval flow: it creates a CLI auth
challenge and needs a signed-in browser user to approve it.

The deeper gate is **first-instance-admin**. `POST /api/bootstrap/claim`
([`access.ts:2728`](server/src/routes/access.ts#L2728)) requires:

```ts
req.actor.type !== "board" || req.actor.source !== "session" || !req.actor.userId
  → 401 "Sign in from a browser session before claiming first admin"
```

`source === "session"` means a **Better Auth browser session**. An API-key actor
is rejected. **So is this fork's `proxy_header` actor** — worth stating plainly,
because it is the obvious thing to reach for and it does not work.

> **Verified, not assumed.** The fork's proxy-header auth *does* auto-provision a
> real row in `authUsers` when `PAPERCLIP_PROXY_AUTH_ENABLED=true` and
> `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true`
> ([`proxy-header-auth.ts:150`](server/src/auth/proxy-header-auth.ts#L150)) — so
> it creates the *user* headlessly. It still cannot *claim* first admin, because
> the claim route insists on `source === "session"`. Auto-provisioning solves half
> the problem; the claim is the half that remains.

### 2.2 What removes the signup race today

`paperclipai auth bootstrap-ceo` ([`auth-bootstrap-ceo.ts`](cli/src/commands/auth-bootstrap-ceo.ts))
writes **directly to the database** — no server needed. It:

- refuses if an `instance_admin` already exists (unless `--force`)
- revokes any live `bootstrap_ceo` invite
- mints a single-use invite (`inviteType: "bootstrap_ceo"`, human join only,
  default 72h) and prints `<baseUrl>/invite/<token>`

**This is strictly better than the two-phase approach in
[`onboard-paperclip.sh`](CustomCodeDoc/onboard-paperclip.sh).** That script opens
signup to the world and races to claim, because its header says "there is no CLI
command that creates a user". That is accurate — but a *bootstrap invite* removes
the need for open signup entirely: keep signup closed, mint one invite, hand it to
exactly one person.

**One browser interaction still remains** — accepting the invite. As of
`W5-20260830a` there is no command that grants `instance_admin` outright.

### 2.3 Closing the last gap — options, not yet implemented

If fully unattended bootstrap is wanted, in increasing order of blast radius:

1. **A CLI command that grants the role directly.** `claimFirstInstanceAdmin()`
   already exists in [`access.ts`](server/src/services/access.ts#L744) and
   `auth bootstrap-ceo` already proves direct DB writes from the CLI are an
   accepted pattern. This is the smallest change and stays inside the fork.
2. **Let the claim route accept a `proxy_header` actor** behind an explicit
   env flag. Smaller code, larger blast radius: it widens a security boundary
   upstream deliberately narrowed, and it is a fork-carried change in a file
   upstream edits.
3. **Seed `instanceUserRoles` from the onboarding script.** No code change, but
   it puts schema knowledge in a shell script — the thing most likely to rot on
   the next upstream migration.

**Option 1 is the recommendation.**

---

## 3. The headless bootstrap chain

Once a token exists, this is the whole sequence. Every step is verified to exist.

> **Note the calling convention.** `company create`, `agent create` and
> `agent update` do **not** take per-field flags. They take
> `--payload-json '<json>'` — the API payload, verbatim. Only `secrets` uses
> granular flags. Build the JSON with `jq -n`, never string interpolation.

```bash
export PAPERCLIP_API_URL="https://your-host"      # origin only — no /api
export PAPERCLIP_API_KEY="…"          # never inline a secret in a script

# 1. company
COMPANY_ID=$(paperclipai company create --json \
  --payload-json "$(jq -nc '{name:"Acme"}')" | jq -r '.id')

# 2. secret — value read from the environment, never from argv
export OPENROUTER_API_KEY="sk-or-…"
SECRET_ID=$(paperclipai secrets create --json \
  -C "$COMPANY_ID" \
  --name "OpenRouter" \
  --key openrouter_api_key \
  --value-env OPENROUTER_API_KEY | jq -r '.id')

# 3. agent, with the secret bound into its adapter env — see §3.2
paperclipai agent create --json -C "$COMPANY_ID" --payload-json "$(jq -nc \
  --arg sid "$SECRET_ID" '{
    name: "Codex Worker",
    adapterType: "codex_local",
    adapterConfig: {
      env: {
        CODEX_HOME:         { type: "plain",      value: "/sysops/llm/openrouter/default" },
        OPENROUTER_API_KEY: { type: "secret_ref", secretId: $sid }
      }
    }
  }')"
```

**`--value-env` is the flag that matters for onboarding.** The secret never
appears in `argv`, so it stays out of `ps`, out of shell history, and out of any
process listing an agent could read.

### 3.1a Creating and naming a company

`POST /api/companies` — [`createCompanySchema`](packages/shared/src/validators/company.ts#L24).
**Four fields, and only `name` is required.** There is no slug, no domain and no
identifier to choose; the id comes back in the response.

| Field | Required | Notes |
| --- | --- | --- |
| `name` | **yes** | the company name — non-empty, this is what you are naming |
| `description` | no | nullable |
| `budgetMonthlyCents` | no (`0`) | integer, non-negative |
| `defaultResponsibleUserId` | no | the user issues fall back to |

```bash
COMPANY_ID=$(paperclipai company create --json --payload-json "$(jq -nc '{
  name: "Acme Robotics",
  description: "Primary operating company",
  budgetMonthlyCents: 50000
}')" | jq -r '.id')
```

Rename later with `company update --payload-json '{"name":"New Name"}'`.
`company list` and `company current` read them back.

### 3.1b Adding people — invites are links, not emails

**There is no email field and Paperclip sends no mail.** An invite is a
**token**, and the deliverable is a URL you pass to the person however you like.
That is the whole membership mechanism, and it is why there is no "add user by
email" command to look for.

`POST /api/companies/:companyId/invites` — the route is
[`access.ts:3303`](server/src/routes/access.ts#L3303), guarded by the
`users:invite` permission.

| Field | Required | Values |
| --- | --- | --- |
| `allowedJoinTypes` | **yes** | `human` · `agent` · `both` |
| `humanRole` | no — defaults to **`operator`** | `owner` · `admin` · `operator` · `viewer` |
| `defaultsPayload` | no | defaults applied to whoever joins |
| `agentMessage` | no | for agent joins |

```bash
# invite a person as an operator (the default role)
paperclipai invite create --json -C "$COMPANY_ID" \
  --payload-json "$(jq -nc '{allowedJoinTypes:"human"}')"

# invite a company admin
paperclipai invite create --json -C "$COMPANY_ID" \
  --payload-json "$(jq -nc '{allowedJoinTypes:"human", humanRole:"admin"}')"

paperclipai invite list   -C "$COMPANY_ID"   # outstanding invites
paperclipai invite revoke "$INVITE_ID"       # kill one
```

The response carries the token; the link is `<baseUrl>/invite/<token>`. Invites
expire (`companyInviteExpiresAt()`), so mint them close to when they are used.

> **`humanRole` silently defaults to `operator`.** If `allowedJoinTypes` is
> `agent` the role is forced to `null`. Set `humanRole` explicitly whenever you
> mean `admin` or `owner` — omitting it does not mean "no role", it means
> operator.

**So the two invite kinds are different things:** `auth bootstrap-ceo` (§2.2)
mints an *instance*-level `bootstrap_ceo` invite for the very first admin, by
direct DB write with no server running. `invite create` mints a *company*-level
`company_join` invite through the API, and needs an authenticated caller who
already has `users:invite`. Bootstrap first, then invite everyone else.

### 3.2 How a secret reaches the agent — the binding shape

This is the mechanism, and it is the reason the pattern above works.

An agent's `adapterConfig.env` is a map of **`EnvBinding`**
([`shared/src/types/secrets.ts:51`](packages/shared/src/types/secrets.ts#L51)).
Four forms are accepted:

| Form | Shape | Use |
| --- | --- | --- |
| plain | `{ "type": "plain", "value": "…" }` | non-secret config (`CODEX_HOME`, model) |
| **secret ref** | `{ "type": "secret_ref", "secretId": "<uuid>" }` | **a company secret — this is the one you want** |
| user secret ref | `{ "type": "user_secret_ref", "key": "…" }` | per-user credential |
| legacy string | `"literal"` | still accepted; avoid for secrets |

At run time the heartbeat resolves every binding through
`secretsSvc.resolveEnvBindings()` before dispatch
([`heartbeat.ts:1216`](server/src/services/heartbeat.ts#L1216)), producing
`resolvedConfig.env` — the adapter's `config.env`, with real values in place of
refs. Rotating the secret changes what the next run resolves; the agent is never
edited.

**Why this is the right place to put provider credentials in this fork.**
Resolved adapter env is merged into the launch environment *after* the ACPX
host-environment projection, and is deliberately not filtered by it — only
`PAPERCLIP_API_KEY` is ever refused
([`server-utils.ts:152`](packages/adapter-utils/src/server-utils.ts#L152)). A key
bound this way therefore reaches the child process whatever the allowlist says,
which is exactly the failure mode that broke OpenRouter in Session 12. A
secret-bound agent is immune to that class by construction.

#### The `agent create` payload — verified fields

From [`createAgentSchema`](packages/shared/src/validators/agent.ts#L72):

| Field | Required | Notes |
| --- | --- | --- |
| `name` | **yes** | non-empty |
| `adapterType` | **yes** | e.g. `codex_local`, `claude_local` |
| `adapterConfig` | no (`{}`) | `.env` is validated against the EnvBinding map — an invalid binding fails with *"adapterConfig.env must be a map of valid env bindings"* |
| `role` | no (`general`) | |
| `desiredSkills` | no | assign skills at creation instead of a later `skills:sync` |
| `reportsTo`, `defaultEnvironmentId` | no | GUIDs |
| `budgetMonthlyCents` | no (`0`) | |
| `title`, `icon`, `capabilities`, `permissions`, `runtimeConfig`, `metadata` | no | |

`desiredSkills` is worth knowing for onboarding: it gives an agent its skills in
the same call, so a scripted setup needs one request rather than create-then-sync.

**Precedence, so an override behaves predictably:** an explicit `CODEX_HOME` in
adapter config outranks `PAPERCLIP_CODEX_HOME` from the host env. Setting
`CODEX_HOME` per agent is what the fork's "Create agent from a login vault"
button already does — §4 change set 5.

### 3.1 Secrets — the full verb set

`list · declarations · create · link · update · rotate · usage · access-events ·
delete · doctor · providers · provider-configs · migrate-inline-env`

Three of these matter for maintaining an environment over time:

- **`rotate`** — key rotation without re-linking every consumer.
- **`migrate-inline-env`** — pulls values already inlined in adapter config into
  managed secrets. This is the migration path off ad-hoc env wiring.
- **`doctor`** — checks declarations against what is actually bound.

---

## 4. Full command surface

Verified against `W5-20260830a`. Names only; use `--help` for flags.

| Group | Commands |
| --- | --- |
| **access** | health, access, openapi, profile, company-user, invite, revoke, test-resolution, skill, accept, join, list, claim-key, member, admin, user, company-access, company-access:update, instance, database-backup, sidebar, inbox, board-claim, show, claim, openclaw, available-skill, get, llm, agent-configuration:adapter, whoami |
| **agent** | me, inbox, inbox-mine, list, get, create, hire, update, delete, permissions:update, configuration, config-revisions, config-revision:get, config-revision:rollback, runtime-state, runtime-state:reset-session, task-sessions, skills, skills:sync, instructions-path:update, instructions-bundle, instructions-bundle:update, instructions-file:get/put/delete, wake, local-cli |
| **company** | list, get, current, stats, create, update, branding:update, archive, feedback:list, feedback:export, export, import, delete |
| **secrets** | list, declarations, create, link, update, rotate, usage, access-events, delete, doctor, providers, provider-configs, migrate-inline-env |
| **token** | agent create/list/revoke, board create/list/revoke |
| **auth** | login, logout, revoke-current, whoami, challenge create/get |
| **issue** | ~60 verbs — CRUD, comments, documents, interactions, work products, attachments, labels, runs, checkout/release |
| **skills / teams** | browse, search, inspect, install, sync, audit, import, create … |
| **adapter** | list, get, delete, config-schema, ui-parser, models |
| **workspace** | org, agent-config, workspace, environment, lease, project-workspace, list, delete |
| **plugin** | init, list, install, target, uninstall, enable, disable, inspect, examples, bridge:stream |
| **routine-api** | list, revision:restore, runs, trigger:fire |
| Others | activity, approval, asset, connect, connections, context, cost, dashboard, feedback, goal, project, prompt, run |

**Local/lifecycle:** `install · uninstall · update · onboard · doctor · env ·
channels · configure · db:backup · allowed-hostname · run · heartbeat ·
auth bootstrap-ceo`

---

## 5. Shell-safety rule, carried from upstream

From [`doc/CLI.md`](doc/CLI.md), and it matters for onboarding scripts that pass
values through:

**Use `npx paperclipai` for any argument that can carry untrusted content** —
issue text, comment bodies, model output. `pnpm paperclipai` appends the argument
to a `/bin/sh` command string, so a backtick, `$( )` or `$NAME` in the value is
evaluated *before* the CLI starts. Quoting the shell variable does not save you;
`pnpm` re-evaluates it in its own shell.

---

## 6. Where this leaves the onboarding scripts

| Want | Possible headlessly today | How |
| --- | --- | --- |
| Create a user | **yes** | proxy-header auth + `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true` |
| Become first instance admin | **no** — one browser step | `auth bootstrap-ceo` → accept invite |
| Create a company | yes | `company create` |
| Install secrets | yes | `secrets create --value-env` |
| Create + configure agents | yes | `agent create`, `agent configuration`, `secrets link` |
| Mint API tokens | yes | `token agent create`, `token board create` |
| Migrate inline env → secrets | yes | `secrets migrate-inline-env` |

**Everything except first-admin is already scriptable.** The remaining gap is
one browser interaction, once per instance, and §2.3 option 1 would close it.
