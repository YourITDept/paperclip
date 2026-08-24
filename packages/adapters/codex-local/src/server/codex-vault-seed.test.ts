import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CODEX_VAULT_ENV_KEY, CODEX_VAULT_ROOT_ENV_KEY, ensureVaultDir } from "./codex-vault.js";
import { seedManagedCodexHome } from "./codex-home.js";

// The behaviour this whole feature exists for: several agents bound to one named
// vault must share ONE credential file rather than each holding a copy.
//
// Codex refresh tokens rotate and are single-use. Independent copies invalidate
// each other on the next run (`refresh_token_reused`, #5028), which is exactly
// the failure mode a multi-agent setup would hit. Sharing works only if each
// managed home SYMLINKS the vault credential, so a rotation written by whichever
// agent runs first is immediately visible to the others.

let root: string;
let scratch: string;
let env: NodeJS.ProcessEnv;

const noopLog = async () => {};

const AUTH_V1 = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "v1", refresh_token: "r1", account_id: "acct-1" },
  last_refresh: "2026-08-24T10:00:00Z",
});

const AUTH_V2_ROTATED = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "v2", refresh_token: "r2", account_id: "acct-1" },
  last_refresh: "2026-08-24T11:00:00Z",
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-vault-seed-root-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "codex-vault-seed-homes-"));
  env = {
    [CODEX_VAULT_ROOT_ENV_KEY]: root,
    [CODEX_VAULT_ENV_KEY]: "shared_identity",
    // Keep the resolver away from the developer's real ~/.codex.
    CODEX_HOME: path.join(scratch, "unused-shared-home"),
  };
  const vault = await ensureVaultDir("shared_identity", env);
  await fs.writeFile(path.join(vault, "auth.json"), AUTH_V1, { mode: 0o600 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("multiple agents bound to one vault", () => {
  it("symlinks the vault credential into each managed home instead of copying it", async () => {
    const vaultAuth = path.join(root, "shared_identity", "auth.json");
    const homeA = path.join(scratch, "agent-a");
    const homeB = path.join(scratch, "agent-b");

    await seedManagedCodexHome(homeA, env, noopLog);
    await seedManagedCodexHome(homeB, env, noopLog);

    for (const home of [homeA, homeB]) {
      const link = await fs.lstat(path.join(home, "auth.json"));
      expect(link.isSymbolicLink(), `${home} must link, not copy`).toBe(true);
      expect(await fs.realpath(path.join(home, "auth.json"))).toBe(await fs.realpath(vaultAuth));
    }
  });

  it("shows a rotation written by one agent to every other agent at once", async () => {
    const vaultAuth = path.join(root, "shared_identity", "auth.json");
    const homeA = path.join(scratch, "agent-a");
    const homeB = path.join(scratch, "agent-b");
    const homeC = path.join(scratch, "agent-c");

    await seedManagedCodexHome(homeA, env, noopLog);
    await seedManagedCodexHome(homeB, env, noopLog);
    await seedManagedCodexHome(homeC, env, noopLog);

    // Agent A runs first and Codex rotates the refresh token through A's home.
    // The write lands on the vault file because A's entry is a symlink.
    await fs.writeFile(path.join(homeA, "auth.json"), AUTH_V2_ROTATED);
    expect(await fs.readFile(vaultAuth, "utf8")).toBe(AUTH_V2_ROTATED);

    // B and C must now read the rotated credential. With copies they would still
    // hold r1 and fail with refresh_token_reused on their next run.
    for (const home of [homeB, homeC]) {
      expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(AUTH_V2_ROTATED);
    }
  });

  it("keeps distinct vaults isolated from one another", async () => {
    const otherEnv = { ...env, [CODEX_VAULT_ENV_KEY]: "other_identity" };
    const otherVault = await ensureVaultDir("other_identity", otherEnv);
    const otherAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "o1", refresh_token: "or1", account_id: "acct-2" },
    });
    await fs.writeFile(path.join(otherVault, "auth.json"), otherAuth, { mode: 0o600 });

    const homeA = path.join(scratch, "agent-a");
    const homeZ = path.join(scratch, "agent-z");
    await seedManagedCodexHome(homeA, env, noopLog);
    await seedManagedCodexHome(homeZ, otherEnv, noopLog);

    // Rotating one identity must not touch the other.
    await fs.writeFile(path.join(homeA, "auth.json"), AUTH_V2_ROTATED);
    expect(await fs.readFile(path.join(homeZ, "auth.json"), "utf8")).toBe(otherAuth);
    expect(await fs.readFile(path.join(root, "other_identity", "auth.json"), "utf8")).toBe(
      otherAuth,
    );
  });

  it("re-seeding an already-linked home is idempotent", async () => {
    const homeA = path.join(scratch, "agent-a");
    await seedManagedCodexHome(homeA, env, noopLog);
    await fs.writeFile(path.join(homeA, "auth.json"), AUTH_V2_ROTATED);

    // A second run of the same agent must not replace the link or revert the
    // rotated credential.
    await seedManagedCodexHome(homeA, env, noopLog);
    expect((await fs.lstat(path.join(homeA, "auth.json"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(homeA, "auth.json"), "utf8")).toBe(AUTH_V2_ROTATED);
  });

  it("copies config.toml rather than linking it, so a run cannot edit the vault policy", async () => {
    const vaultConfig = path.join(root, "shared_identity", "config.toml");
    await fs.writeFile(vaultConfig, "model = \"gpt-5\"\n");
    const homeA = path.join(scratch, "agent-a");
    await seedManagedCodexHome(homeA, env, noopLog);

    const copied = path.join(homeA, "config.toml");
    expect((await fs.lstat(copied)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(copied, "utf8")).toBe("model = \"gpt-5\"\n");

    // Codex rewrites config.toml in its home during a run; that must stay local.
    await fs.writeFile(copied, "model = \"scribbled\"\n");
    expect(await fs.readFile(vaultConfig, "utf8")).toBe("model = \"gpt-5\"\n");
  });
});
