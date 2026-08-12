import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { resolveProxyHeaderActor } from "./auth.js";

/**
 * Minimal fake Drizzle Db keyed on the table passed to .from(), covering the
 * three reads resolveProxyHeaderActor performs: the authUsers lookup, the
 * instance_admin role probe, and the active company memberships. The chain is
 * awaitable so loadActiveUserCompanyMemberships (which awaits directly rather
 * than via .then()) resolves too.
 */
function createFakeDb(rowsByTable: Map<unknown, unknown[]>) {
  const insertedTables: unknown[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = rowsByTable.get(table) ?? [];
        const chain = {
          where: () => chain,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => {
      insertedTables.push(table);
      return {
        values: (values: Record<string, unknown>) => ({
          returning: () => ({
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve([{ id: values.id, email: values.email, name: values.name }]).then(resolve),
          }),
        }),
      };
    },
  };
  return { db: db as never, insertedTables };
}

function request(headers: Record<string, string | string[]>): Request {
  return { headers } as unknown as Request;
}

const KNOWN_USER = { id: "user-1", email: "alice@corp.com", name: "Alice" };

function dbWithUser(
  options: {
    isInstanceAdmin?: boolean;
    memberships?: Array<{ companyId: string; membershipRole: string | null; status: string }>;
    user?: { id: string; email: string; name: string | null } | null;
  } = {},
) {
  const user = options.user === undefined ? KNOWN_USER : options.user;
  return createFakeDb(
    new Map<unknown, unknown[]>([
      [authUsers, user ? [user] : []],
      [instanceUserRoles, options.isInstanceAdmin ? [{ id: "role-1" }] : []],
      [companyMemberships, options.memberships ?? []],
    ]),
  );
}

// Pin the whole config surface to its defaults before every test. A host that
// actually runs behind forward auth exports these for real
// (PAPERCLIP_PROXY_AUTH_ENABLED=true, AUTO_PROVISION=true, a custom header
// name), and any of them leaking in silently changes what these assertions
// mean. Each test opts in to what it needs by stubbing over these.
beforeEach(() => {
  vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "false");
  vi.stubEnv("PAPERCLIP_PROXY_AUTH_AUTO_PROVISION", "false");
  vi.stubEnv("PAPERCLIP_PROXY_AUTH_USER_HEADER", "");
  vi.stubEnv("PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveProxyHeaderActor", () => {
  it("returns null when proxy auth is not enabled", async () => {
    const { db } = dbWithUser();
    expect(await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "alice@corp.com" }))).toBeNull();
  });

  it("resolves a known email to a board actor", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    const { db } = dbWithUser({
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });

    const actor = await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "Alice@Corp.com" }));

    expect(actor).toMatchObject({
      type: "board",
      userId: "user-1",
      userEmail: "alice@corp.com",
      userName: "Alice",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
      source: "proxy_header",
    });
  });

  it("carries instance-admin only when the database says so", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    const { db } = dbWithUser({ isInstanceAdmin: true });

    const actor = await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "alice@corp.com" }));
    expect(actor?.isInstanceAdmin).toBe(true);
  });

  it("never provisions companies, memberships, or roles", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    const { db, insertedTables } = dbWithUser();

    await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "alice@corp.com" }));
    expect(insertedTables).toEqual([]);
  });

  it("denies an unknown email when auto-provisioning is off", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    const { db, insertedTables } = dbWithUser({ user: null });

    expect(await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "ghost@corp.com" }))).toBeNull();
    expect(insertedTables).toEqual([]);
  });

  it("provisions an unknown email only when auto-provisioning is on", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_AUTO_PROVISION", "true");
    const { db, insertedTables } = dbWithUser({ user: null });

    const actor = await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "new@corp.com" }));

    expect(actor).toMatchObject({
      type: "board",
      userEmail: "new@corp.com",
      companyIds: [],
      isInstanceAdmin: false,
      source: "proxy_header",
    });
    expect(insertedTables).toEqual([authUsers]);
  });

  it("denies a smuggled second identity", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    const { db } = dbWithUser();

    expect(
      await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "alice@corp.com, attacker@evil.com" })),
    ).toBeNull();
    expect(
      await resolveProxyHeaderActor(db, request({ "x-forwarded-user": ["alice@corp.com", "attacker@evil.com"] })),
    ).toBeNull();
  });

  it("reads the configured header name and ignores the default one", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_USER_HEADER", "X-Auth-Request-Email");
    const { db } = dbWithUser();

    expect(
      await resolveProxyHeaderActor(db, request({ "x-auth-request-email": "alice@corp.com" })),
    ).toMatchObject({ userId: "user-1" });
    expect(await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "alice@corp.com" }))).toBeNull();
  });

  it("enforces the domain allowlist", async () => {
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS", "corp.com");
    const { db } = dbWithUser();

    expect(await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "alice@corp.com" }))).toMatchObject({
      userId: "user-1",
    });
    expect(await resolveProxyHeaderActor(db, request({ "x-forwarded-user": "alice@evil.com" }))).toBeNull();
  });
});
