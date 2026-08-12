# Reverse Proxy / Forward-Auth Integration — Working Document

**Status:** Implemented and working; off by default. Carried as a fork patch and
re-applied to each new working branch — see §0.
**Owner:** cwa@youritdept.com
**Repo:** `YourITDept/paperclip` (fork of `paperclipai/paperclip`)
**Created:** 2026-08-01 · **Last re-applied:** 2026-08-12 (Session 5)

> **How to use this file.** This is a living document. §0 is the operating
> instruction for re-applying the work. The middle (Problem → Options → Risks)
> is the original proposal and the investigation behind it. The bottom
> (**Running Log**) is an append-only record of everything we actually do, so
> the work can be repeated, audited, or handed to someone else. Add a new dated
> entry to the log for every session; don't rewrite old entries, amend them with
> a follow-up line.

---

## 0. Start here — re-applying this on a new branch

This feature is an **add-on that upstream does not carry**. Every time the fork
takes a fresh branch from `paperclipai/paperclip`, that branch has none of it and
it has to be re-applied. That has now happened three times (Sessions 2, 4, 5).
This section exists so the next time is a single prompt.

### The prompt to use

> Re-apply the reverse-proxy / forward-auth add-on to this checkout. Follow
> `ReverseProxyCustomChanges.md` — start at §0, which tells you everything you
> need. When you're done, append a new dated session entry to the Running Log at
> the bottom of that file. Don't commit unless I ask.

Nothing else needs to be said. Everything below is what that prompt relies on.

### What you are re-applying

A generic trusted-proxy-header auth source: a new actor `source` called
`proxy_header`, resolved from `X-Forwarded-User`, slotted into the existing
actor-resolution chain between the Cloud-tenant path and the Better Auth session
path. Fourteen files. **No UI changes** (see §3.3 for why). Off unless
`PAPERCLIP_PROXY_AUTH_ENABLED=true`. Full rationale in §4 Option B; the original
implementation notes are in §8 Session 2.

### Method — cherry-pick, do not hand-rewrite

The work exists as a real commit. **Check it is still reachable first:**

```bash
git branch -a --contains 265dea18a     # Session 4 forward-port, the one to use
git log --all --oneline -- 'server/src/auth/proxy-header-auth.ts'
```

As of Session 5 it is on `W20260811a`, `origin/W20260810b`, `origin/W20260811a`
and `origin/WORKINGv2`. If it is reachable:

```bash
git cherry-pick -n 265dea18a
```

Use `-n` so nothing is committed until it has been reviewed. Cherry-pick rather
than re-typing from this document **deliberately** — upstream drift then shows up
as a genuine conflict instead of being silently missed. If the commit has been
garbage-collected or the fork re-cloned without those branches, fall back to
re-implementing from §4 Option B plus the file-by-file table in §8 Session 2 —
but exhaust the git route first.

Note the working tree may already hold an untracked copy of this file that the
cherry-pick also wants to write. Diff it against the committed version before
moving it aside; in Session 5 they were byte-identical.

### Where it conflicts — and the conflict moves

Only a handful of files ever drift, but **which one conflicts changes between
sessions**, so don't pattern-match on last time:

| Session | Conflicting file | Cause |
| --- | --- | --- |
| 4 | `server/src/middleware/auth.ts` | master extracted `isCloudManagedInstance()` into `services/cloud-instance.js`; keep master's re-export, keep our `resolveProxyHeaderActor` |
| 5 | `server/src/realtime/live-events-ws.ts` | master added a `resolveCloudActor` branch above the `deploymentMode` guard we edit; keep both |

The invariant to preserve in both files is the **precedence order**:

```
bearer token → cloud tenant → proxy header → Better Auth session
```

