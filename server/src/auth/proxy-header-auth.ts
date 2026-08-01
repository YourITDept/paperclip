/**
 * Trusted reverse-proxy header authentication.
 *
 * For deployments where an authenticating reverse proxy (Traefik +
 * traefik-forward-auth, oauth2-proxy, Authelia, …) terminates the user's
 * OIDC/SAML login and forwards the authenticated identity as a request
 * header — conventionally `X-Forwarded-User: <email>`.
 *
 * SECURITY MODEL — read before enabling.
 *
 * When this is on, the configured header IS the credential. Anything that can
 * set that header on a request reaching this process can authenticate as any
 * user. There is no signature to check and no secret to compare, by design:
 * the trust boundary is the network, not the payload.
 *
 * Enabling it is therefore only safe when ALL of the following hold:
 *
 *   1. The server's listen port is not reachable from anywhere except the
 *      reverse proxy (bind to loopback or an internal container network).
 *   2. The proxy unconditionally *overwrites* the identity header on every
 *      inbound request, so a client-supplied value can never survive. With
 *      Traefik `forwardAuth`, listing the header in `authResponseHeaders`
 *      does this — it sets, not appends.
 *   3. No other route into the process bypasses the proxy.
 *
 * If you cannot guarantee (1), do not enable this.
 *
 * As defence-in-depth against a misconfigured proxy that *appends* rather
 * than overwrites, a header carrying multiple comma-joined values is
 * rejected outright rather than resolved to its first or last entry.
 *
 * Disabled unless `PAPERCLIP_PROXY_AUTH_ENABLED=true`, and it only takes
 * effect in `authenticated` deployment mode.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";

export const DEFAULT_PROXY_AUTH_USER_HEADER = "x-forwarded-user";

/** Generous upper bound; real addresses are far shorter (RFC 5321 caps at 254). */
const MAX_EMAIL_LENGTH = 320;

export type ProxyHeaderAuthConfig = {
  enabled: boolean;
  /** Lower-cased header name carrying the authenticated email. */
  headerName: string;
  /** Create a Paperclip user on first sight of an unknown email. */
  autoProvision: boolean;
  /** When non-empty, only these email domains may authenticate. */
  allowedDomains: string[];
};

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function resolveProxyHeaderAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProxyHeaderAuthConfig {
  const headerName =
    env.PAPERCLIP_PROXY_AUTH_USER_HEADER?.trim().toLowerCase() || DEFAULT_PROXY_AUTH_USER_HEADER;
  const allowedDomains = (env.PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter((domain) => domain.length > 0);

  return {
    enabled: parseBoolean(env.PAPERCLIP_PROXY_AUTH_ENABLED),
    headerName,
    autoProvision: parseBoolean(env.PAPERCLIP_PROXY_AUTH_AUTO_PROVISION),
    allowedDomains,
  };
}

/**
 * Normalize and validate the raw header value into an email address.
 *
 * Returns null — never throws, never guesses — for anything that isn't a
 * single, well-formed address. Fails closed on: absent/blank values, array or
 * comma-joined values (see the header-append note above), whitespace or
 * control characters, missing/multiple `@`, empty local or domain part, a
 * domain without a dot, and over-long values.
 */
export function extractProxyHeaderEmail(
  rawValue: string | string[] | undefined,
  config: ProxyHeaderAuthConfig,
): string | null {
  // Node joins repeated (non-set-cookie) headers with ", "; an array can also
  // surface directly. Either shape means more than one asserted identity.
  if (Array.isArray(rawValue)) return null;
  if (typeof rawValue !== "string") return null;

  const value = rawValue.trim();
  if (!value || value.length > MAX_EMAIL_LENGTH) return null;
  if (value.includes(",")) return null;
  // Any whitespace or C0/DEL control character. Hyphens are legal in
  // domain names and must not be caught here.
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;

  const email = value.toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [localPart, domain] = parts;
  if (!localPart || !domain) return null;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;

  if (config.allowedDomains.length > 0 && !config.allowedDomains.includes(domain)) return null;

  return email;
}

export type ProxyHeaderUser = {
  id: string;
  email: string;
  name: string | null;
  provisioned: boolean;
};

/**
 * Resolve an asserted email to a Paperclip user.
 *
 * Matches case-insensitively on `authUsers.email` so an address that differs
 * only in case from the stored row still resolves to the existing user rather
 * than provisioning a duplicate. Returns null when the email is unknown and
 * auto-provisioning is off — the caller then leaves the request unauthenticated.
 */
export async function resolveProxyHeaderUser(
  db: Db,
  email: string,
  config: ProxyHeaderAuthConfig,
): Promise<ProxyHeaderUser | null> {
  const existing = await db
    .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    return {
      id: existing.id,
      email: existing.email,
      name: existing.name ?? null,
      provisioned: false,
    };
  }

  if (!config.autoProvision) return null;

  const now = new Date();
  const inserted = await db
    .insert(authUsers)
    .values({
      id: randomUUID(),
      // The proxy only gives us an email; the user can set a display name
      // later in profile settings.
      name: email,
      email,
      // The upstream IdP verified this address; that is the entire premise of
      // trusting the proxy at all.
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
    .then((rows) => rows[0] ?? null);

  if (!inserted) return null;

  return {
    id: inserted.id,
    email: inserted.email,
    name: inserted.name ?? null,
    provisioned: true,
  };
}
