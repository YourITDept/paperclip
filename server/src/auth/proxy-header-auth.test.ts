import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROXY_AUTH_USER_HEADER,
  extractProxyHeaderEmail,
  resolveProxyHeaderAuthConfig,
  resolveProxyHeaderUser,
  type ProxyHeaderAuthConfig,
} from "./proxy-header-auth.js";

function config(overrides: Partial<ProxyHeaderAuthConfig> = {}): ProxyHeaderAuthConfig {
  return {
    enabled: true,
    headerName: DEFAULT_PROXY_AUTH_USER_HEADER,
    autoProvision: false,
    allowedDomains: [],
    ...overrides,
  };
}

describe("resolveProxyHeaderAuthConfig", () => {
  it("is disabled by default", () => {
    const resolved = resolveProxyHeaderAuthConfig({});
    expect(resolved.enabled).toBe(false);
    expect(resolved.headerName).toBe("x-forwarded-user");
    expect(resolved.autoProvision).toBe(false);
    expect(resolved.allowedDomains).toEqual([]);
  });

  it("only treats the exact string \"true\" as enabled", () => {
    expect(resolveProxyHeaderAuthConfig({ PAPERCLIP_PROXY_AUTH_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveProxyHeaderAuthConfig({ PAPERCLIP_PROXY_AUTH_ENABLED: " TRUE " }).enabled).toBe(true);
    for (const value of ["1", "yes", "on", "false", ""]) {
      expect(resolveProxyHeaderAuthConfig({ PAPERCLIP_PROXY_AUTH_ENABLED: value }).enabled).toBe(false);
    }
  });

  it("lower-cases the header name and falls back when blank", () => {
    expect(
      resolveProxyHeaderAuthConfig({ PAPERCLIP_PROXY_AUTH_USER_HEADER: "X-Auth-Request-Email" }).headerName,
    ).toBe("x-auth-request-email");
    expect(resolveProxyHeaderAuthConfig({ PAPERCLIP_PROXY_AUTH_USER_HEADER: "   " }).headerName).toBe(
      DEFAULT_PROXY_AUTH_USER_HEADER,
    );
  });

  it("normalizes the domain allowlist", () => {
    expect(
      resolveProxyHeaderAuthConfig({
        PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS: " @Corp.com , example.org ,, ",
      }).allowedDomains,
    ).toEqual(["corp.com", "example.org"]);
  });
});

describe("extractProxyHeaderEmail", () => {
  it("accepts and lower-cases a well-formed address", () => {
    expect(extractProxyHeaderEmail("Alice@Corp.com", config())).toBe("alice@corp.com");
    expect(extractProxyHeaderEmail("  bob@corp.com  ", config())).toBe("bob@corp.com");
  });

  it("keeps hyphenated domains and plus-addressing intact", () => {
    expect(extractProxyHeaderEmail("a.b+tag@my-corp.co.uk", config())).toBe("a.b+tag@my-corp.co.uk");
  });

  it("rejects absent or empty values", () => {
    expect(extractProxyHeaderEmail(undefined, config())).toBeNull();
    expect(extractProxyHeaderEmail("", config())).toBeNull();
    expect(extractProxyHeaderEmail("   ", config())).toBeNull();
  });

  // The security-critical case: a proxy that appends rather than overwrites
  // would let a client smuggle a second identity into the same header.
  it("rejects multiple asserted identities", () => {
    expect(extractProxyHeaderEmail("attacker@evil.com, real@corp.com", config())).toBeNull();
    expect(extractProxyHeaderEmail("real@corp.com,attacker@evil.com", config())).toBeNull();
    expect(extractProxyHeaderEmail(["real@corp.com", "attacker@evil.com"], config())).toBeNull();
    expect(extractProxyHeaderEmail(["real@corp.com"], config())).toBeNull();
  });

  it("rejects malformed addresses", () => {
    for (const value of [
      "not-an-email",
      "@corp.com",
      "alice@",
      "alice@@corp.com",
      "alice@corp",
      "alice@.com",
      "alice@corp.",
      "alice corp@corp.com",
    ]) {
      expect(extractProxyHeaderEmail(value, config())).toBeNull();
    }
  });

  it("rejects control characters and header-injection attempts", () => {
    expect(extractProxyHeaderEmail("alice@corp.com\r\nX-Admin: true", config())).toBeNull();
    expect(extractProxyHeaderEmail("alice@corp.com\u0000", config())).toBeNull();
    expect(extractProxyHeaderEmail("alice@corp.com\u007f", config())).toBeNull();
  });

  it("rejects over-long values", () => {
    expect(extractProxyHeaderEmail(`${"a".repeat(400)}@corp.com`, config())).toBeNull();
  });

  it("enforces the domain allowlist when configured", () => {
    const restricted = config({ allowedDomains: ["corp.com"] });
    expect(extractProxyHeaderEmail("alice@corp.com", restricted)).toBe("alice@corp.com");
    expect(extractProxyHeaderEmail("alice@CORP.com", restricted)).toBe("alice@corp.com");
    expect(extractProxyHeaderEmail("alice@evil.com", restricted)).toBeNull();
    // Suffix matching must not be enough to pass.
    expect(extractProxyHeaderEmail("alice@notcorp.com", restricted)).toBeNull();
  });
});

/**
 * Minimal fake Drizzle Db covering the two shapes resolveProxyHeaderUser uses:
 * select().from().where().then() and insert().values().returning().then().
 */
function createFakeDb(options: { existingRows?: Array<{ id: string; email: string; name: string | null }> } = {}) {
  const existingRows = options.existingRows ?? [];
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (rows: unknown) => unknown) => Promise.resolve(existingRows).then(resolve),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: () => ({
            then: (resolve: (rows: unknown) => unknown) =>
              Promise.resolve([{ id: values.id, email: values.email, name: values.name }]).then(resolve),
          }),
        };
      },
    }),
  };
  return { db: db as never, inserted };
}

describe("resolveProxyHeaderUser", () => {
  it("returns the existing user without provisioning", async () => {
    const { db, inserted } = createFakeDb({
      existingRows: [{ id: "user-1", email: "Alice@Corp.com", name: "Alice" }],
    });
    const user = await resolveProxyHeaderUser(db, "alice@corp.com", config());
    expect(user).toEqual({ id: "user-1", email: "Alice@Corp.com", name: "Alice", provisioned: false });
    expect(inserted).toHaveLength(0);
  });

  it("returns null for an unknown email when auto-provisioning is off", async () => {
    const { db, inserted } = createFakeDb();
    expect(await resolveProxyHeaderUser(db, "nobody@corp.com", config())).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it("provisions an unknown email when auto-provisioning is on", async () => {
    const { db, inserted } = createFakeDb();
    const user = await resolveProxyHeaderUser(db, "new@corp.com", config({ autoProvision: true }));
    expect(user?.email).toBe("new@corp.com");
    expect(user?.provisioned).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ email: "new@corp.com", emailVerified: true });
    expect(String(inserted[0].id)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
