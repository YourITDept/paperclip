# Reverse Proxy / Forward-Auth Integration — Working Document

**Status:** Implemented and working; off by default. Carried as a fork patch and
re-applied to each new working branch — see §0.
**Owner:** cwa@youritdept.com
**Repo:** `YourITDept/paperclip` (fork of `paperclipai/paperclip`)
**Created:** 2026-08-01 · **Last re-applied:** 2026-08-12 (Session 5)
**Last synced:** 2026-08-27 (Session 7 — upstream merge, no re-apply needed; see
[`SYNC-2026-08-27.md`](CustomCodeDoc/SYNC-2026-08-27.md))
**Scope:** primarily the forward-auth add-on, plus any other change the fork must
re-apply after taking a fresh upstream branch — see §0.1.

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

> Re-apply the reverse-proxy / forward-auth add-on to this checkout, **and the
> other fork-carried changes listed in §0.1**. Follow
> `ReverseProxyCustomChanges.md` — start at §0, which tells you everything you
> need. When you're done, append a new dated session entry to the Running Log at
> the bottom of that file. Don't commit unless I ask.

Nothing else needs to be said. Everything below is what that prompt relies on.

**§0.1 is not optional.** The add-on is one cherry-pick; the changes in §0.1 are
separate small patches that the cherry-pick does **not** bring with it. They are
listed here because this file is the only place the fork records "things upstream
will quietly undo".

### What you are re-applying

A generic trusted-proxy-header auth source: a new actor `source` called
`proxy_header`, resolved from `X-Forwarded-User`, slotted into the existing
actor-resolution chain between the Cloud-tenant path and the Better Auth session
path. Fourteen files. **No UI changes** (see §3.3 for why). Off unless
`PAPERCLIP_PROXY_AUTH_ENABLED=true`. Full rationale in §4 Option B; the original
implementation notes are in §8 Session 2.

### 0.1 Also carried: fork changes outside the add-on

These are **not** part of commit `265dea18a` and a cherry-pick will not restore
them. Each is small, each sits in a file upstream actively edits, and each fails
*silently* if lost — no typecheck error, no crash, just wrong behaviour. Check
each one after every re-branch.

| # | Change | File | Detect it with |
| --- | --- | --- | --- |
| 1 | Invite auto-accept guarded on the invite having loaded | [`ui/src/pages/InviteLanding.tsx`](ui/src/pages/InviteLanding.tsx) | the named test in #1 below |

#### 1. Invite auto-accept must be guarded on `Boolean(invite)`

**The change.** `Boolean(invite) &&` is the **first term** of
`shouldAutoAcceptHumanInvite` in `ui/src/pages/InviteLanding.tsx`, with a comment
above it explaining why. Paired regression test in
`ui/src/pages/InviteLanding.test.tsx`:

> `shows no stale 'Invite not found' when a member opens the link with a warm session`

**Why it exists.** Every other term in that expression reads a field off `invite`,
and an absent `invite` answers each one the *permissive* way —
`undefined !== "bootstrap_ceo"` passes, `undefined === "agent"` is false so the
agent-form term passes, and both membership terms need an `invite.companyId` they
do not have. So the whole gate opens on an invite that has not arrived yet, the
effect fires acceptance against nothing, and the mutation's own first line —
`if (!invite) throw new Error("Invite not found")` — writes that string into
`error` state. `autoAcceptStarted` then latches, so it never retries. When the
invite finally lands and `isCurrentMember` flips true, the page renders the
correct "Already in this company" panel with a dead `Invite not found` painted
underneath it.

**Who hits it.** The most ordinary case there is: an existing member, already
signed in, opens an invite link. Session and health are warm in the SPA query
cache while the invite fetch is still in flight. It is not a rare race.

**Why it is listed here.** This expression is *exactly* what upstream keeps
rewriting — `#11417` (scope invite membership checks to the signed-in account),
`#11488` (key the company list by account) and `#11507` (retire the shared-cache
reasoning) all landed on this membership gate in the recent window. A refactor
that restructures the gate drops a one-term guard without any signal. **The test
is the only thing that catches it** — the guard's absence is type-clean.

**Verify:**

```bash
npx vitest run ui/src/pages/InviteLanding.test.tsx
```

18/18 expected. If only that one test fails, the guard has been lost — re-add
`Boolean(invite) &&` as the first term and it goes green.

