---
name: paperclip-onboarding-steps
description: The end-to-end workflow for standing up a Paperclip instance from nothing — instance bootstrap, first admin, API token, company, secrets, agents with secret-bound credentials, and member invites. Written to be turned into a script and merged into onboard-paperclip.sh. Says which steps are headless and which are not, and why.
metadata:
  status: current
  owner: Chris (cwa@youritdept.com)
  written: 2026-08-31
  verified-against: W5-20260830a (28998bf27)
---

# Paperclip Onboarding Steps

> **RULE 0 applies.** Never commit, push, or check anything in. See the top of
> [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md).

**What this is.** The whole path from a bare host to a working company with
agents that can authenticate to a model provider. Every command below was
verified against the CLI and the server's own validators on `W5-20260830a`.

**What this is for.** It is the specification for the onboarding script we are
going to write and merge into
[`onboard-paperclip.sh`](CustomCodeDoc/onboard-paperclip.sh). Companion
reference: [`paperclipai-cli-reference.md`](CustomCodeDoc/paperclipai-cli-reference.md).

---

## The shape of the problem

Onboarding splits into **two halves that need different credentials**, and
conflating them is what makes it feel harder than it is.

| Half | Steps | Acts as | Server running? |
| --- | --- | --- | --- |
| **A — instance bootstrap** | 1–3 | the host (direct DB / local CLI) | partly |
| **B — tenant setup** | 4–8 | an authenticated board user (`PAPERCLIP_API_KEY`) | yes |

Half A can be fully scripted **except one browser interaction**. Half B is
entirely headless. Everything in Half B is also **re-runnable**, which is what
makes this usable for environment migration rather than one-time setup.

---

## Step 1 — Install and configure the instance

Already implemented by `onboard-paperclip.sh`. It runs `paperclipai onboard`
prompt-free (`--yes`, values from the environment), then patches config:
`logging.logDir`, `auth.disableSignUp=true`, `telemetry.enabled=false`, and the
secrets master key path.

**Preconditions to assert before anything else:**

```bash
[ -n "$PAPERCLIP_CONFIG" ] && [ -f "$PAPERCLIP_CONFIG" ]
[ -n "$PAPERCLIP_HOME" ] && [ -n "$PAPERCLIP_INSTANCE_ID" ]
[ -w "$LOG_DIR" ]
```

> **The secrets master key is the one irreversible thing here.** Everything in
> Step 5 is encrypted with it. If `PAPERCLIP_SECRETS_MASTER_KEY_FILE` moves or
> is regenerated, every stored secret is orphaned — they cannot be recovered,
> only recreated. The existing script already refuses to guess when it finds a
> key at two paths; keep that behaviour and back the key up before any migration.

---

## Step 2 — Create the first instance admin

**This is the only step that is not headless, and it is worth understanding why
rather than fighting it.**

