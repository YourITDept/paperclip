import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_VAULT_CREDENTIAL_REJECTED,
  CLAUDE_VAULT_NAME_INVALID,
  CLAUDE_VAULT_ROOT_ENV_KEY,
  DEFAULT_CLAUDE_VAULT_ROOT,
  SETUP_TOKEN_LIFETIME_MS,
  buildSetupTokenCredential,
  deleteVault,
  ensureVaultDir,
  isValidVaultName,
  listVaults,
  promoteVaultCredential,
  readVaultSummary,
  removeVaultCredential,
  resolveVaultDir,
  resolveVaultRoot,
  vaultExists,
} from "./claude-vault.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-vault-test-"));
  env = { [CLAUDE_VAULT_ROOT_ENV_KEY]: root };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * A plausible setup-token, in the real shape: the `sk-ant-oat01-` prefix plus a
 * long opaque tail over `[A-Za-z0-9_-]`. Synthetic; no real token here.
 */
const SETUP_TOKEN = "sk-ant-oat01-AbCdEf0123456789_-abcdefghijklmnopqrstuvwxyz0123456789";

describe("vault name validation", () => {
  it("accepts operator-style names", () => {
    for (const name of ["chris_claude", "a1", "team-one", "x".repeat(40)]) {
      expect(isValidVaultName(name)).toBe(true);
    }
  });

  it("rejects anything that could leave the root", () => {
    for (const name of ["", ".", "..", "../escape", "a/b", "/abs", "A", "-lead", "x".repeat(41)]) {
      expect(isValidVaultName(name)).toBe(false);
    }
  });

  it("resolves a vault directly under the root, and refuses to escape it", () => {
    expect(resolveVaultDir("team_one", env)).toBe(path.join(root, "team_one"));
    expect(() => resolveVaultDir("../escape", env)).toThrow(CLAUDE_VAULT_NAME_INVALID);
  });

  it("defaults the root to the documented path and honours the override", () => {
    expect(resolveVaultRoot({})).toBe(DEFAULT_CLAUDE_VAULT_ROOT);
    expect(resolveVaultRoot(env)).toBe(root);
  });
});

describe("the credential file Paperclip writes", () => {
  it("carries the token as the bearer field Claude reads, with a one-year expiry", () => {
    const now = 1_700_000_000_000;
    const parsed = JSON.parse(buildSetupTokenCredential(SETUP_TOKEN, now));
    expect(parsed.claudeAiOauth.accessToken).toBe(SETUP_TOKEN);
    expect(parsed.claudeAiOauth.expiresAt).toBe(now + SETUP_TOKEN_LIFETIME_MS);
  });

  it("writes no refreshToken", () => {
    // Deliberate, and load-bearing. A setup-token has nothing to refresh with.
    // Verified against the real CLI: a credential carrying a refreshToken sends
    // Claude down its refresh path, which fails with a misleading "OAuth session
    // expired" instead of a plain auth error.
    const parsed = JSON.parse(buildSetupTokenCredential(SETUP_TOKEN));
    expect(parsed.claudeAiOauth.refreshToken).toBeUndefined();
  });
});

