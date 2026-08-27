import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEX_VAULT_NAME_INVALID,
  CODEX_VAULT_ROOT_ENV_KEY,
  DEFAULT_CODEX_VAULT_ROOT,
  ensureVaultDir,
  isValidVaultName,
  listVaults,
  readVaultSummary,
  resolveVaultDir,
  resolveVaultRoot,
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
