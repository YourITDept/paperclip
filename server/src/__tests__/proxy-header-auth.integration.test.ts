/**
 * The trusted-proxy header auth path, driven against the real Drizzle schema
 * and a migrated Postgres.
 *
 * `src/middleware/proxy-header-actor.test.ts` covers the resolution logic
 * against a fake Drizzle `Db`, which is the right shape for the header parsing
 * and the fail-closed rules but proves nothing about the database. That matters
 * after migration `0230`, which added a NOT NULL `issuer` column to Better
 * Auth's `account` table and a unique index on `(issuer, account_id)`: a fake
 * db cannot notice a constraint.
 *
 * The property this suite pins is that the fork's proxy path **writes no
 * `account` row at all**. A proxy-provisioned user is a `user` row and nothing
 * else — the upstream IdP holds the credential, so Paperclip has no password to
 * store. That is why `0230` cannot reach this path, and asserting it here means
 * a future change that starts writing `account` rows fails loudly instead of
 * discovering the NOT NULL column in production.
 */

import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { authAccounts, authUsers, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import { resolveProxyHeaderActor } from "../middleware/auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const PASSWORD_EMAIL = "password-user@corp.com";
const PASSWORD = "correct-horse-battery-staple";
/** What Better Auth 1.7 stamps on an email/password account. */
const CREDENTIAL_ISSUER = "local:credential";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

/** The only part of an Express request this path reads. */
function proxyRequest(headers: Record<string, string | string[]>): Request {
  return { headers } as unknown as Request;
}

describeEmbeddedPostgres("trusted proxy header auth against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-proxy-header-integration";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-proxy-header-auth-");
    db = createDb(database.connectionString);

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  // A host that really runs behind forward auth exports these for real, which
  // silently changes what the assertions mean. Pin them, then opt in per test.
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_AUTO_PROVISION", "false");
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_USER_HEADER", "");
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a password-backed user through the header to that same user id", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: PASSWORD_EMAIL, password: PASSWORD, name: "Password User" });
    expect(signUp.status).toBe(200);
    const userId = signUp.body?.user?.id as string;
    expect(userId).toBeTruthy();

    // The account row this user got is the post-0230 shape. If the migration
    // had not run, sign-up above would already have failed with a 500.
    const accounts = await db.select().from(authAccounts).where(eq(authAccounts.userId, userId));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.issuer).toBe(CREDENTIAL_ISSUER);

    // The proxy asserting that address resolves to the *same* Paperclip user,
    // so the two identity sources never fork into two accounts.
    const actor = await resolveProxyHeaderActor(
      db,
      proxyRequest({ "x-forwarded-user": PASSWORD_EMAIL }),
    );
    expect(actor).toMatchObject({
      type: "board",
      userId,
      userEmail: PASSWORD_EMAIL,
      source: "proxy_header",
    });
  });

  it("auto-provisions a user row and deliberately writes no account row", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_AUTO_PROVISION", "true");
    const email = "provisioned@corp.com";

    const actor = await resolveProxyHeaderActor(db, proxyRequest({ "x-forwarded-user": email }));
    expect(actor).toMatchObject({ type: "board", userEmail: email, source: "proxy_header" });

    const userId = (actor as { userId: string }).userId;
    const users = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    expect(users).toHaveLength(1);
    // The upstream IdP verified the address; that is the premise of trusting
    // the proxy at all.
    expect(users[0]?.emailVerified).toBe(true);

    // The point of this suite. No `account` row means migration 0230's NOT NULL
    // `issuer` column and its unique index are unreachable from this path.
    const accounts = await db.select().from(authAccounts).where(eq(authAccounts.userId, userId));
    expect(accounts).toHaveLength(0);
  });

  it("matches an existing user case-insensitively instead of provisioning a duplicate", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_AUTO_PROVISION", "true");

    const before = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(authUsers)
      .then((rows) => rows[0]?.count ?? 0);

    const actor = await resolveProxyHeaderActor(
      db,
      proxyRequest({ "x-forwarded-user": PASSWORD_EMAIL.toUpperCase() }),
    );
    expect((actor as { userEmail: string }).userEmail).toBe(PASSWORD_EMAIL);

    const after = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(authUsers)
      .then((rows) => rows[0]?.count ?? 0);
    expect(after).toBe(before);
  });

  it("stays off when the feature flag is not set, even with the header present", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "false");
    expect(
      await resolveProxyHeaderActor(db, proxyRequest({ "x-forwarded-user": PASSWORD_EMAIL })),
    ).toBeNull();
  });
});
