import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEX_VAULT_NAME_INVALID,
  CODEX_VAULT_ROOT_ENV_KEY,
  DEFAULT_CODEX_VAULT_ROOT,
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
} from "./codex-vault.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-vault-test-"));
  env = { [CODEX_VAULT_ROOT_ENV_KEY]: root };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const SUBSCRIPTION_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id",
    access_token: "access",
    refresh_token: "refresh",
    account_id: "abcdef01-2345-6789-abcd-ef0123456789",
  },
  last_refresh: "2026-08-24T14:28:52Z",
});

describe("vault name validation", () => {
  it("accepts operator-style names", () => {
    for (const name of ["chris_codex", "a1", "team-one", "x".repeat(40)]) {
      expect(isValidVaultName(name)).toBe(true);
    }
  });

  it("rejects traversal, separators, and shell metacharacters", () => {
    const hostile = [
      "..",
      "../etc",
      "a/b",
      "a\\b",
      "/abs",
      "a b",
      "a;rm -rf /",
      "a\nb",
      "a\tb",
      "-lead",
      "_lead",
      "UPPER",
      "x",
      "",
      "x".repeat(41),
      "a$(id)",
      "a`id`",
      ".",
    ];
    for (const name of hostile) {
      expect(isValidVaultName(name), JSON.stringify(name)).toBe(false);
      expect(() => resolveVaultDir(name, env), JSON.stringify(name)).toThrow(
        CODEX_VAULT_NAME_INVALID,
      );
    }
  });

  it("always resolves to a direct child of the root", () => {
    expect(resolveVaultDir("chris_codex", env)).toBe(path.join(root, "chris_codex"));
  });
});

describe("vault root", () => {
  it("defaults to the fixed sysops root", () => {
    expect(resolveVaultRoot({})).toBe(DEFAULT_CODEX_VAULT_ROOT);
  });

  it("honours the root override", () => {
    expect(resolveVaultRoot(env)).toBe(path.resolve(root));
  });
});

describe("ensureVaultDir", () => {
  it("creates a private directory and seeds config.toml", async () => {
    const dir = await ensureVaultDir("chris_codex", env);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, "config.toml"))).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing group-writable directory", async () => {
    const dir = path.join(root, "loose_vault");
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o775);
    await ensureVaultDir("loose_vault", env);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("never overwrites an existing config.toml", async () => {
    const dir = await ensureVaultDir("chris_codex", env);
    await fs.writeFile(path.join(dir, "config.toml"), "custom = true\n");
    await ensureVaultDir("chris_codex", env);
    expect(await fs.readFile(path.join(dir, "config.toml"), "utf8")).toBe("custom = true\n");
  });

  it("never touches auth.json", async () => {
    const dir = await ensureVaultDir("chris_codex", env);
    await fs.writeFile(path.join(dir, "auth.json"), SUBSCRIPTION_AUTH, { mode: 0o600 });
    await ensureVaultDir("chris_codex", env);
    expect(await fs.readFile(path.join(dir, "auth.json"), "utf8")).toBe(SUBSCRIPTION_AUTH);
  });
});

describe("readVaultSummary", () => {
  it("reports a usable subscription credential without leaking the account id", async () => {
    const dir = await ensureVaultDir("chris_codex", env);
    await fs.writeFile(path.join(dir, "auth.json"), SUBSCRIPTION_AUTH, { mode: 0o600 });
    const summary = await readVaultSummary("chris_codex", env);
    expect(summary.hasCredential).toBe(true);
    expect(summary.authMode).toBe("chatgpt");
    expect(summary.accountSuffix).toBe("ef0123456789");
    expect(summary.lastRefresh).toBe("2026-08-24T14:28:52Z");
    // The full account id must never appear in a non-secret summary.
    expect(JSON.stringify(summary)).not.toContain("abcdef01-2345-6789");
    // Nor may any token byte.
    for (const secret of ["id", "access", "refresh"]) {
      expect(summary.accountSuffix).not.toBe(secret);
    }
  });

  it("reports an api-key credential as usable", async () => {
    const dir = await ensureVaultDir("keyed", env);
    await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
    expect((await readVaultSummary("keyed", env)).hasCredential).toBe(true);
  });

  it("treats an absent, malformed, or half-written credential as unusable", async () => {
    await ensureVaultDir("empty", env);
    expect((await readVaultSummary("empty", env)).hasCredential).toBe(false);

    const bad = await ensureVaultDir("bad", env);
    await fs.writeFile(path.join(bad, "auth.json"), "{not json");
    expect((await readVaultSummary("bad", env)).hasCredential).toBe(false);

    const partial = await ensureVaultDir("partial", env);
    // An account id with no token material is not usable.
    await fs.writeFile(
      path.join(partial, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "abc" } }),
    );
    expect((await readVaultSummary("partial", env)).hasCredential).toBe(false);
  });
});