**Upstream candidate, not a permanent fork patch.** Unlike the proxy add-on, this
is a plain bug fix in upstream code with no fork-specific reasoning in it. The
right end state is a PR to `paperclipai/paperclip`, after which this entry can be
deleted rather than carried forever. Until that happens it has to be re-applied
by hand.

**Status:** committed in **`80b451e09`** ("LOoking good need to test",
2026-08-24) and merged to `master` on 2026-08-27. It is an ancestor of
`W4-20260827a`, so a branch descending from that already has it and needs no
re-apply — check before re-adding it.

**Session 7 caution — the assertion string is copy-coupled.** Upstream `#12243`
("unify user-facing 'company' wording to 'organization'") renamed the panel
heading, and the regression test's expected literal went stale even though the
guard was fine. It now asserts `"Already in this organization"`. If this test
fails after a re-branch, **read the failure before re-adding the guard**: a
mismatch on the heading string is upstream copy drift, whereas a real lost guard
shows `acceptInvite` having been called and `Invite not found` in the output.

### Method — cherry-pick, do not hand-rewrite

> **First, check whether you need to re-apply at all.** Session 7 (2026-08-27)
> found `W4-20260827a` already carried the whole add-on: `ddcd436f5` — the Session 5
> successor to `265dea18a` — was already an ancestor, so cherry-picking would have
> re-applied work that was present. One command settles it:
>
> ```bash
> git merge-base --is-ancestor ddcd436f5 HEAD && echo "already carried — do NOT cherry-pick"
> ```
>
> If the fork is now merging upstream *into* a long-lived working branch rather than
> re-branching from upstream, this is the normal case and §0 is not the workflow you
> want — see [`SYNC-2026-08-27.md`](CustomCodeDoc/SYNC-2026-08-27.md).

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

### 2026-08-24 — Session 6: invite-onboarding bug fix (not a re-apply)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** Not a re-apply of the add-on. An onboarding debugging session on branch
`W3-CodexChanges-20260823a`, logged here because it produced a fork-carried change
that upstream will quietly undo — see the new §0.1.

**The reported symptom.** The invite landing page showed, all at once:

> Already in this company
> This account already belongs to Bring Your AI to Life.
> **Invite not found**

**Finding — the two messages are unrelated.** `Invite not found` was a *stale
client-side error*, set before the invite had loaded and still on screen when the
page later rendered the "Already in this company" panel. Confirmed by a repro test
that reproduced the screen verbatim, company name included, while asserting
`acceptInvite` was called **zero times**. The string never came from the server.
No invite was consumed and no membership was touched — which also answers the
session's other question: nothing had been reused.

**Root cause.** `shouldAutoAcceptHumanInvite` in `ui/src/pages/InviteLanding.tsx`
had no term requiring the invite to exist, and every term it did have reads a
field off `invite`. An absent `invite` answers all of them permissively, so the
gate opened mid-fetch and the mutation's own `!invite` guard supplied the error
text. Full mechanism in §0.1 #1.

**Fix.** `Boolean(invite) &&` as the first term of that expression, with a comment
recording why the ordering matters. One line.

**Method note — test first, and verified as a real guard.** The repro was written
before the fix and reproduced the exact rendered string. After fixing, the guard
was temporarily removed again to confirm the test fails without it. It does. A
test that has never been seen to fail is not evidence.

**Findings**

1. **`InviteLanding.tsx` is upstream-hot.** `#11417`, `#11488` and `#11507` all
   landed on this same membership gate recently. A one-term guard is exactly what
   a refactor drops without noticing, and its absence is type-clean — hence §0.1.