`POST /api/bootstrap/claim` requires `req.actor.source === "session"` — a real
Better Auth browser session ([`access.ts:2728`](server/src/routes/access.ts#L2728)).
An API key is rejected. **So is this fork's `proxy_header` actor**, which is the
obvious thing to reach for.

Two ways to get there. **Use the second.**

**2a — open signup and race (what the script does today).** Onboard with signup
open, claim from a browser, then `--lock-signup`. Works, but between those steps
*anyone* who can reach the port can claim the instance. The script's own header
explains it chose this because "there is no CLI command that creates a user".

**2b — mint a bootstrap invite (better).**

```bash
paperclipai auth bootstrap-ceo            # --force to reissue; --expires-hours N
```

Writes **directly to the database** — no server needed. It refuses when an
`instance_admin` already exists, revokes any live `bootstrap_ceo` invite, and
prints a single-use `<baseUrl>/invite/<token>`. **Signup stays closed the whole
time.** One person opens one link. The race disappears.

Then close the door:

```bash
./onboard-paperclip.sh --lock-signup
```

> **After signup is disabled, proxy auth is the only thing that can create a
> user.** The existing script already warns about this. With
> `PAPERCLIP_PROXY_AUTH_ENABLED=true` **and**
> `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true`, an unknown email arriving in
> `X-Forwarded-User` gets a real `authUsers` row
> ([`proxy-header-auth.ts:150`](server/src/auth/proxy-header-auth.ts#L150)).
> Turn signup off without proxy auth on and no new account can ever be created.

### The remaining gap, and how to close it

Accepting that invite is a browser step. To make onboarding fully unattended,
add a CLI command that calls the existing
[`claimFirstInstanceAdmin()`](server/src/services/access.ts#L744) directly —
`auth bootstrap-ceo` already establishes direct DB writes from the CLI as an
accepted pattern, so this is small and stays inside the fork. **Not implemented;
it is a fork-carried feature and needs sign-off.**

---

## Step 3 — Get an API token

Everything after this needs `PAPERCLIP_API_KEY`. The client layer reads
`--api-key`, then **`PAPERCLIP_API_KEY`**, then the stored board credential
([`client/common.ts:174`](cli/src/commands/client/common.ts#L174)).

```bash
paperclipai auth login                    # browser approval, once
paperclipai token board create --json     # then mint a scriptable token
export PAPERCLIP_API_KEY="…"
export PAPERCLIP_API_URL="https://<host>"      # origin only — no /api
paperclipai access whoami                 # assert before continuing
```

**Assert `whoami` succeeds before Step 4.** Every later failure otherwise
surfaces as a confusing 401 rather than "you have no token".

---

## Step 4 — Create the company

Only `name` is required ([`createCompanySchema`](packages/shared/src/validators/company.ts#L24)).
There is **no slug, no domain, no identifier to choose**.

```bash
COMPANY_ID=$(paperclipai company create --json --payload-json "$(jq -nc '{
  name: "Acme Robotics",
  description: "Primary operating company",
  budgetMonthlyCents: 50000
}')" | jq -r '.id')
```

Rename later with `company update`. **Build every payload with `jq -nc`, never
string interpolation** — see the shell-safety rule in the CLI reference.

---

## Step 5 — Install secrets

```bash
export OPENROUTER_API_KEY="sk-or-…"       # from the environment, not argv

SECRET_ID=$(paperclipai secrets create --json \
  -C "$COMPANY_ID" \
  --name "OpenRouter" \
  --key openrouter_api_key \
  --value-env OPENROUTER_API_KEY \
  --description "OpenRouter key for Codex-backed agents" | jq -r '.id')
```

**`--value-env` is the flag that matters.** The value never appears in `argv`,
so it stays out of `ps`, out of shell history, and out of any process listing an
agent could read. A script that passes `--value` has leaked the key to every
process on the box for the lifetime of the call.

For maintenance: `secrets rotate` changes the value without re-linking
consumers, `secrets doctor` checks declarations against bindings, and
`secrets migrate-inline-env` pulls values already inlined in adapter config into
managed secrets — that last one is the migration path off ad-hoc env wiring.

---

## Step 6 — Create agents with the secret bound in

```bash
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

`adapterConfig.env` is a map of **`EnvBinding`**
([`secrets.ts:51`](packages/shared/src/types/secrets.ts#L51)): `plain`,
`secret_ref`, `user_secret_ref`, or a legacy bare string. The heartbeat resolves
every binding before dispatch, so **rotating the secret changes what the next run
uses and the agent is never edited.**

`name` and `adapterType` are required; `adapterConfig` defaults to `{}`. An
invalid binding fails with *"adapterConfig.env must be a map of valid env
bindings"*. `desiredSkills` is accepted here too, so an agent can get its skills
in the same call instead of a later `skills:sync`.

> **Why bind rather than rely on the host environment.** Resolved adapter env is
> merged into the launch environment *after* the ACPX host-env projection and is
> deliberately not filtered by it. A host-exported `OPENROUTER_API_KEY` is
> filtered unless the fork's allowlist entry (§4 change set 9) is present; a
> secret-bound one is not, ever. **Binding per agent is structurally immune to
> the class of failure that broke OpenRouter in Session 12.**

---

## Step 7 — Invite the people

**Invites are links. There is no email field and Paperclip sends no mail** — so
there is no "add user by email" command to look for. `POST /api/companies/:id/invites`
([`access.ts:3303`](server/src/routes/access.ts#L3303)), permission `users:invite`.

```bash
paperclipai invite create --json -C "$COMPANY_ID" \
  --payload-json "$(jq -nc '{allowedJoinTypes:"human", humanRole:"admin"}')"
```

| Field | Required | Values |
| --- | --- | --- |
| `allowedJoinTypes` | **yes** | `human` · `agent` · `both` |
| `humanRole` | no → **`operator`** | `owner` · `admin` · `operator` · `viewer` |

Link is `<baseUrl>/invite/<token>`. `invite list -C` / `invite revoke <id>` manage them.

> **`humanRole` defaults to `operator`, silently.** Omitting it does not mean
> "no role". Set it explicitly whenever you mean `admin` or `owner`. When
> `allowedJoinTypes` is `agent` the role is forced to `null`.

Do not confuse the two invite kinds: **`auth bootstrap-ceo`** is *instance*-level
(`bootstrap_ceo`, direct DB write, first admin only); **`invite create`** is
*company*-level (`company_join`, via API, needs `users:invite`).

---

## Step 8 — Verify, and mean it

A script that does not verify has only *probably* onboarded.

```bash
paperclipai access whoami                 # token is live
paperclipai company list --json           # company exists
paperclipai secrets doctor -C "$COMPANY_ID"   # bindings resolve
paperclipai agent list -C "$COMPANY_ID" --json
paperclipai invite list -C "$COMPANY_ID" --json
```

**Verify the provider credential end to end, not just that the secret exists.**
The failure mode is an agent that looks perfectly configured and gets a 401 on
first run:

```bash
CODEX_HOME=/sysops/llm/openrouter/default \
  codex exec --skip-git-repo-check "Reply with exactly: PONG"
```

Expect `provider: openrouter` and `PONG`. Without the key reaching the child you
get `provider auth command 'sh' produced an empty token` and a `401`.

---

## Writing the script — notes that will save a rewrite

1. **Split it at the credential boundary.** Steps 1–3 and steps 4–8 want
   different flags and different failure handling. `--bootstrap` and
   `--provision` sub-modes, mirroring the existing `--apply-config` /
   `--lock-signup` shape.
2. **Make Half B idempotent.** Look up by name before creating; treat "exists"
   as success. That is what makes it usable for migration and re-run, not just
   first install.
3. **Never take a secret as an argument.** Read from the environment and pass
   `--value-env`. Refuse to run if the variable is unset rather than creating an
   empty secret.
4. **`set -euo pipefail`, and check `whoami` before Half B.**
5. **Emit ids as it goes** (`COMPANY_ID`, `SECRET_ID`, agent ids) so a partial
   run can be resumed rather than restarted.
6. **Do not commit anything the script rewrites.** Onboarding touches config and
   may regenerate files; RULE 0 applies to scripts too.