Bearer is first on purpose — that is what makes it impossible for this feature to
break agent, CLI, or webhook auth server-side (§3.2, Risk #2).

### Verifying — the commands that constitute "done"

A fresh checkout usually has no `node_modules` (true in Sessions 4 and 5):

```bash
pnpm install --frozen-lockfile
pnpm --filter @paperclipai/server typecheck

# the feature's own suites
pnpm --filter @paperclipai/server exec vitest run \
  src/auth/proxy-header-auth.test.ts src/middleware/proxy-header-actor.test.ts

# auth regression sweep
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/live-events-ws.test.ts src/middleware/cloud-tenant-actor.test.ts \
  src/__tests__/board-mutation-guard.test.ts src/__tests__/error-handler.test.ts \
  src/__tests__/auth-session-route.test.ts src/__tests__/authorization-service.test.ts
```

Session 5 baseline: typecheck clean, 24/24 feature tests, 110/110 sweep, plus
62/62 across `auth-routes`, `agent-auth-middleware`, `agent-auth-jwt`,
`better-auth`, `cli-auth-routes`, `express5-auth-wildcard`,
`authz-secret-context`. Anything below that is a regression worth chasing.

### Traps that have bitten us more than once

1. **The deployment host's own environment leaks into the tests.** This box
   exports `PAPERCLIP_PROXY_AUTH_ENABLED=true`, `..._AUTO_PROVISION=true` and
   `..._USER_HEADER`, which silently change what the assertions mean. It cost a
   failure in Session 4 and again in Session 5. `proxy-header-actor.test.ts` now
   has a `beforeEach` pinning all four vars to defaults — **keep it**, and if you
   add a test, prove it passes both with the vars set and with them stripped
   (`env -u PAPERCLIP_PROXY_AUTH_ENABLED -u PAPERCLIP_PROXY_AUTH_AUTO_PROVISION …`).
2. **The `source` union is duplicated in six places** and `proxy_header` must be
   added to all of them. Two *other* union sites — [`routes/authz.ts:213`](server/src/routes/authz.ts#L213)
   and [`services/tool-access.ts:4798`](server/src/services/tool-access.ts#L4798) —
   deliberately do **not** get it; they predate the feature and are never fed
   from `req.actor.source`. Don't "fix" them and don't read them as new drift.
3. **Don't reach for the Cloud tenant path** (`resolveCloudTenantActor`) as a
   shortcut. It deletes `instance_admin` rows on every request. §4 Option A
   explains why it looks tempting and is wrong.

### What is still open, and is not code work

Unchanged since Session 2; re-applying does not address any of it:

1. Runbook check 2 — prove `:3100` is unreachable from off-host (§8 Session 4).
2. Admin bootstrap — §6 Q4; `/bootstrap/claim` rejects `proxy_header` actors.
3. The agent/CLI proxy-bypass rule at the proxy — Risk #2.
4. No end-to-end run through a real Traefik + forward-auth chain has ever been
   done. Note the dev container has no `docker`, `go`, or `psql`, so it cannot be
   done from there.

Operator-facing configuration lives in
[`doc/REVERSE-PROXY-AUTH.md`](doc/REVERSE-PROXY-AUTH.md), which ships with the
patch. Keep it truthful — Session 5 found it still asserting a claim Session 4
had already retracted.

---

## 1. The products involved

**Paperclip** — this repo. A Node/Express + React app that orchestrates AI agent
"employees". Auth today is [Better Auth](https://better-auth.com) with
email + password, backed by Postgres tables (`authUsers`, `authSessions`,
`authAccounts`, `authVerifications`). There is no OIDC / SSO / social login
today. Sessions are cookies with an instance-scoped prefix
(`paperclip-<instanceId>`).

**thomseddon/traefik-forward-auth** — a small Go service used as a Traefik
`forwardAuth` middleware. Traefik calls it for each request; if the user isn't
authenticated it 302s them to an OIDC provider, completes the code exchange, and
sets its own signed cookie (default name `_forward_auth`, value roughly
`expiry|hmac|email`). On subsequent requests it returns `200` plus an
`X-Forwarded-User: <email>` response header, which Traefik copies onto the
upstream request when the middleware is configured with
`authResponseHeaders = ["X-Forwarded-User"]`.

Two things worth flagging about this component up front:

- **It only ever gives us an email address.** No stable subject ID, no display
  name, no groups, no roles. Any identity model we build has to key on email.
- **It is quiet upstream.** The project has been stable but essentially
  unmaintained for a long time (v2.2.0 era), and various forks exist. That's an
  argument for keeping Paperclip's side generic — trust *a* proxy header /
  cookie, not *this specific product's* — so we can swap in oauth2-proxy,
  Authelia, Authentik, or Traefik's own OIDC middleware later without touching
  Paperclip again. **This is the single biggest design constraint below.**

**The OIDC provider** — whatever IdP you're pointing traefik-forward-auth at.
Paperclip never talks to it directly in any of the options below except Option D.

---

## 2. Problem statement

Paperclip is being deployed behind Traefik with traefik-forward-auth in front of
it. The proxy authenticates the human against an existing OIDC provider and
hands Paperclip an email address — via a request header, and/or via its own
signed cookie.

Paperclip has no way to consume that. It only knows how to authenticate a human
against its own email + password table. So today the user experience is a
**double login**: sign in at the IdP to get past the proxy, then sign in *again*
with a separate Paperclip password. Worse, the two identities aren't linked —
there's nothing stopping the proxy asserting `alice@corp` while the Paperclip
session says `bob@corp`.

**What we want:** the proxy is the single source of truth for *who the human is*.
Paperclip should accept that assertion, resolve it to a Paperclip user, and
establish a normal authenticated session — no second password, no second
identity.

**What we must not break:**

- Agents, the CLI, and webhooks authenticate with `Authorization: Bearer …`
  (agent API keys, agent JWTs, board API keys). These are not browsers and
  cannot follow an OIDC redirect.
- Local development, which runs in `local_trusted` mode with no auth at all.
- The security property that a header called `X-Forwarded-User` is worthless
  unless we can prove it came from our proxy.

---

## 3. What the code actually does today (investigation findings)

This section is the important one — it changes which options are realistic.

> **Line numbers refreshed 2026-08-08 (Session 4)** against the post-port
> `WORKINGv2` tree. They drifted by 30–70 lines during the master merges between
> Session 2 and Session 4; the structural claims below all still hold.

### 3.1 There is already a trusted-header authentication path

[`server/src/middleware/auth.ts:497`](server/src/middleware/auth.ts#L497) —
`resolveCloudTenantActor()`. Paperclip Cloud runs tenant instances behind a
control plane that authenticates the user and forwards identity as headers:

| Header | Purpose |
| --- | --- |
| `x-paperclip-cloud-tenant-token` | shared secret, compared with `timingSafeEqual` against `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` |
| `x-paperclip-cloud-user-id` | becomes `authUsers.id` |
| `x-paperclip-cloud-user-email` | becomes `authUsers.email` |
| `x-paperclip-cloud-stack-id` | synthesizes a company |
| `x-paperclip-cloud-stack-role` | `owner` / `admin` / `member` / `support` |

It upserts the user, upserts a company, upserts a membership, seeds default
permission grants, and returns a `board` actor with `source: "cloud_tenant"`.
**The whole block is inert unless `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` is set**
([`auth.ts:498-499`](server/src/middleware/auth.ts#L498-L499)).

This is exactly the shape we need. It proves the architecture already supports
"an upstream component asserts identity" — we are not fighting the grain.

### 3.2 The insertion point is a single well-defined spot

[`server/src/middleware/auth.ts:170`](server/src/middleware/auth.ts#L170) —
`actorMiddleware()` resolves `req.actor` for every request, in this order
(**b** is ours, added in Session 2):

1. Default actor: in `local_trusted` mode, an implicit admin board user; otherwise `{ type: "none" }` ([:173-183](server/src/middleware/auth.ts#L173-L183))
2. **If no `Authorization: Bearer` header** and mode is `authenticated`:
   a. `resolveCloudTenantActor()` — Cloud trusted headers ([:190](server/src/middleware/auth.ts#L190))
   b. `resolveProxyHeaderActor()` — forward-auth header ([:200](server/src/middleware/auth.ts#L200))
   c. Better Auth session cookie ([:212](server/src/middleware/auth.ts#L212))
3. Otherwise, bearer token paths: board API key → agent API key → agent JWT

Note the ordering: **bearer tokens are checked first**, so adding a proxy-header
path cannot break agent or CLI authentication at the server level.

### 3.3 The UI session gate reads `req.actor`, not Better Auth directly

This is the finding that makes a server-side-only change viable.

[`server/src/routes/auth.ts:40`](server/src/routes/auth.ts#L40) — Paperclip
defines its **own** `GET /api/auth/get-session` that returns a session derived
from `req.actor`, and it is mounted at
[`app.ts:319`](server/src/app.ts#L319) *before* the Better Auth catch-all handler
at [`app.ts:320-321`](server/src/app.ts#L320-L321). The synthetic session ID is
literally `paperclip:${req.actor.source}:${req.actor.userId}`.

The React UI gates on exactly that endpoint
([`ui/src/api/auth.ts:150`](ui/src/api/auth.ts#L150), consumed across ~15 pages).

**Consequence: any new actor source added to `actorMiddleware` is automatically
visible to the UI as a logged-in session. No UI changes, no Better Auth plugin,
no new session table rows.** This is a much smaller change than it first looked.

### 3.4 Proxy-awareness infrastructure already exists

[`server/src/middleware/trust-proxy.ts`](server/src/middleware/trust-proxy.ts) —
a `TRUST_PROXY` env var mirroring Express's `trust proxy`, deliberately unset by
default so `req.ip` can't be spoofed. Applied at
[`app.ts:286`](server/src/app.ts#L286). We get real client/proxy IPs for free by
setting it, which is what an IP allowlist check would depend on.

### 3.5 Config knobs that will matter

All in [`server/src/config.ts`](server/src/config.ts):

- `PAPERCLIP_DEPLOYMENT_MODE` — `local_trusted` (default) vs `authenticated`. **The trusted-header and session paths only run in `authenticated`** ([`auth.ts:189`](server/src/middleware/auth.ts#L189)).
- `PAPERCLIP_DEPLOYMENT_EXPOSURE` — `private` / public.
- `PAPERCLIP_ALLOWED_HOSTNAMES` — feeds a hostname guard and Better Auth trusted origins ([`better-auth.ts:120`](server/src/auth/better-auth.ts#L120)). Must include the external hostname or requests through Traefik get rejected.
- `PAPERCLIP_PUBLIC_URL` / `PAPERCLIP_AUTH_BASE_URL_MODE` + `PAPERCLIP_AUTH_PUBLIC_BASE_URL` — drive secure-cookie behaviour ([`better-auth.ts:86-90`](server/src/auth/better-auth.ts#L86-L90), resolved into the instance at [`better-auth.ts:149`](server/src/auth/better-auth.ts#L149)). Behind TLS-terminating Traefik these need to reflect the *external* HTTPS URL, not `localhost:3100`.
- `authDisableSignUp` — worth turning on once the proxy owns identity.

---

## 4. Options

### Option 0 — No code changes, double login

Put traefik-forward-auth in front, keep Paperclip's own password login.

- **Effort:** none in this repo.
- **Gets us:** a perimeter — unauthenticated strangers never reach Paperclip.
- **Doesn't get us:** SSO. Two sets of credentials. Identities not linked.
- **Verdict:** fine as a stop-gap for week one; not the goal.

### Option A — Reuse the Cloud tenant headers as-is (no code changes)

Set `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` and have Traefik inject the five
`x-paperclip-cloud-*` headers.

- **Effort:** config only, zero code.
- **Blockers:**
  - traefik-forward-auth emits only `X-Forwarded-User`. Stock Traefik has no
    header *rename/copy* middleware, so getting that email into
    `x-paperclip-cloud-user-email` **and** `x-paperclip-cloud-user-id` needs a
    Traefik plugin or a tiny shim service.
  - It drags in cloud semantics we don't want: it synthesizes a company from
    `stack-id` ([`auth.ts:476-488`](server/src/middleware/auth.ts#L476-L488)) and
    **actively deletes `instance_admin` rows for that user on every single
    request** ([`auth.ts:472-474`](server/src/middleware/auth.ts#L472-L474)).
    On a self-hosted box that will fight you constantly — your admin silently
    stops being an admin.
- **Verdict:** excellent for a 30-minute proof that the plumbing works. Wrong to
  live on. Documented here mainly so nobody rediscovers it and thinks it's a
  shortcut.

### Option B — Add a generic trusted proxy-header auth source ✅ recommended

A new, self-hosted-appropriate sibling of `resolveCloudTenantActor`. Sketch:

```
server/src/auth/proxy-header-auth.ts   (new, ~120 lines)
  resolveProxyHeaderActor(db, req) -> actor | null
    - returns null unless PAPERCLIP_PROXY_AUTH_ENABLED=true          (default off)
    - verifies the request came from the proxy:
        * shared secret header vs PAPERCLIP_PROXY_AUTH_SHARED_SECRET (timingSafeEqual)
        * and/or req.ip ∈ PAPERCLIP_PROXY_AUTH_TRUSTED_IPS           (needs TRUST_PROXY)
    - reads the email from PAPERCLIP_PROXY_AUTH_USER_HEADER          (default x-forwarded-user)
    - normalizes + validates it; optional PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS allowlist
    - looks up authUsers by email
        * found      -> use it
        * not found  -> JIT-provision if PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true, else null
    - loads instance role + memberships exactly like the session path
      (reuse loadActiveUserCompanyMemberships, auth.ts:86)
    - returns { type: "board", …, source: "proxy_header" }

server/src/middleware/auth.ts          (~6 lines)
  call it immediately after resolveCloudTenantActor (auth.ts:183)

server/src/config.ts                   (config surface + validation)
doc/REVERSE-PROXY-AUTH.md              (new runbook)
+ tests mirroring the existing cloud-tenant tests
```

- **Effort:** small and contained. One new file, a handful of lines in existing
  files, plus tests and docs.
- **Why it's the right shape:**
  - Reuses a pattern the codebase already has, in the place it already has it.
  - **No UI changes at all** — see §3.3.
  - No coupling to traefik-forward-auth specifically. `X-Forwarded-User` is
    emitted by oauth2-proxy and Authelia too, so this survives swapping the
    proxy out (which §1 says we should expect).
  - Off by default; existing deployments and local dev are untouched.
  - Plausibly upstreamable to `paperclipai/paperclip` as a self-hosting feature,
    which would get us off carrying a fork patch.
- **Risks:** header spoofing if Paperclip is reachable without going through
  Traefik. Mitigations in §5.

### Option C — Verify the traefik-forward-auth cookie directly

Paperclip reads the `_forward_auth` cookie and validates its HMAC using a secret
shared with the proxy.

- **Effort:** similar size to B, more crypto code we own.
- **Pro:** doesn't depend on header hygiene; a stripped or spoofed header can't
  forge a valid MAC.
- **Con:** couples us to that project's *undocumented, unversioned* cookie
  format. Given §1 (quiet upstream, likely to be swapped), this is coupling in
  precisely the direction we don't want.
- **Verdict:** not as the primary mechanism. Worth revisiting only as
  defence-in-depth layered on B if we conclude header hygiene can't be
  guaranteed.

### Option D — Native OIDC in Paperclip (drop forward-auth)

Add a real OIDC provider through Better Auth's generic OAuth / SSO support and
let Paperclip talk to the IdP itself.

- **Effort:** largest. New provider config, account-linking semantics, UI login
  changes, migration for existing password users.
- **Pro:** the "correct" long-term answer; no proxy in the identity path;
  clean logout; groups/claims available for role mapping.
- **Con:** doesn't give the perimeter protection a forward-auth proxy does, and
  it's a much bigger review surface for a fork to carry.
- **Verdict:** the right eventual destination, not the right first move.

### Recommendation

**Option B**, with **Option 0 as the interim** while B is written and reviewed.
Keep **Option C** in the back pocket. Treat **Option D** as the longer-term
direction, and deliberately design B's config so D can land later without a
breaking change to how operators configure things.

---

## 5. Risks and things that will bite us

Ranked roughly by how much damage they do.

1. **Header spoofing = total auth bypass.** If anything can reach the Node
   process without transiting Traefik, `X-Forwarded-User: admin@corp` is a
   full login as that admin. Non-negotiable mitigations: bind Paperclip to
   loopback or an internal Docker network only; require the shared-secret
   header *in addition to* the identity header; set `TRUST_PROXY` and check
   `req.ip` against an allowlist; make sure Traefik **strips** any inbound
   `X-Forwarded-User` from the client before forward-auth runs.
2. **Agents, CLI, and webhooks will be locked out.** They send
   `Authorization: Bearer …` and cannot do an OIDC redirect dance. Server-side
   they're fine (bearer is checked first, §3.2) — the problem is purely that
   forward-auth will 302 them at the proxy. Deployment needs either a Traefik
   rule bypassing forward-auth when an `Authorization` header is present, or a
   separate router/hostname for API traffic that skips the middleware. **Decide
   this before rollout, not after.**
3. **`deploymentMode` must be `authenticated`.** In `local_trusted` every
   request is already an implicit admin ([`auth.ts:167-176`](server/src/middleware/auth.ts#L167-L176))
   and none of the identity paths run.
4. **Who becomes `instance_admin`?** JIT-provisioned proxy users get no instance
   role. Either pre-create the admin, or wire the first proxy user through
   `claimFirstInstanceAdmin` ([`server/src/first-admin-claim.ts`](server/src/first-admin-claim.ts)),
   or add an env-based admin-email allowlist. Needs an explicit decision.
5. **Logout is a lie.** Signing out inside Paperclip clears nothing at the
   proxy; the next request silently re-authenticates. At minimum the UI's
   sign-out should be aware of this; ideally it redirects to the proxy's logout
   URL.
6. **Cookie / origin config behind TLS termination.** `PAPERCLIP_PUBLIC_URL`,
   `PAPERCLIP_AUTH_*`, and `PAPERCLIP_ALLOWED_HOSTNAMES` must all reflect the
   external HTTPS hostname or you'll get insecure cookies, rejected origins, or
   a hostname-guard 4xx. See §3.5.
7. **Email as a primary key.** Email changes at the IdP orphan the Paperclip
   user. Acceptable, but should be a documented limitation with a documented
   manual fix.
8. **Fork maintenance.** Every change here is a patch we carry against
   `paperclipai/paperclip` until (unless) it's upstreamed. Keeping the diff
   small and generic — the core argument for B over A — is what keeps rebases
   cheap.

---

## 6. Open questions for review

1. Is Paperclip reachable *only* through Traefik in the target deployment, or is
   port 3100 exposed anywhere else? (Determines how hard risk #1 is.)
2. How do agents/CLI reach the server — same hostname as the UI, or a separate
   one? (Determines the shape of the fix for risk #2.)
3. Auto-provision unknown emails, or require an admin to pre-create users?
4. Who should be `instance_admin`, and how do they get it?
5. Do we intend to upstream this to `paperclipai/paperclip`, or carry it as a
   fork patch indefinitely?
6. Is there a groups/roles claim available from the IdP we'd eventually want to
   map to Paperclip memberships? (Doesn't change B, but changes D.)

---

## 7. How to re-run this investigation

Exact commands used, so the findings can be re-derived after a rebase:

```bash
cd /home/octobot/Paperclip

# Auth entry points
grep -rn "better-auth\|betterAuth" --include=*.ts server/src | grep -v __tests__
find server/src -iname "*auth*" -not -path "*__tests__*"

# Existing trusted-header / proxy handling  <-- the key hits
grep -rni "x-forwarded-user\|forward-auth\|oidc\|\bsso\b\|openid" \
  --include=*.ts --include=*.tsx --include=*.md server/src ui/src doc README.md
grep -rn "trust proxy\|trustProxy\|x-forwarded-for" --include=*.ts server/src

# Deployment/auth config surface
grep -n "deploymentMode\|deploymentExposure\|allowedHostnames\|authBaseUrlMode" server/src/config.ts

# How the UI decides it is logged in
grep -rn "getSession" --include=*.tsx --include=*.ts ui/src | grep -v ".test."
```

Then read, in this order:
[`server/src/middleware/auth.ts`](server/src/middleware/auth.ts) →
[`server/src/auth/better-auth.ts`](server/src/auth/better-auth.ts) →
[`server/src/routes/auth.ts`](server/src/routes/auth.ts) →
[`server/src/app.ts:284-320`](server/src/app.ts#L284-L320).

---

## 8. Running Log

Append-only. Newest entries at the bottom.

### 2026-08-01 — Session 1: investigation and options write-up

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** Define the problem, survey the code, propose options. No code changes.

**Actions taken**

- Explained `SERVE_UI` and `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` from `.env`
  (separate conversation thread; no files touched).
- Read-only investigation of the auth stack — commands recorded in §7.
- Created this file.

**Files changed:** `reverse proxy changes.md` (new). **No source code modified.**
*(Amended 2026-08-01, Session 3: this file was renamed to
`ReverseProxyCustomChanges.md`.)*

**Key findings**

1. A trusted-header auth path already exists for Paperclip Cloud —
   `resolveCloudTenantActor`, [`auth.ts:429`](server/src/middleware/auth.ts#L429) —
   inert unless `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` is set. The architecture
   supports what we want.
2. `GET /api/auth/get-session` is **Paperclip's own route** reading `req.actor`
   ([`routes/auth.ts:40`](server/src/routes/auth.ts#L40)), mounted before the
   Better Auth handler. So a new actor source needs **zero UI changes**. This is
   the finding that makes the change small.
3. Bearer-token auth is evaluated *before* the header/session paths
   ([`auth.ts:180-181`](server/src/middleware/auth.ts#L180-L181)) — agent and CLI
   auth can't be broken server-side by this work.
4. `TRUST_PROXY` infrastructure already exists
   ([`middleware/trust-proxy.ts`](server/src/middleware/trust-proxy.ts)),
   safely unset by default.
5. No OIDC/SSO anywhere in the product today. The OIDC hits in the codebase are
   unrelated (npm trusted publishing, MCP tool OAuth, the `paperclip-id`
   product plan).

**Outcome:** Options 0/A/B/C/D drafted. Recommending **B** (generic trusted
proxy-header actor), with 0 as interim. Awaiting review.

**Next step:** answers to §6, then a detailed implementation plan for B before
any code is written.

---

### 2026-08-01 — Session 2: implemented Option B (minimal form)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** Turn on `X-Forwarded-User` trust, cross-referencing the asserted email
against existing Paperclip users.

**Decision that scoped this session.** Port 3100 will not be externally
reachable and all traffic must transit the reverse proxy. On that basis we
**trust the header outright** — no shared-secret header, no proxy IP allowlist.
Those were mitigations for an exposure that won't exist. The network *is* the
trust boundary, and that assumption is now written into the code's header
comment, the operator doc, and the verification steps, so it gets re-checked if
the deployment shape ever changes.

**Implemented** (Option B from §4, minimal form)

New `server/src/auth/proxy-header-auth.ts`:
- `resolveProxyHeaderAuthConfig(env)` — off unless `PAPERCLIP_PROXY_AUTH_ENABLED=true`
- `extractProxyHeaderEmail(raw, config)` — normalize + validate, fails closed
- `resolveProxyHeaderUser(db, email, config)` — case-insensitive lookup on
  `authUsers.email`, optional JIT provisioning

Wired in at:
- `server/src/middleware/auth.ts` — new exported `resolveProxyHeaderActor`,
  called from `actorMiddleware` right after the Cloud tenant path
- `server/src/realtime/live-events-ws.ts` — same resolution on WS upgrade
- `server/src/types/express.d.ts` + 5 files carrying a duplicated copy of the
  actor `source` union — added `"proxy_header"`

**Config surface** (all default off/empty):
`PAPERCLIP_PROXY_AUTH_ENABLED`, `PAPERCLIP_PROXY_AUTH_USER_HEADER`
(default `x-forwarded-user`), `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION`,
`PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS`.

**Files changed**

| File | Change |
| --- | --- |
| `server/src/auth/proxy-header-auth.ts` | new — config, validation, user resolution |
| `server/src/auth/proxy-header-auth.test.ts` | new — 15 tests |
| `server/src/middleware/proxy-header-actor.test.ts` | new — 9 tests |
| `server/src/middleware/auth.ts` | + `resolveProxyHeaderActor`, called in `actorMiddleware` |
| `server/src/realtime/live-events-ws.ts` | proxy identity on WS upgrade |
| `server/src/types/express.d.ts` | `source` union + `proxy_header` |
| `server/src/services/authorization.ts` | same union |
| `server/src/services/secrets.ts`, `services/environment-config.ts`, `services/tool-access.ts`, `routes/authz.ts` | same union |
| `doc/REVERSE-PROXY-AUTH.md` | new — operator runbook |
| `.env.example` | commented config block |

**Findings during implementation**

1. **The WebSocket path needed the same treatment.** `authorizeUpgrade` in
   `live-events-ws.ts` only resolved Better Auth sessions. A proxy-authenticated
   user has no session cookie, so without this the UI would load but live events
   would never connect — a silent half-broken state. Fixed.
2. **An existing test caught a real regression.** Putting `await
   resolveProxyHeaderUserId(...)` ahead of the session lookup deferred the call
   to `resolveSessionFromHeaders` by a microtask, breaking
   `live-events-ws.test.ts`'s upgrade-socket-error cleanup case. Fixed properly
   — the header read is now synchronous, so with proxy auth disabled the code
   path is tick-for-tick identical to before. The test was not modified.
3. **The actor `source` union is duplicated in six places** rather than being
   one shared type. Worth a follow-up cleanup; not done here to keep the diff
   reviewable.
4. **Deliberately unlike the Cloud tenant path:** no company creation, no
   membership creation, no `instanceUserRoles` writes. The proxy asserts
   identity only; authorization stays entirely Paperclip's.
5. `proxy_header` falls through to `"session"` in the secrets authorization
   mapping (`services/secrets.ts`), which is the correct treatment — a
   proxy-authenticated browser is a session actor. It is *not* exempted from the
   board mutation origin guard, also correct, since these are real browser
   requests carrying Origin/Referer.

**Verification**

- `pnpm --filter @paperclipai/server typecheck` — clean
- 24 new tests pass; 44 pass across new + WS + cloud-tenant suites
- Auth regression sweep (`auth-routes`, `auth-session-route`,
  `agent-auth-middleware`, `authorization-service`, `cloud-tenant-actor`,
  `proxy-header-auth`) — 98 passed
- **Not yet done: no end-to-end test behind a real Traefik + forward-auth.**

**Outcome:** Feature complete and off by default. Enabling it takes
`PAPERCLIP_DEPLOYMENT_MODE=authenticated` + `PAPERCLIP_PROXY_AUTH_ENABLED=true`
plus the Traefik `authResponseHeaders` config in `doc/REVERSE-PROXY-AUTH.md`.

**Next step:** deploy behind the real proxy and run the three verification
checks in the runbook — especially check 2, that `curl` with a forged
`X-Forwarded-User` against `:3100` cannot connect from another host. Then decide
the admin bootstrap (§6 Q4) and the agent/CLI proxy-bypass rule (Risk #2), both
still open.

---

### 2026-08-01 — Session 3: file rename and naming convention

**Who:** Claude (Opus 5)
**Goal:** Housekeeping.

**Actions taken**

- Renamed `reverse proxy changes.md` → `ReverseProxyCustomChanges.md`. Plain
  `mv`; the file was untracked, so no `git mv` was needed and no history was
  affected.
- Amended the Session 1 "Files changed" line with a pointer to the new name,
  rather than rewriting it.

**Decision — file naming.** New files created for this work use PascalCase with
no spaces (e.g. `ReverseProxyCustomChanges.md`). Spaces in filenames need
quoting or escaping at a shell prompt and break naive `grep`/`find` pipelines;
that cost showed up immediately in Session 1, where every command touching this
file had to quote it.

**Scope note.** This applies to ad-hoc working files. Files added under `doc/`
keep that directory's existing SCREAMING-KEBAB convention
(`doc/REVERSE-PROXY-AUTH.md`, alongside `DOCKER.md`, `DEVELOPING.md`,
`MCP-RUNTIME-OPERATIONS.md`) — matching neighbours matters more there than a
global rule, and renaming it would make it the odd one out.

**Files changed:** this file (renamed + amended). **No source code modified.**

**Outcome:** Done. Open items from Sessions 1-2 are unchanged: admin bootstrap
(§6 Q4, and note `/bootstrap/claim` rejects `proxy_header` actors), the
agent/CLI proxy-bypass rule (Risk #2), and end-to-end verification behind the
real proxy.

---

### 2026-08-08 — Session 4: forward-port onto current master (`WORKINGv2`)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** Re-apply the Session 2 work on top of the current master merge, which
had moved on 73 commits since the feature branch was cut.

**Situation.** The Session 2 work is commit `5271653c7`, living on branches
`DEVLOPMENT` / `WORKINGON` (and checked out at `/install/paperclip-run`, which is
what the running server is serving). `WORKINGv2` is a fresh master merge that
does **not** contain it: 73 commits ahead, 3 behind.

**Method.** `git cherry-pick -n 5271653c7` rather than a hand re-application, so
that any upstream drift surfaced as a real conflict instead of being silently
missed. Twelve of the thirteen source files merged cleanly; only
`server/src/middleware/auth.ts` conflicted.

**The one real conflict — and it was a genuine incompatibility, not a textual one.**
Master extracted `isCloudManagedInstance()` out of `middleware/auth.ts` into
`services/cloud-instance.js`, and `auth.ts` now re-exports it
([`auth.ts:24`](server/src/middleware/auth.ts#L24)). Our commit still carried the
old inline definition, sitting immediately above the insertion point for
`resolveProxyHeaderActor`. Taking "theirs" wholesale would have produced a
duplicate export and a compile error. Resolution: keep `resolveProxyHeaderActor`,
drop our copy of `isCloudManagedInstance` and defer to master's re-export.

**Findings**

1. **The five union-type sites all still existed and merged cleanly.** Master had
   not added new copies of the actor `source` union, so the `"proxy_header"`
   additions applied unchanged. The duplication noted in Session 2 finding #3 is
   still there and still worth a cleanup.
2. **The call site survived the merge intact** and is still correctly ordered:
   bearer → cloud tenant → **proxy header** → Better Auth session
   ([`auth.ts:200`](server/src/middleware/auth.ts#L200)). Agent/CLI bearer auth
   remains unreachable by this path.
3. **The WebSocket path merged cleanly too**, including the synchronous
   header-read property that Session 2 finding #2 was careful to establish.
4. **The board mutation guard still does not exempt `proxy_header`**
   ([`board-mutation-guard.ts:62-69`](server/src/middleware/board-mutation-guard.ts#L62-L69)),
   which remains correct — proxy-authenticated requests are real browser requests
   and carry Origin/Referer. Worth restating because it makes
   `PAPERCLIP_PUBLIC_URL` load-bearing: if it does not match the external origin,
   every board mutation returns `403 Board mutation requires trusted browser origin`
   while reads keep working. That is the failure mode to expect if the UI loads
   but nothing can be saved.
5. **One test needed a real fix, and it is a deployment-shaped bug, not merge
   fallout.** `proxy-header-actor.test.ts`'s "returns null when proxy auth is not
   enabled" case asserted the disabled path while reading the *ambient*
   environment. On any host actually configured for forward auth — this one
   exports `PAPERCLIP_PROXY_AUTH_ENABLED=true` — the variable leaked into the test
   and it failed. Fixed by stubbing the variable to `"false"` explicitly. The
   suite is now hermetic and passes both with and without the var set. This would
   have failed in Session 2 too had the tests been run on the deployment host.

**Files changed:** the thirteen files from `5271653c7` (unchanged except
`middleware/auth.ts`, resolved as above), plus `proxy-header-actor.test.ts`
(hermetic env stub) and this file (§3 line refs refreshed, this entry).

**Verification**

- `pnpm --filter @paperclipai/server typecheck` — clean
- `proxy-header-auth` + `proxy-header-actor` — 24/24 pass
- Auth regression sweep (`cloud-tenant-actor`, `board-mutation-guard`,
  `auth-session-route`, `authorization-service`, `error-handler`) — 100/100 pass
- **Still not done: no end-to-end run behind the real Traefik + forward-auth.**
  Session 2's next step is still Session 4's next step.

**Outcome:** The feature is back on current master, type-clean and test-clean,
still off by default. `/install/projects/paperclip` now has its own
`node_modules` (it had none — that is why the first typecheck attempt failed).

**Next step:** point the running server at this tree and run the three runbook
checks in `doc/REVERSE-PROXY-AUTH.md` §Verifying — especially check 2, that a
forged `X-Forwarded-User` against `:3100` from another host cannot connect. Then
the two items still open since Session 1: admin bootstrap (§6 Q4; note
`/bootstrap/claim` rejects `proxy_header` actors) and the agent/CLI proxy-bypass
rule (Risk #2).

---

### 2026-08-12 — Session 5: re-apply onto `W2-20260812b`

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** Re-apply the feature in `/install/Projects/paperclip`, a fresh checkout
of `W2-20260812b` that contains none of this work, and re-verify it.

**Situation.** This tree is 54 commits ahead of the merge base with the Session 4
commit `265dea18a`, which is still reachable here (branches `W20260811a`,
`origin/W20260810b`, `origin/W20260811a`, `origin/WORKINGv2`). So this was a
re-apply of an existing commit, not a re-implementation from the doc. The
untracked `ReverseProxyCustomChanges.md` in the working tree was byte-identical
to the version at `c691ed59b` (the feature branch tip), so nothing was lost by
letting the cherry-pick restore it.

**Method.** `git cherry-pick -n 265dea18a`, same reasoning as Session 4 — let
upstream drift surface as a conflict rather than be missed. Only three of the
touched files had drifted at all (`middleware/auth.ts`, `live-events-ws.ts`,
`services/authorization.ts`).

**The one conflict — `live-events-ws.ts`, and the conflicting file swapped.**
Session 4's conflict was in `middleware/auth.ts`; this time that file merged
cleanly and the WebSocket path conflicted instead. Master added a
`resolveCloudActor` branch to `authorizeUpgrade` for Cloud-managed deployments,
sitting immediately above the `deploymentMode` guard that our commit edits (it
drops `|| !opts.resolveSessionFromHeaders` from that guard, because a
proxy-authenticated browser has no session to resolve). Textual overlap, not a
semantic clash. Resolved by keeping both: cloud actor → mode guard → proxy
header → session, which matches `actorMiddleware`'s precedence.

**Findings**

1. **A second ambient-environment test bug, same class as Session 4 finding #5.**
   Session 4 stubbed `PAPERCLIP_PROXY_AUTH_ENABLED` in the one test that needed
   it. This host also exports `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true`, which
   leaked into "denies an unknown email when auto-provisioning is off" — the
   fake db provisioned a user and the assertion failed. Fixed more broadly than
   last time: a `beforeEach` now pins all four `PAPERCLIP_PROXY_AUTH_*`
   variables to their defaults, so every test opts in to what it needs and no
   host env can change what an assertion means. Verified passing both with the
   variables set and with them unset.
2. **`doc/REVERSE-PROXY-AUTH.md` still carried the claim Session 4 retracted.**
   Two places said `PAPERCLIP_PUBLIC_URL` **must** be the external URL or every
   board mutation 403s. Session 4 finding #4 established that this is wrong —
   `trustedOriginsForRequest` reads `X-Forwarded-Host`/`Host` first and only
   falls back to `PAPERCLIP_PUBLIC_URL` — but only the running log was
   corrected, not the operator runbook. Both passages now match the code.
3. **The `source` union duplication is unchanged, and two sites still lack
   `proxy_header`** — [`routes/authz.ts:213`](server/src/routes/authz.ts#L213)
   and [`services/tool-access.ts:4798`](server/src/services/tool-access.ts#L4798).
   Both predate this feature and both are narrower unions that are never fed
   from `req.actor.source` directly, so typecheck is clean. Noted so the next
   session doesn't mistake them for new drift.
4. **The six wired-up union sites and the call-site ordering all survived**
   unchanged: bearer → cloud tenant → proxy header → session
   ([`auth.ts:227`](server/src/middleware/auth.ts#L227)). Note master now also
   gates that whole block on `opts.resolveSession` being provided
   ([`auth.ts:216`](server/src/middleware/auth.ts#L216)); `app.ts` always
   provides it, so the proxy path is unaffected.

**Files changed:** the fourteen files from `265dea18a`, plus the `beforeEach`
stub in `proxy-header-actor.test.ts`, the two corrections in
`doc/REVERSE-PROXY-AUTH.md`, and this entry. **Not committed** — left staged in
the working tree for review.

**Document change — new §0.** Added a "Start here" section at the top carrying
the prompt to use next time, the cherry-pick method and the commit to pick, the
table of where it has conflicted so far, the verification commands with their
expected counts, and the repeat-offender traps. Numbered **0** specifically so
every existing cross-reference in this file (§3.3, §3.5, §4 Option B, §6 Q4)
stays valid. The stale header block was also refreshed — it still read
"Investigation complete, no code changed yet" and named branch `DEVLOPMENT`,
three sessions after the code was written. The intent is that pointing an agent
at this one file is now sufficient to re-apply the work unaided.

**Verification**

- `pnpm install --frozen-lockfile` — this tree had no `node_modules` (same as
  Session 4's tree did not)
- `pnpm --filter @paperclipai/server typecheck` — clean
- `proxy-header-auth` + `proxy-header-actor` — 24/24, and 24/24 again with the
  ambient `PAPERCLIP_PROXY_AUTH_*` variables unset
- Auth regression sweep (`live-events-ws`, `cloud-tenant-actor`,
  `board-mutation-guard`, `error-handler`, `auth-session-route`,
  `authorization-service`) — 110/110
- Further auth suites (`auth-routes`, `agent-auth-middleware`, `agent-auth-jwt`,
  `better-auth`, `cli-auth-routes`, `express5-auth-wildcard`,
  `authz-secret-context`) — 62/62

**Outcome:** Feature re-applied, type-clean, 196 tests passing, still off by
default. `/install/Projects/traefik-forward-auth` is checked out alongside at
`83f06df`, but no Go toolchain and no Docker are installed on this host, so the
end-to-end proxy chain still cannot be exercised here.

**Next step:** unchanged from Session 4, and none of them are code work —
(1) re-run runbook check 2 from an off-host machine, (2) the admin bootstrap
decision (§6 Q4; `/bootstrap/claim` still rejects `proxy_header` actors), and
(3) the agent/CLI proxy-bypass rule (Risk #2).

---

### <date> — Session N: <title>

**Who:**
**Goal:**
**Actions taken:**
**Files changed:**
**Findings / decisions:**
**Outcome:**
**Next step:**
