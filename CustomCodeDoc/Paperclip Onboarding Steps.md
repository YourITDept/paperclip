---
name: paperclip-onboarding-steps
description: The end-to-end workflow for standing up a Paperclip instance from nothing — instance bootstrap, first admin, API token, company, secrets, agents with secret-bound credentials, and member invites. Now implemented as onboard-paperclip-1.sh (Half A) and onboard-paperclip-2.sh (Half B). Says which steps are headless and which are not, and why.
metadata:
  status: current
  owner: Chris (cwa@youritdept.com)
  written: 2026-08-31
  verified-against: W5-20260830a (942c51bd5)
  last-run: 2026-08-31 — full flow exercised end to end on dev07 from a
    factory reset: step 1, engine start, run-test.sh, re-run for idempotence,
    --verify, and the codex PONG check. Three defects found and fixed; see
    "What the first real end-to-end run found".
---

# Paperclip Onboarding Steps

> **RULE 0 applies.** Never commit, push, or check anything in. See the top of
> [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md).

**What this is.** The whole path from a bare host to a working company with
agents that can authenticate to a model provider. Every command below was
verified against the CLI and the server's own validators on `W5-20260830a`.

**What this is for.** It was the specification for the onboarding scripts, and
they now exist: Half A is
[`onboard-paperclip-1.sh`](CustomCodeDoc/onboard-paperclip-1.sh), Half B is
[`onboard-paperclip-2.sh`](CustomCodeDoc/onboard-paperclip-2.sh), and
[`run-test.sh`](CustomCodeDoc/run-test.sh) drives the pair end to end.
[`testing-reset-database.sh`](CustomCodeDoc/testing-reset-database.sh) puts the
host back to any of three states so the flow can be re-run. Companion
reference: [`paperclipai-cli-reference.md`](CustomCodeDoc/paperclipai-cli-reference.md).

Where the implementation diverged from what is written below, the note says so.

---

## The shape of the problem

Onboarding splits into **two halves that need different credentials**, and
conflating them is what makes it feel harder than it is.

| Half | Steps | Script | Acts as | Engine running? |
| --- | --- | --- | --- | --- |
| **A — instance bootstrap** | 1–3 | `onboard-paperclip-1.sh` | the host (direct DB / local CLI) | partly |
| **B — tenant setup** | 4–8 | `onboard-paperclip-2.sh` | an authenticated board user (`PAPERCLIP_API_KEY`) | **yes, always** |

Half A is now fully scriptable — the browser interaction it used to need is gone
(see Step 2). Half B is entirely headless. Everything in Half B is also
**re-runnable**, which is what makes this usable for environment migration
rather than one-time setup.

### The engine has to be running before Half B, and it is not after Half A

This is the seam where the two halves meet, and it is the easiest thing to trip
over, because **Half A deliberately leaves the engine stopped.**
`onboard-paperclip-1.sh` starts one only long enough to write the config and let
migrations run, then signals its process group and stops it again. Starting the
real engine belongs to whatever supervises the host.

Half B has no offline path whatsoever:

* the board API key is minted **through** the engine (`POST /api/board-api-keys`)
* every `paperclipai` command in Half B is an HTTP request to the engine
* every step from 4 to 8 is a write

So Half B is gated on a **healthy** engine, not merely a reachable port:

```bash
./onboard-paperclip-1.sh --check-engine    # exits 0 only when running AND healthy
```

`/api/health` answers `status: "unhealthy"` with `error: "database_unreachable"`
when the process is up but Postgres is not, and in that state `bootstrapStatus`
is **absent**. Checking reachability alone reads that as "unknown" and lets it
through, so the run fails later, one phase at a time, as a string of confusing
401s and permission errors. `--check-engine` and Half B's own preflight both
check `status`.

The one exception: `--dry-run` prints a plan and touches nothing, so it works
against a stopped engine on purpose.

---

## Step 1 — Install and configure the instance

Implemented by `onboard-paperclip-1.sh`. It runs `paperclipai onboard`
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

**This was the only step that was not headless. It is now, and the two ways of
getting there are not interchangeable — see "What was actually built" below.**