2. **The invite reuse path is sound.** `POST /api/invites/:token/accept`
   ([`server/src/routes/access.ts:3636`](server/src/routes/access.ts#L3636)) 404s a
   consumed invite for everyone except the same human invitee repairing their own
   membership (matched on `requestingUserId`, falling back to a lowercased email
   snapshot) or an `openclaw_gateway` agent refreshing defaults. `bootstrap_ceo` is
   hard single-use with a race-safe conditional consume on `isNull(acceptedAt)`.
   Tokens are 256-bit and stored only as a sha256 hash. Nothing to fix here.
3. **There is no `invite.accepted` activity event.** Logged invite actions are
   `invite.created`, `invite.revoked`, `invite.openclaw_prompt_created`. Acceptance
   is only inferable from `invites.acceptedAt` plus the linked `join.approved`
   entry (which does carry `details.inviteId` and
   `details.source: "human_invite_accept"`). For a human invite that chain holds;
   an agent invite left pending approval leaves no activity trace of acceptance at
   all.
4. **`Invite not found` is overloaded across ~14 call sites** — never existed,
   already consumed, and expired/revoked all return the same string. Correct for
   enumeration resistance on a public endpoint, genuinely confusing for support.
   The client can disambiguate without weakening the server: `GET /api/invites/:token`
   still resolves an accepted invite that has a linked join request and returns
   `joinRequestStatus`.
5. **The mutation's `!invite` guard is now unreachable** — both callers run with
   `invite` present. Left in place as a safety net, but it should become a
   non-user-facing assertion so it cannot resurface as UI text.

**Files changed:** `ui/src/pages/InviteLanding.tsx` (one guard + comment),
`ui/src/pages/InviteLanding.test.tsx` (regression test), this file (§0.1, the
widened §0 prompt, the header scope line, this entry), and a session working doc
`CustomCodeDoc/Reviewing onboarding process and error messages.md`.
**Not committed** — left in the working tree for review.

**Verification**

- `npx vitest run ui/src/pages/InviteLanding.test.tsx` — 18/18
- `InviteLanding` + `InviteUxLab` together — 19/19
- Guard removed to re-confirm the test fails — 1 failed / 17 passed, as expected
- `npx tsc --noEmit -p ui/tsconfig.json` — clean

**Outcome:** Symptom fixed at the cause, covered by a test proven to fail without
the fix, and registered in §0.1 so a future re-branch does not silently lose it.

**Next step:** (1) commit it and record the SHA in §0.1 #1, which currently has
none; (2) open the upstream PR so this stops being a carried patch; (3) the four
onboarding follow-ups — consumed-vs-unknown invite copy, an `invite.accepted`
activity event, demoting the dead `!invite` guard, and auditing
`requiresHumanAccount` / `showsAgentForm` for the same permissive-when-undefined
shape — are tracked in the session working doc, not here.

---

### 2026-08-27 — Session 7: upstream sync (no re-apply needed)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** Bring `W4-20260827a` current with upstream, confirm every fork-carried
change survived, and sync the fork's `master`, which was stranded at 2026-08-08.

**The headline finding: this was not a re-apply.** §0 is written for "take a fresh
upstream branch, cherry-pick the add-on back on." That is not what this checkout
needed. `W4-20260827a` already carried all four documented change sets in its own
history — `ddcd436f5` (this add-on, Session 5), `35a3a08d6`/`364ab4976`/`c894eb944`
(Codex home), `d86144594` and neighbours (Codex vault), and `80b451e09` (the §0.1
guard). Running `git cherry-pick -n 265dea18a` would have re-applied work already
present. §0 now opens with a one-command check for this.

The actual gap was the other direction: the branch was **89 commits behind**
upstream and `master` was **406 behind**. There was no `upstream` remote at all;
one was added.

**Actions taken:** Tagged `pre-sync-backup-W4-20260827a`; merged `upstream/master`
(89 commits); resolved 2 conflicts; fixed one stale assertion; merged
`W4-20260827a` into `master`.

**The two conflicts — both adjacency, neither semantic.** `server/src/app.ts`
(our `codexVaultRoutes` import against upstream's new `instanceSettingsService`
import) and `packages/adapters/codex-local/src/server/execute.ts` (our
`PAPERCLIP_CODEX_HOME` resolution sitting directly above the `codexSkillEntries`
assignment upstream rewrote to filter missing-source entries). Both sides kept in
both files.

Note the §0 table's pattern holds again: **the conflicting file moved.** Sessions 4
and 5 conflicted in `middleware/auth.ts` and `realtime/live-events-ws.ts`
respectively; this time both auto-merged and the conflicts landed somewhere new.
Don't pattern-match on last time.

**Files changed:** `server/src/app.ts`, `packages/adapters/codex-local/src/server/execute.ts`
(conflict resolutions); `ui/src/pages/InviteLanding.test.tsx` (stale copy
assertion); this file (§0 caveat, §0.1 #1 status + caution, header, this entry);
new `CustomCodeDoc/SYNC-2026-08-27.md`.

**Findings / decisions**

1. **§0.1 did its job.** The only failing test in the entire repository after the
   merge was the §0.1 canary — and the guard was intact. Upstream `#12243` renamed
   the panel heading from "company" to "organization", so only the expected literal
   was stale. The substantive assertions (no `Invite not found`, `acceptInvite`
   never called) both still passed. The canary was then re-proved the Session 6
   way: guard removed → 1 failed / 17 passed; restored → 18/18.
2. **Trap #1 is still live on this box** and still matters — all three
   `PAPERCLIP_PROXY_AUTH_*` vars are exported here. Feature suites were run both as
   the box has them and with all three stripped; 24/24 identically. The `beforeEach`
   pinning is earning its keep.
3. **The actor precedence order is unmodified** by 89 upstream commits:
   bearer → cloud tenant → proxy header → Better Auth session
   (`middleware/auth.ts:237/240/250/259`). `auth.ts` auto-merged cleanly this time.
4. **New environment dependency: Rust.** Upstream put a `cargo build --release
   --locked` of `packages/paperclip-runner` in front of the server `typecheck`
   script. The toolchain is pinned to 1.97.1 in `rust-toolchain.toml`, which is a
   *rustup* feature — `brew install rust` is the wrong tool. Details and the
   keg-only `PATH` line in `SYNC-2026-08-27.md` §5.
5. **A vitest invocation gotcha:** running `server-utils.test.ts` via
   `pnpm --filter … exec vitest` fails at *startup* on project resolution. Run it
   from the repo root, as the Codex doc already says. Not a test failure.

**Verification** (post-merge, full battery in `SYNC-2026-08-27.md` §6)

- `proxy-header-auth` + `proxy-header-actor` — 24/24, both with and without the host env vars
- auth regression sweep — 113/113 (baseline 110; upstream added 3)
- extra auth suites — 72/72 (baseline 62)
- `InviteLanding` — 18/18 after the copy fix; re-proved as a real guard
- server typecheck (full, incl. the Rust runner build) and UI typecheck — both clean

**Outcome:** `W4-20260827a` and `master` are both 0 commits behind upstream and
carry identical trees. Nothing pushed in this session; the backup tag is still in
place.

**Next step:** (1) push both branches; (2) the upstream PR for §0.1 #1 is still
unopened — it is now a committed, merged, SHA'd patch, which makes it easy to send
and would let §0.1 be deleted; (3) still no end-to-end run through a real Traefik +
forward-auth chain — unchanged since Session 2.

---

### 2026-08-27 — Session 8: remove a Codex authorization (feature, not a re-apply)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** The Codex logins page could create and re-sign-in a vault but never undo
either. Add a button to remove an authorization. Branch `W4-20260827b`.

**What was built.** Two actions, because they are genuinely different and the
difference is what a bound agent experiences:

- **Sign out** — removes `auth.json`, keeps the directory, `config.toml`, and the
  path. Reversible; an agent pointed at that `CODEX_HOME` keeps resolving. This
  is the one most operators want, and the one that cannot lose a hand-tuned
  provider config.
- **Delete** — removes the directory outright. Irreversible; a bound agent stops
  resolving entirely. Destructive styling, and the dialog says so.

Full design, safety properties, and the file/test tables are in
[`Codex device login web service.md` §11](CustomCodeDoc/Codex%20device%20login%20web%20service.md).

**Files changed:** `codex-vault.ts` (+`removeVaultCredential`, +`deleteVault`),
`codex-local/src/server/index.ts` (barrel), `codex-vault-login-service.ts`
(+`removeCredential`, `remove`, `agentsUsing`, `listWithUsage`),
`routes/codex-vaults.ts` (two `DELETE` routes), `ui/api/codexVaults.ts`,
`ui/pages/InstanceCodexVaults.tsx`, plus the two test files and that doc.

**Findings / decisions**

1. **Nothing knew which agents used a vault.** An agent binds by putting an opaque
   path in `env.CODEX_HOME`, so the vault itself cannot tell. The listing now
   joins vault directories against `agents.adapter_config -> 'env' ->> 'CODEX_HOME'`
   and returns `boundAgentCount`, which the delete dialog names. This half-retires
   the "No agent-reference registry" scoping note in §10 of that doc — **only
   half: re-login still does not warn**, which was the case the note was about.
2. **The count is advisory and must stay that way.** It degrades to 0 when the
   agents table cannot be read, and it does not block the delete. An instance
   admin who wants a vault gone gets it, warned. Read a 0 as "no warning to
   show", never as proof nothing is bound.
3. **Removal is refused during an in-flight login** (`409`), for the same reason a
   second concurrent login is: both race the same credential file. Both removal
   paths take the same directory lock `promoteVaultCredential` takes.
4. **`deleteVault` is the only call in that module that destroys data,** so it
   re-asserts the containment invariant at the point of the recursive remove even
   though `resolveVaultDir` already proved it. Tests assert a directory outside
   the root survives a `../` attempt.
5. **Sign-out is idempotent but still audited** with `removed: false`. "Tried to
   sign out an already-empty vault" is a question an audit trail should answer.

**Verification**

- Vault battery — **52/52** (`codex-vault` 23, `host-login-pty` 13,
  `codex-vault-login-service` 16; was 36 before this session)
- `server` and `ui` typechecks — both clean

**Note on the repo-wide suite.** A full `vitest run` on this checkout reports
**93 failures across 32 files**, none in the vault or proxy suites. They were not
investigated in depth here; the signatures are dominated by incomplete test
mocks (`db.transaction is not a function`), missing host binaries, and port/
connection contention (`could not bind allocated port 42000`), and that run
overlapped two live servers and a set of scratch-database migration tests on the
same box. **Treat the 93 as unattributed until re-run on a quiet box** — do not
assume they are pre-existing, and do not assume they are ours.

**Outcome:** Both buttons in place, covered, documented. Nothing pushed.

**Next step:** (1) re-run the full suite on an idle box and attribute those 93;
(2) warn on re-login using the same `boundAgentCount`, which would fully retire
the §10 scoping note; (3) the page still has no UI test.

---

### 2026-08-27 — Session 9: Claude logins (feature, not a re-apply)

**Who:** Claude (Opus 5) with chris@anderson-family.com
**Goal:** The Codex logins page provisions named credential directories. Do the
same for Claude. Branch `W4-20260827c`.

**Outcome:** `/instance/settings/claude-logins`, backed by
`/sysops/llm/claude/<name>` and `CLAUDE_CONFIG_DIR`, with sign in, sign out, and
delete. Full design in
[`Claude device login web service.md`](CustomCodeDoc/Claude%20device%20login%20web%20service.md).

**The two findings that shaped it**

1. **The login is a round trip.** `claude setup-token` shows a URL, the operator
   signs in and is handed a code, and that code has to come *back* and be written
   to the waiting process. So the session has a `waiting_for_code` state and an
   extra route the Codex flow has no need for, and the page has a code field.
2. **`setup-token` persists nothing.** Codex device login writes an `auth.json`
   Paperclip copies; Claude writes no credential at all — the captured fixture is
   explicit. Paperclip captures the token off the stream and writes the credential
   file itself.

**That second point meant knowing exactly what Claude reads, so it was tested
rather than assumed** against the real CLI (2.1.231) with synthetic tokens: a
`.credentials.json` carrying only `accessToken` + `expiresAt`, and the same token
via `CLAUDE_CODE_OAUTH_TOKEN`, produce the *identical* error path. Claude sends it
as a bearer either way, which is what makes full parity possible — an agent sets
only `CLAUDE_CONFIG_DIR`. A credential carrying a `refreshToken` takes a different,
worse path, so none is written; a test pins its absence.

**Reuse.** Per explicit direction, this builds on `packages/adapters/claude-local`
rather than porting the Codex vault. `runSetupTokenLogin`, both setup-token
parsers, and the shared `createLoginPtyTransport` are used unchanged; the only
missing piece was a host-backed PTY session, which is all
`claude-host-login-pty.ts` adds. `readClaudeTokenFromDir` was extracted from
`quota.ts` so the vault asks claude-local what a credential is instead of
re-deriving it. The Codex host driver was not reusable — it hardcodes `CODEX_HOME`
and sets stdin to `ignore`, and a driver that cannot write cannot finish this
login.

**Files changed:** two new modules in `claude-local` plus `quota.ts` and the
barrel; new `claude-vault-login-service.ts` and `routes/claude-vaults.ts`;
`app.ts` and `routes/index.ts`; new `ui/api/claudeVaults.ts` and
`ui/pages/InstanceClaudeVaults.tsx`; `App.tsx`, `queryKeys.ts`,
`CompanySettingsSidebar.tsx`, `CompanySettingsNav.tsx` (+ its test, which asserts
the exact tab list); two new test files; the new doc.

**Verification:** 41/41 across the two new suites; 47/47 across the Codex vault
suites and the nav test, unchanged; `claude-local`, `server`, and `ui` typechecks
all clean.

**Not verified:** no real Anthropic account has been signed in through this page.
Every layer is exercised and the credential shape is verified with synthetic
tokens, but the end-to-end login is untested — that is the next step.

---

### <date> — Session N: <title>

**Who:**
**Goal:**
**Actions taken:**
**Files changed:**
**Findings / decisions:**
**Outcome:**
**Next step:**
