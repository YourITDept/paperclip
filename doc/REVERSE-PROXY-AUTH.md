# Trusted Reverse-Proxy Authentication

Accept an identity that an authenticating reverse proxy has already
established, instead of asking the user for a Paperclip password.

Typical setup: Traefik + [traefik-forward-auth](https://github.com/thomseddon/traefik-forward-auth)
(or oauth2-proxy, Authelia, Authentik) completes an OIDC login at the edge and
forwards the authenticated email to Paperclip as `X-Forwarded-User`.

Paperclip resolves that email to an existing user and establishes a normal
board session — no second login, no second identity.

## Security model — read this first

**When this is enabled, the configured header is the credential.** There is no
signature and no shared secret to verify, by design: the trust boundary is the
network, not the payload. Anything that can set that header on a request
reaching the Node process can authenticate as any user.

Only enable it when **all** of the following are true:

1. **The listen port is unreachable except through the proxy.** Bind to
   loopback or an internal container network. If `:3100` is reachable from a
   LAN, a VPN, or another container that shouldn't have admin, do not enable
   this.
2. **The proxy overwrites the header on every inbound request**, so a
   client-supplied value can never survive. Traefik's `forwardAuth` does this
   for headers listed in `authResponseHeaders` — it sets, rather than appends.
3. **No other route reaches the process** — no port publishing, no host
   networking, no sidecar with direct access.

As defence-in-depth, a header carrying more than one value (comma-joined or
repeated) is rejected outright rather than resolved to its first or last entry,
so a proxy misconfigured to *append* fails closed instead of letting a client
smuggle a second identity.

If you cannot guarantee (1), use a signed-assertion scheme instead — this
feature is not appropriate.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPERCLIP_PROXY_AUTH_ENABLED` | `false` | Master switch. Must be exactly `true`. |
| `PAPERCLIP_PROXY_AUTH_USER_HEADER` | `x-forwarded-user` | Header carrying the authenticated email. Case-insensitive. |
| `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION` | `false` | Create a Paperclip user on first sight of an unknown email. |
| `PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS` | *(empty)* | Optional comma-separated domain allowlist. Empty means any domain. |

Also required:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated` — in `local_trusted` every request
  is already an implicit admin and none of the identity paths run.
- `PAPERCLIP_ALLOWED_HOSTNAMES` must include the external hostname.
- `PAPERCLIP_PUBLIC_URL` **must** be the external `https://` URL so cookies,
  trusted origins, and the board mutation guard resolve correctly behind TLS
  termination. A proxy-authenticated actor is deliberately *not* exempt from the
  board mutation origin guard, so getting this wrong produces a distinctive
  half-working state — see Verifying, check 4.
- `TRUST_PROXY` should be set so `req.ip` and request logs show real client
  addresses (e.g. `TRUST_PROXY=1` for a single proxy hop).

Header names for other proxies: oauth2-proxy emits `X-Auth-Request-Email`,
Authelia emits `Remote-Email`.

## What it does and does not do

**Does:** resolve the asserted email (case-insensitively) to a row in the
`user` table, then attach a board actor carrying that user's existing instance
role and company memberships. Identical downstream treatment to a password
session.

**Does not:** create companies, create memberships, grant permissions, or touch
`instanceUserRoles`. The proxy asserts *who the user is*; what they may do stays
entirely under Paperclip's own authorization model. A user the proxy
authenticates but who has no memberships signs in and sees nothing.

This is deliberately unlike the Paperclip Cloud trusted-header path
(`resolveCloudTenantActor`), which provisions a company per stack and manages
roles. Do not use the Cloud path for self-hosted forward auth — among other
things it deletes `instance_admin` rows on every request.

## First sign-in and admin bootstrap

Auto-provisioned users get **no instance role and no company membership**. Plan
the first admin before switching over. Either:

- create the admin account through the normal password flow first, then enable
  proxy auth — the emails match and the existing user is reused; or
- enable `PAPERCLIP_PROXY_AUTH_AUTO_PROVISION`, sign in, then grant the
  instance-admin role to that user out of band.

With auto-provisioning **off** (the default), an unknown email is denied and
logged at `warn` with the asserted address — useful for spotting an email
mismatch between the IdP and existing Paperclip accounts.

## Agents, the CLI, and webhooks

Agent and CLI traffic authenticates with `Authorization: Bearer …`. Bearer
tokens are evaluated **before** the proxy-header path, so enabling this cannot
break them inside Paperclip.

The problem is at the proxy: forward-auth will try to redirect non-browser
clients to the IdP, which they cannot follow. Either exempt those routes from
the forward-auth middleware, or route API traffic through a separate Traefik
router that skips it. Decide this before rollout.

## Sign-out

Signing out inside Paperclip does not clear the proxy's session — the next
request silently re-authenticates. To fully sign out, the user must hit the
proxy's own logout URL (traefik-forward-auth: `/_oauth/logout`).

## Traefik example

```yaml
# traefik-forward-auth must be configured with:
#   authResponseHeaders = ["X-Forwarded-User"]
http:
  middlewares:
    forward-auth:
      forwardAuth:
        address: "http://traefik-forward-auth:4181"
        authResponseHeaders:
          - "X-Forwarded-User"

  routers:
    paperclip:
      rule: "Host(`paperclip.example.com`)"
      middlewares:
        - forward-auth
      service: paperclip
```

Paperclip environment:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_PROXY_AUTH_ENABLED=true
PAPERCLIP_PROXY_AUTH_USER_HEADER=x-forwarded-user
PAPERCLIP_ALLOWED_HOSTNAMES=paperclip.example.com
PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
TRUST_PROXY=1
```

Publish no host port for the Paperclip container — Traefik reaches it over the
internal Docker network only.

## Verifying

1. **The header arrives.** Sign in through the proxy and confirm the server
   log shows the expected actor. An unknown email logs
   `Trusted proxy asserted an email with no matching Paperclip user`.
2. **Direct access is impossible.** From another host on the network:
   `curl -H 'X-Forwarded-User: admin@example.com' http://<host>:3100/api/auth/get-session`
   must fail to connect. **If it returns a session, the deployment is
   unsafe** — the port is exposed and requirement (1) is violated.
3. **Live events connect.** The WebSocket upgrade path resolves the same
   header; if the UI loads but never updates in real time, the header is not
   reaching `/api/companies/:id/events/ws`.
4. **Writes work, not just reads.** Change something on the board and confirm it
   saves. If reads render fine but every mutation returns
   `403 Board mutation requires trusted browser origin`, the identity header is
   working and the *origin* configuration is not: `PAPERCLIP_PUBLIC_URL` (and
   `PAPERCLIP_ALLOWED_HOSTNAMES`) do not match the external origin the browser
   actually sends. Proxy-authenticated actors are intentionally subject to the
   origin guard, so this check cannot be skipped — a read-only smoke test will
   pass on a deployment where nothing can be saved.

## Implementation

- [`server/src/auth/proxy-header-auth.ts`](../server/src/auth/proxy-header-auth.ts) — config, header validation, user resolution
- [`server/src/middleware/auth.ts`](../server/src/middleware/auth.ts) — `resolveProxyHeaderActor`, called from `actorMiddleware`
- [`server/src/realtime/live-events-ws.ts`](../server/src/realtime/live-events-ws.ts) — the same resolution for WebSocket upgrades
- Actor `source` is `proxy_header`; it is treated as a browser session
  everywhere downstream, including the board mutation origin guard.