`POST /api/bootstrap/claim` requires `req.actor.source === "session"` — a real
Better Auth browser session ([`access.ts:2728`](server/src/routes/access.ts#L2728)).
An API key is rejected. **So is this fork's `proxy_header` actor**, which is the
obvious thing to reach for.

Three ways to get there. **The implementation uses the third.**

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

**2c — write the role directly, which is what the scripts do.** See below.

> **After signup is disabled, proxy auth is the only thing that can create a
> user.** The existing script already warns about this. With
> `PAPERCLIP_PROXY_AUTH_ENABLED=true` **and**
> `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true`, an unknown email arriving in
> `X-Forwarded-User` gets a real `authUsers` row
> ([`proxy-header-auth.ts:150`](server/src/auth/proxy-header-auth.ts#L150)).
> Turn signup off without proxy auth on and no new account can ever be created.

### What was actually built — the gap is closed

Accepting a bootstrap invite is a browser step, so neither 2a nor 2b is
unattended. The gap was closed the way this section predicted, but in the
scripts rather than in the CLI: `onboard-paperclip-1.sh` writes the
`instance_user_roles` row itself. That is safe for the same reason
`auth bootstrap-ceo` is — `claimFirstInstanceAdmin()` does exactly one thing,
insert a single row, with no memberships or grants to keep in step.

The user row is **not** created by hand. One authenticated request carrying the
proxy-auth header auto-provisions it (`PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true`),
which keeps knowledge of the Better Auth `user` schema out of the scripts.

Two modes, and the difference matters:

| Mode | Semantics | Use |
| --- | --- | --- |
| `--claim-admin` | first-come-first-served. Grants `instance_admin` **only while nobody holds it**, and refuses to reassign. | a first claim |
| `--set-owner` | authoritative. Makes one email the **sole** `instance_admin`, removes any other holder, and revokes every live `bootstrap_ceo` invite. Idempotent. | every run; Half B calls it |

```bash
./onboard-paperclip-1.sh --set-owner --owner-email you@example.com
```

`--set-owner` exists because `--claim-admin` leaves two questions open once
onboarding is scripted: the bootstrap link Step 1 printed is a standing offer of
ownership to whoever holds it, and if someone already claimed, `--claim-admin`
silently leaves them in place. `--set-owner` overwrites both deterministically,
which is why `onboard-paperclip-2.sh` calls it on **every** run rather than only
when the instance is unclaimed.

> **The grant and the removal are one transaction**, with `ON_ERROR_STOP=1` and
> a checked exit status. As two unchecked statements this could leave the
> instance with **no admin at all**: a silently failing grant did not stop the
> delete. `set -e` was no protection either — the function is invoked as
> `lock_owner … || exit 1`, and errexit is disabled for the entire body of a
> function called that way. Worth remembering anywhere else in these scripts
> that a helper is called with `|| …`.

The bootstrap invite is still minted and saved to
`$(dirname $PAPERCLIP_CONFIG)/bootstrap-ceo-invite.txt` (mode 0600) as the
browser fallback for when proxy auth is off.

---

## Step 3 — Get an API token

Everything after this needs `PAPERCLIP_API_KEY`. The client layer reads
`--api-key`, then **`PAPERCLIP_API_KEY`**, then the stored board credential
([`client/common.ts:174`](cli/src/commands/client/common.ts#L174)).

**In practice `onboard-paperclip-2.sh` mints its own** and nothing has to be
exported: `POST /api/board-api-keys` requires only `actor.type === "board"` with
a userId ([`access.ts:2898`](server/src/routes/access.ts#L2898)) and — unlike
`POST /api/bootstrap/claim` — does **not** demand `source === "session"`, so
this fork's `proxy_header` actor qualifies. A key already in the environment
always wins. The browser route below is the fallback when proxy auth is off:

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

`onboard-paperclip-2.sh --verify` runs this check set and **changes nothing** —
it creates no company, secret or agent, mints no invites and assigns no task,
and it will not even mint an API key, because minting leaves a live credential
behind. It needs `PAPERCLIP_API_KEY` already set, and exits 1 if anything is
missing, so a test loop can gate on it.

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

## What the first real end-to-end run found

Everything above had been reasoned against the source. Running it against a
factory-reset host found three defects that reading could not, and all three
share a shape worth naming: **each one failed by reporting something other than
what was wrong.**

**1. `psql -c` does not interpolate psql variables.** The scripts had just been
changed from `lower('$email')` (shell interpolation) to `lower(:'email')` (a
bound psql variable) — the right instinct, and the fix the shell-safety rule
asks for, since it makes an apostrophe in an address a character rather than
syntax. But psql only interpolates on input it reads through its own lexer:
stdin or `-f`. With `-c` the string goes to the server verbatim, so `:'email'`
arrived as SQL and the server answered `syntax error at or near ":"`.

That error was then swallowed by `2>/dev/null`, and the empty result was read as
"no user row" — so `--set-owner` reported

```
no user row for 'admin@bringyouraito.life' — cannot make them the owner.
```

for an account that existed and could be selected by hand. Both `--claim-admin`
and `--set-owner` were dead, and step 2 could not get past preflight.

The fix keeps the binding and moves the SQL to stdin (a heredoc). The inserts
were always heredocs, which is why they were never affected — and why the bug
looked like it was about the *email* rather than about `-c`.

> **A query that errored and a query that matched nothing both come back empty.**
> Distinguishing them is the difference between "this account is not provisioned
> yet" and "the statement never reached the table". The lookups now capture
> stderr and fail loudly instead of guessing.

**2. `--mint-key` wrote its progress banner to stdout, next to the key.** The
documented way to use it is a command substitution, and `--verify`'s own failure
message recommends it by name:

```bash
export PAPERCLIP_API_KEY="$(./onboard-paperclip-2.sh --mint-key --owner-email you@example.com)"
```

`step`/`info` print to stdout, so that captured the preflight report *and* the
key — a 163-character "key" whose first three lines were a progress report. The
only symptom was `access whoami` failing exactly as if the token were wrong,
which sends you to look at proxy headers and the CSRF guard. In `--mint-key`
mode the diagnostics now go to stderr; the key is the only thing on stdout, and
a captured key is 58 characters.

**3. Invites are not idempotent, and cannot be.** The script header claimed
everything was. The company, secret, agent and task are — each is looked up by
name first. Invites are not: a re-run mints a fresh link per role and the old
ones stay live. Two runs of `run-test.sh` left four usable `admin`/`operator`
links on the instance.

This one has no fix, only a correction. The token is stored hashed and returned
exactly once, at creation, so "reuse the existing invite" could never print a
link. Converge the rest with `--only company,secrets,agent` and mint invites
deliberately; audit with `invite list -C <id>` and revoke the surplus.

### What the run also confirmed

* `DATABASE_URL` correctly falls back to the container's `POSTGRES_URL`
  (`dev07postgres97:5432`). The `127.0.0.1:5432` default in the script is dead
  on this host and would fail loudly if it were ever used.
* Step 1 does leave the engine stopped, and `--check-engine --wait` is a
  correct gate for step 2.
* The bootstrap invite is minted on the public URL. It had been passing a
  derived `https://$PAPERCLIP_FQDN` unconditionally, which contradicted the
  comment thirty lines above it and would have beaten a differing
  `PAPERCLIP_PUBLIC_URL`; it now passes `$PAPERCLIP_BASE_URL`, which encodes
  that precedence.
* `PORT` was hardcoded to `3100` while the container exports
  `PAPERCLIP_PORT=3100`. Same value today, so nothing broke — but every health
  check probes `127.0.0.1:$PORT`, so the moment the deployment moves, the whole
  script set reports `NOT RUNNING` against a healthy engine. It derives from
  `PAPERCLIP_PORT` now.
* `secrets doctor` is clean and the credential resolves end to end:
  `codex exec` reports `provider: openrouter` and answers `PONG`.

---

## Writing the script — notes that saved a rewrite

*Kept as written; the parenthetical says what the implementation did with each.*

1. **Split it at the credential boundary.** Steps 1–3 and steps 4–8 want
   different flags and different failure handling. (*Done as two files rather
   than sub-modes of one — `onboard-paperclip-1.sh` and `-2.sh`. Script 2 shells
   out to script 1 for `--set-owner`, which is the only coupling between them.*)
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
7. **Gate Half B on a healthy engine before anything else runs.** (*Added: the
   check runs before the key is minted, so a stopped engine reports itself
   instead of surfacing as a curl failure inside the key request, which reads
   like an auth problem and sends you looking at proxy headers.*)
8. **Make the config path agree everywhere.** (*Fixed: `onboard-paperclip-1.sh`
   fell back to `/install/config/paperclip/config.json`, which does not exist on
   this host, while `testing-reset-database.sh` fell back to `/sysops/...`. Both
   use `/sysops` now. It only bites when `PAPERCLIP_CONFIG` is not exported —
   under `sudo`, `cron` or `sh -c` — which is exactly when it is hardest to
   spot.*)
