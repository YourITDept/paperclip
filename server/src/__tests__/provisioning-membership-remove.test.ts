import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { provisioningHandlers } from "../provisioning/handlers.js";
import { isKnownJobType, provisioningStore } from "../provisioning/store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping membership.remove tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * `membership.remove` — the only job type that REVOKES.
 *
 * Every other handler asserts a desired state and converges on it, so a bug
 * there shows up as something missing. A bug HERE takes away access that should
 * have stayed, or leaves access that should have gone, and neither is visible
 * from the queue. The contract is in the onboarding repo's
 * `outseta-paperclip-integration/docs/99-AGENT-NOTES.md` (2026-09-08).
 */
describeEmbeddedPostgres("provisioning membership.remove", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-membership-remove-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("membership-remove");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(boardApiKeys);
    await db.delete(authSessions);
    await db.delete(instanceUserRoles);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function handlers() {
    return provisioningHandlers(db, provisioningStore(db));
  }
  const job = { idempotencyKey: `job-${randomUUID()}` };

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `T${id.slice(0, 2)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedUser(email: string) {
    const id = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id, name: email, email, emailVerified: true, image: null, createdAt: now, updatedAt: now,
    });
    return id;
  }

  async function seedMembership(
    companyId: string,
    userId: string,
    membershipRole: "owner" | "admin" | "operator" = "operator",
  ) {
    const [row] = await db
      .insert(companyMemberships)
      .values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole })
      .returning({ id: companyMemberships.id });
    await accessService(db).ensureRoleDefaultGrants(companyId, userId, membershipRole, null);
    return row.id;
  }

  async function activeMemberships(userId: string) {
    return db
      .select({ companyId: companyMemberships.companyId, status: companyMemberships.status })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)));
  }

  it("is in the job vocabulary", () => {
    expect(isKnownJobType("membership.remove")).toBe(true);
  });

  it("archives every company when the payload names none", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const owner = await seedUser("owner@example.com");
    await seedMembership(a, owner, "owner");
    await seedMembership(b, owner, "owner");
    const leaver = await seedUser("leaver@example.com");
    await seedMembership(a, leaver, "operator");
    await seedMembership(b, leaver, "admin");

    const result = await handlers().run("membership.remove", { email: "leaver@example.com" }, job);

    // No company named means EVERY company — the opposite of membership.set.
    expect(result).toMatchObject({ removed: true, scope: "instance", companiesArchived: 2 });
    const rows = await activeMemberships(leaver);
    expect(rows.every((r) => r.status === "archived")).toBe(true);
    // The grants must go too: a membership without grants is invisible, but a
    // grant without a membership is a permission nobody can see or revoke.
    const grants = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, leaver));
    expect(grants).toHaveLength(0);
  });

  it("archives the user row NEVER — only the membership", async () => {
    const a = await seedCompany("Alpha");
    const owner = await seedUser("owner@example.com");
    await seedMembership(a, owner, "owner");
    const leaver = await seedUser("leaver@example.com");
    await seedMembership(a, leaver, "operator");

    await handlers().run("membership.remove", { email: "leaver@example.com" }, job);

    // 125 columns hold a user id and only 5 have a foreign key to it. A DELETE
    // would cascade 5 and leave up to 120 dangling with no error anywhere.
    const stillThere = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, leaver));
    expect(stillThere).toHaveLength(1);
  });

  it("revokes credentials that already exist, not just authorisation", async () => {
    const a = await seedCompany("Alpha");
    const owner = await seedUser("owner@example.com");
    await seedMembership(a, owner, "owner");
    const leaver = await seedUser("leaver@example.com");
    await seedMembership(a, leaver, "operator");
    const now = new Date();
    await db.insert(authSessions).values({
      id: randomUUID(), token: randomUUID(), userId: leaver,
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now,
    });
    await db.insert(boardApiKeys).values({ userId: leaver, name: "cli", keyHash: randomUUID() });

    const result = await handlers().run("membership.remove", { email: "leaver@example.com" }, job);

    // An archived membership stops authorisation, but a live session or API key
    // is a credential already in somebody's hands.
    expect(result).toMatchObject({ sessionsRevoked: 1, apiKeysRevoked: 1 });
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, leaver))).toHaveLength(0);
    const [key] = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, leaver));
    // Revoked, not deleted: the row is the audit record of a key having existed.
    expect(key.revokedAt).not.toBeNull();
  });

  it("treats an unknown person as success, not failure", async () => {
    const result = await handlers().run("membership.remove", { email: "never@example.com" }, job);
    // Somebody removed before they were ever provisioned is ordinary. A
    // permanent error would put a red row on a healthy instance.
    expect(result).toMatchObject({ removed: false, reason: "no_such_user" });
  });

  it("refuses to strand a company without an owner, and archives NOTHING", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const soleOwner = await seedUser("sole@example.com");
    await seedMembership(a, soleOwner, "operator");
    await seedMembership(b, soleOwner, "owner"); // the only owner of Beta
    await db.insert(instanceUserRoles).values({ userId: await seedUser("admin@example.com"), role: "instance_admin" });

    await expect(
      handlers().run("membership.remove", { email: "sole@example.com" }, job),
    ).rejects.toMatchObject({ code: "last_owner" });

    // The guard runs BEFORE any archiving, so a person with memberships in
    // several companies is never left half-revoked by a permanent failure.
    const rows = await activeMemberships(soleOwner);
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  it("refuses to leave the instance with no admin", async () => {
    const a = await seedCompany("Alpha");
    const owner = await seedUser("owner@example.com");
    await seedMembership(a, owner, "owner");
    const lastAdmin = await seedUser("last@example.com");
    await seedMembership(a, lastAdmin, "operator");
    await db.insert(instanceUserRoles).values({ userId: lastAdmin, role: "instance_admin" });

    // An instance with no instance_admin has nobody who can create companies.
    // Same reasoning as last_owner, applied one level up.
    await expect(
      handlers().run("membership.remove", { email: "last@example.com" }, job),
    ).rejects.toMatchObject({ code: "last_instance_admin" });
  });

  it("scopes to one company when the payload names one, and leaves credentials alone", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const owner = await seedUser("owner@example.com");
    await seedMembership(a, owner, "owner");
    await seedMembership(b, owner, "owner");
    const member = await seedUser("member@example.com");
    await seedMembership(a, member, "operator");
    await seedMembership(b, member, "operator");
    const now = new Date();
    await db.insert(authSessions).values({
      id: randomUUID(), token: randomUUID(), userId: member,
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now,
    });

    const result = await handlers().run("membership.remove", { email: "member@example.com", companyId: a }, job);

    expect(result).toMatchObject({ scope: a, companiesArchived: 1 });
    const rows = await activeMemberships(member);
    expect(rows.find((r) => r.companyId === a)?.status).toBe("archived");
    expect(rows.find((r) => r.companyId === b)?.status).toBe("active");
    // The person legitimately keeps access to Beta, so the session must survive.
    expect(result.sessionsRevoked).toBe(0);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, member))).toHaveLength(1);
  });

  it("is a no-op on replay", async () => {
    const a = await seedCompany("Alpha");
    const owner = await seedUser("owner@example.com");
    await seedMembership(a, owner, "owner");
    const leaver = await seedUser("leaver@example.com");
    await seedMembership(a, leaver, "operator");

    const first = await handlers().run("membership.remove", { email: "leaver@example.com" }, job);
    const second = await handlers().run("membership.remove", { email: "leaver@example.com" }, job);

    expect(first).toMatchObject({ companiesArchived: 1 });
    // Already-archived memberships are counted as nothing new, so a redelivery
    // does not look like a second revocation in the queue's result.
    expect(second).toMatchObject({ removed: true, companiesArchived: 0 });
  });

  it("rejects a payload with no usable email", async () => {
    for (const email of [undefined, "", "not-an-address", "a@b"]) {
      await expect(
        handlers().run("membership.remove", { email }, job),
      ).rejects.toMatchObject({ code: "invalid_payload" });
    }
  });
});