describe("provisioning", () => {
  it("creates a private directory and seeds settings.json", async () => {
    const dir = await ensureVaultDir("fresh", env);
    const stat = await fs.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
    await expect(fs.access(path.join(dir, "settings.json"))).resolves.toBeUndefined();
    // No credential yet: provisioning a name is not signing in.
    expect(await readVaultSummary("fresh", env)).toMatchObject({
      name: "fresh",
      hasCredential: false,
      tokenSuffix: null,
    });
  });

  it("never overwrites an existing settings.json", async () => {
    const dir = await ensureVaultDir("keepsettings", env);
    await fs.writeFile(path.join(dir, "settings.json"), '{"custom":true}');
    await ensureVaultDir("keepsettings", env);
    expect(await fs.readFile(path.join(dir, "settings.json"), "utf8")).toBe('{"custom":true}');
  });

  it("promotes a token and reports it without exposing it", async () => {
    await promoteVaultCredential("signedin", SETUP_TOKEN, env);
    const summary = await readVaultSummary("signedin", env);
    expect(summary).toMatchObject({
      name: "signedin",
      hasCredential: true,
      authMode: "setup_token",
      tokenSuffix: SETUP_TOKEN.slice(-8),
    });
    // The summary carries a suffix, never the token.
    expect(JSON.stringify(summary)).not.toContain(SETUP_TOKEN);
    const mode = (await fs.stat(path.join(root, "signedin", ".credentials.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects a token that is not token-shaped", async () => {
    for (const bad of ["", "   ", "has spaces", "short", "a".repeat(600)]) {
      await expect(promoteVaultCredential("bad", bad, env)).rejects.toThrow(
        CLAUDE_VAULT_CREDENTIAL_REJECTED,
      );
    }
  });

  it("reports a login-written credential as oauth, not setup_token", async () => {
    // A directory an operator signed into with `claude login` holds a refresh
    // token. The summary distinguishes the two so the page can say which it is.
    const dir = await ensureVaultDir("interactive", env);
    await fs.writeFile(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat-example-access-token-value",
          refreshToken: "sk-ant-oat-example-refresh-token-value",
          expiresAt: Date.now() + 3_600_000,
          subscriptionType: "max",
        },
      }),
      { mode: 0o600 },
    );
    expect(await readVaultSummary("interactive", env)).toMatchObject({
      hasCredential: true,
      authMode: "oauth",
      subscriptionType: "max",
    });
  });

  it("lists only well-formed vaults and tolerates a missing root", async () => {
    await ensureVaultDir("one", env);
    await ensureVaultDir("two", env);
    await fs.mkdir(path.join(root, "Not A Vault"), { recursive: true });
    expect((await listVaults(env)).map((v) => v.name)).toEqual(["one", "two"]);
    expect(await listVaults({ [CLAUDE_VAULT_ROOT_ENV_KEY]: path.join(root, "absent") })).toEqual([]);
  });
});

describe("removing a credential", () => {
  it("removes the credential and keeps the vault usable", async () => {
    const dir = await ensureVaultDir("keeper", env);
    await promoteVaultCredential("keeper", SETUP_TOKEN, env);
    await expect(readVaultSummary("keeper", env)).resolves.toMatchObject({ hasCredential: true });

    await expect(removeVaultCredential("keeper", env)).resolves.toBe(true);

    await expect(fs.access(path.join(dir, ".credentials.json"))).rejects.toThrow();
    // The vault, its path, and its settings survive, so an agent pointed at this
    // CLAUDE_CONFIG_DIR still resolves and a later sign-in restores it.
    await expect(fs.access(path.join(dir, "settings.json"))).resolves.toBeUndefined();
    expect(await readVaultSummary("keeper", env)).toMatchObject({ hasCredential: false });
    expect(await listVaults(env)).toHaveLength(1);
  });

  it("is idempotent when there is no credential", async () => {
    await ensureVaultDir("empty", env);
    await expect(removeVaultCredential("empty", env)).resolves.toBe(false);
    await expect(removeVaultCredential("empty", env)).resolves.toBe(false);
  });

  it("returns false for a vault directory that does not exist", async () => {
    // Taking the directory lock on a missing directory throws ENOENT, which would
    // surface as a 500 rather than a not-found.
    await expect(removeVaultCredential("never_created", env)).resolves.toBe(false);
  });

  it("signing in again after a removal restores the credential", async () => {
    await promoteVaultCredential("cycle", SETUP_TOKEN, env);
    await removeVaultCredential("cycle", env);
    await promoteVaultCredential("cycle", SETUP_TOKEN, env);
    expect(await readVaultSummary("cycle", env)).toMatchObject({ hasCredential: true });
  });

  it("rejects a traversing name instead of unlinking outside the root", async () => {
    await expect(removeVaultCredential("../escape", env)).rejects.toThrow(CLAUDE_VAULT_NAME_INVALID);
  });

  it("reports vault existence, so callers can tell no-vault from no-credential", async () => {
    await expect(vaultExists("absent", env)).resolves.toBe(false);
    await ensureVaultDir("present", env);
    await expect(vaultExists("present", env)).resolves.toBe(true);
  });
});

describe("deleting a vault", () => {
  it("removes the whole directory and leaves its siblings alone", async () => {
    const doomed = await ensureVaultDir("doomed", env);
    const survivor = await ensureVaultDir("survivor", env);
    await promoteVaultCredential("doomed", SETUP_TOKEN, env);
    await promoteVaultCredential("survivor", SETUP_TOKEN, env);

    await expect(deleteVault("doomed", env)).resolves.toBe(true);

    await expect(fs.access(doomed)).rejects.toThrow();
    await expect(fs.access(survivor)).resolves.toBeUndefined();
    const remaining = await listVaults(env);
    expect(remaining.map((v) => v.name)).toEqual(["survivor"]);
    expect(remaining[0]).toMatchObject({ hasCredential: true });
  });

  it("removes a vault holding extra Claude state, not just the known files", async () => {
    const dir = await ensureVaultDir("stateful", env);
    await fs.mkdir(path.join(dir, "projects"), { recursive: true });
    await fs.writeFile(path.join(dir, "projects", "a.json"), "{}");
    await expect(deleteVault("stateful", env)).resolves.toBe(true);
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it("reports false for a vault that does not exist", async () => {
    await expect(deleteVault("ghost", env)).resolves.toBe(false);
  });

  it("refuses a traversing name rather than removing a directory outside the root", async () => {
    // The guard matters more here than anywhere else in the module: this is the
    // one call that recursively destroys a directory.
    const outside = path.join(root, "..", "claude-not-a-vault");
    await fs.mkdir(outside, { recursive: true });
    try {
      await expect(deleteVault("../claude-not-a-vault", env)).rejects.toThrow(
        CLAUDE_VAULT_NAME_INVALID,
      );
      await expect(fs.access(outside)).resolves.toBeUndefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("never removes the vault root itself", async () => {
    for (const name of ["", ".", "..", "/"]) {
      await expect(deleteVault(name, env)).rejects.toThrow();
    }
    await expect(fs.access(root)).resolves.toBeUndefined();
  });
});