describe("listVaults", () => {
  it("lists valid vaults sorted and ignores unrelated entries", async () => {
    await ensureVaultDir("zeta", env);
    await ensureVaultDir("alpha", env);
    await fs.mkdir(path.join(root, "Not A Vault"), { recursive: true });
    await fs.writeFile(path.join(root, "loose-file"), "x");
    expect((await listVaults(env)).map((vault) => vault.name)).toEqual(["alpha", "zeta"]);
  });

  it("lists empty when the root does not exist", async () => {
    const absent = { [CODEX_VAULT_ROOT_ENV_KEY]: path.join(root, "absent") };
    expect(await listVaults(absent)).toEqual([]);
  });
});

describe("removing a credential", () => {
  it("removes auth.json and keeps the vault usable", async () => {
    const dir = await ensureVaultDir("keeper", env);
    await promoteVaultCredential("keeper", Buffer.from(SUBSCRIPTION_AUTH), env);
    await expect(readVaultSummary("keeper", env)).resolves.toMatchObject({ hasCredential: true });

    await expect(removeVaultCredential("keeper", env)).resolves.toBe(true);

    // The credential is gone...
    await expect(fs.access(path.join(dir, "auth.json"))).rejects.toThrow();
    // ...but the vault, its path, and its config survive, so an agent pointed at
    // this CODEX_HOME still resolves and a later sign-in restores it.
    await expect(fs.access(path.join(dir, "config.toml"))).resolves.toBeUndefined();
    const summary = await readVaultSummary("keeper", env);
    expect(summary).toMatchObject({ name: "keeper", dir, hasCredential: false, accountSuffix: null });
    expect(await listVaults(env)).toHaveLength(1);
  });

  it("is idempotent when there is no credential", async () => {
    await ensureVaultDir("empty", env);
    await expect(removeVaultCredential("empty", env)).resolves.toBe(false);
    await expect(removeVaultCredential("empty", env)).resolves.toBe(false);
  });

  it("returns false for a vault directory that does not exist", async () => {
    // Regression: this used to reach the directory lock, whose realpath throws
    // ENOENT, so a sign-out against a missing vault surfaced as a 500 rather
    // than a not-found. The earlier idempotency test missed it because it
    // created the directory first.
    await expect(removeVaultCredential("never_created", env)).resolves.toBe(false);
  });

  it("reports vault existence, so callers can tell no-vault from no-credential", async () => {
    await expect(vaultExists("absent", env)).resolves.toBe(false);
    await ensureVaultDir("present", env);
    await expect(vaultExists("present", env)).resolves.toBe(true);
  });

  it("re-signing in after a removal restores the credential", async () => {
    await ensureVaultDir("cycle", env);
    await promoteVaultCredential("cycle", Buffer.from(SUBSCRIPTION_AUTH), env);
    await removeVaultCredential("cycle", env);
    await promoteVaultCredential("cycle", Buffer.from(SUBSCRIPTION_AUTH), env);
    expect(await readVaultSummary("cycle", env)).toMatchObject({ hasCredential: true });
  });

  it("rejects a traversing name instead of unlinking outside the root", async () => {
    await expect(removeVaultCredential("../escape", env)).rejects.toThrow(CODEX_VAULT_NAME_INVALID);
  });
});

describe("deleting a vault", () => {
  it("removes the whole directory and leaves its siblings alone", async () => {
    const doomed = await ensureVaultDir("doomed", env);
    const survivor = await ensureVaultDir("survivor", env);
    await promoteVaultCredential("doomed", Buffer.from(SUBSCRIPTION_AUTH), env);
    await promoteVaultCredential("survivor", Buffer.from(SUBSCRIPTION_AUTH), env);

    await expect(deleteVault("doomed", env)).resolves.toBe(true);

    await expect(fs.access(doomed)).rejects.toThrow();
    await expect(fs.access(survivor)).resolves.toBeUndefined();
    const remaining = await listVaults(env);
    expect(remaining.map((vault) => vault.name)).toEqual(["survivor"]);
    expect(remaining[0]).toMatchObject({ hasCredential: true });
  });

  it("removes a vault holding extra state, not just the known files", async () => {
    const dir = await ensureVaultDir("stateful", env);
    await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
    await fs.writeFile(path.join(dir, "sessions", "a.json"), "{}");
    await fs.writeFile(path.join(dir, "history.jsonl"), "{}\n");
    await expect(deleteVault("stateful", env)).resolves.toBe(true);
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it("reports false for a vault that does not exist", async () => {
    await expect(deleteVault("ghost", env)).resolves.toBe(false);
  });

  it("refuses a traversing name rather than removing a directory outside the root", async () => {
    // The guard matters more here than anywhere else in the module: this is the
    // one call that recursively destroys a directory.
    const outside = path.join(root, "..", "not-a-vault");
    await fs.mkdir(outside, { recursive: true });
    try {
      await expect(deleteVault("../not-a-vault", env)).rejects.toThrow(CODEX_VAULT_NAME_INVALID);
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
