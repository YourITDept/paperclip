import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HOST_LOGIN_AUTH_READ_ERROR,
  createHostLoginDriver,
  createLoginStagingHome,
  removeLoginStagingHome,
} from "./host-login-pty.js";
import { runDeviceLogin } from "./device-login-runner.js";
import {
  CODEX_VAULT_CREDENTIAL_REJECTED,
  CODEX_VAULT_ROOT_ENV_KEY,
  ensureVaultDir,
  promoteVaultCredential,
  readVaultSummary,
} from "./codex-vault.js";

let staging: string;

beforeEach(async () => {
  staging = await createLoginStagingHome();
});

afterEach(async () => {
  await removeLoginStagingHome(staging);
});

const SUBSCRIPTION_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "id",
    access_token: "access",
    refresh_token: "refresh",
    account_id: "abcdef01-2345-6789-abcd-ef0123456789",
  },
  last_refresh: "2026-08-24T14:28:52Z",
});

// The real Codex prompt, reproduced from the captured fixture. A fake `codex`
// that prints this exercises the whole lane — PTY allocation, streaming, parse,
// exit handling — without contacting OpenAI.
const FAKE_PROMPT = [
  "1. Open this link in your browser and sign in to your account",
  "https://auth.openai.com/codex/device",
  "2. Enter this one-time code (expires in 15 minutes)",
  "WXYZ-12345",
  "Device codes are a common phishing target. Never share this code.",
].join("\n");

/** Writes an executable stub that stands in for the codex binary. */
async function writeFakeCodex(dir: string, body: string): Promise<string> {
  const file = path.join(dir, "fake-codex");
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return file;
}

describe("host login PTY driver", () => {
  it("allocates a real terminal for the login command", async () => {
    const bin = await writeFakeCodex(staging, 'if [ -t 1 ]; then echo TTY_YES; else echo TTY_NO; fi');
    const driver = createHostLoginDriver({ sessionHome: staging, codexCommand: bin });
    let output = "";
    const result = await driver.start("codex login --device-auth", (chunk) => {
      output += chunk;
    });
    await driver.dispose();
    expect(result.exitCode).toBe(0);
    // Without a PTY, Codex prints no prompt at all — this is the property the
    // whole `script(1)` approach exists to provide.
    expect(output).toContain("TTY_YES");
  });

  it("passes CODEX_HOME through the environment, not the command string", async () => {
    const bin = await writeFakeCodex(staging, 'echo "HOME_IS:$CODEX_HOME"');
    const driver = createHostLoginDriver({ sessionHome: staging, codexCommand: bin });
    let output = "";
    await driver.start("codex login --device-auth", (chunk) => {
      output += chunk;
    });
    await driver.dispose();
    expect(output).toContain(`HOME_IS:${staging}`);
  });

  it("propagates a non-zero exit status", async () => {
    const bin = await writeFakeCodex(staging, "exit 7");
    const driver = createHostLoginDriver({ sessionHome: staging, codexCommand: bin });
    const result = await driver.start("codex login --device-auth", () => {});
    await driver.dispose();
    // `script -e` is what makes this work; without it every run reports 0.
    expect(result.exitCode).toBe(7);
  });
});

describe("runDeviceLogin over the host driver", () => {
  it("surfaces the prompt once and reads the credential on success", async () => {
    const authPath = path.join(staging, "auth.json");
    const bin = await writeFakeCodex(
      staging,
      `cat <<'PROMPT'\n${FAKE_PROMPT}\nPROMPT\n` +
        `printf '%s' '${SUBSCRIPTION_AUTH}' > "$CODEX_HOME/auth.json"\n` +
        `chmod 600 "$CODEX_HOME/auth.json"`,
    );
    const driver = createHostLoginDriver({ sessionHome: staging, codexCommand: bin });

    const prompts: Array<{ url: string; code: string }> = [];
    let credential: Buffer | null = null;
    const result = await runDeviceLogin(driver, {
      onPrompt: (prompt) => prompts.push(prompt),
      onCredential: (bytes) => {
        credential = bytes;
      },
      authPath,
      timeoutMs: 30_000,
    });

    expect(result.outcome).toBe("success");
    expect(result.promptSurfaced).toBe(true);
    expect(prompts).toEqual([
      { url: "https://auth.openai.com/codex/device", code: "WXYZ-12345" },
    ]);
    expect(credential).not.toBeNull();
    expect(JSON.parse((credential as unknown as Buffer).toString("utf8")).auth_mode).toBe("chatgpt");
  });

  it("reports failure and reads no credential when the command fails", async () => {
    const bin = await writeFakeCodex(staging, "echo 'something went wrong' >&2\nexit 1");
    const driver = createHostLoginDriver({ sessionHome: staging, codexCommand: bin });
    let credential: Buffer | null = null;
    const result = await runDeviceLogin(driver, {
      onPrompt: () => {},
      onCredential: (bytes) => {
        credential = bytes;
      },
      authPath: path.join(staging, "auth.json"),
      timeoutMs: 30_000,
    });
    expect(result.outcome).toBe("failure");
    expect(credential).toBeNull();
  });
});

describe("descriptor-bound credential read", () => {
  it("rejects a world-readable credential", async () => {
    const file = path.join(staging, "auth.json");
    await fs.writeFile(file, SUBSCRIPTION_AUTH, { mode: 0o644 });
    const driver = createHostLoginDriver({ sessionHome: staging });
    await expect(driver.readFile(file)).rejects.toThrow(HOST_LOGIN_AUTH_READ_ERROR);
  });

  it("rejects a symlinked credential", async () => {
    const real = path.join(staging, "real.json");
    const link = path.join(staging, "auth.json");
    await fs.writeFile(real, SUBSCRIPTION_AUTH, { mode: 0o600 });
    await fs.symlink(real, link);
    const driver = createHostLoginDriver({ sessionHome: staging });
    await expect(driver.readFile(link)).rejects.toThrow(HOST_LOGIN_AUTH_READ_ERROR);
  });

  it("rejects an absent, empty, or oversize credential", async () => {
    const driver = createHostLoginDriver({ sessionHome: staging });
    await expect(driver.readFile(path.join(staging, "missing.json"))).rejects.toThrow(
      HOST_LOGIN_AUTH_READ_ERROR,
    );

    const empty = path.join(staging, "empty.json");
    await fs.writeFile(empty, "", { mode: 0o600 });
    await expect(driver.readFile(empty)).rejects.toThrow(HOST_LOGIN_AUTH_READ_ERROR);

    const big = path.join(staging, "big.json");
    await fs.writeFile(big, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    await expect(driver.readFile(big)).rejects.toThrow(HOST_LOGIN_AUTH_READ_ERROR);
  });

  it("accepts a correctly-moded regular file", async () => {
    const file = path.join(staging, "auth.json");
    await fs.writeFile(file, SUBSCRIPTION_AUTH, { mode: 0o600 });
    const driver = createHostLoginDriver({ sessionHome: staging });
    expect((await driver.readFile(file)).toString("utf8")).toBe(SUBSCRIPTION_AUTH);
  });
});

describe("promoteVaultCredential", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-vault-promote-"));
    env = { [CODEX_VAULT_ROOT_ENV_KEY]: root };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes a private credential into the vault", async () => {
    const written = await promoteVaultCredential("chris_codex", Buffer.from(SUBSCRIPTION_AUTH), env);
    expect((await fs.stat(written)).mode & 0o777).toBe(0o600);
    const summary = await readVaultSummary("chris_codex", env);
    expect(summary.hasCredential).toBe(true);
    expect(summary.authMode).toBe("chatgpt");
  });

  it("replaces an existing credential in place, so live symlinks follow it", async () => {
    const dir = await ensureVaultDir("chris_codex", env);
    const authPath = path.join(dir, "auth.json");
    await fs.writeFile(authPath, JSON.stringify({ OPENAI_API_KEY: "old" }), { mode: 0o600 });

    // An agent home linking the vault credential, as seeding would create.
    const agentHome = await fs.mkdtemp(path.join(root, "agent-"));
    const linked = path.join(agentHome, "auth.json");
    await fs.symlink(authPath, linked);

    await promoteVaultCredential("chris_codex", Buffer.from(SUBSCRIPTION_AUTH), env);

    // The running agent must observe the new credential through its symlink.
    expect(await fs.readFile(linked, "utf8")).toBe(SUBSCRIPTION_AUTH);
    expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
  });

  it("rejects unusable bytes and leaves any existing credential untouched", async () => {
    const dir = await ensureVaultDir("chris_codex", env);
    const authPath = path.join(dir, "auth.json");
    await fs.writeFile(authPath, SUBSCRIPTION_AUTH, { mode: 0o600 });

    for (const bad of ["", "{not json", JSON.stringify({ tokens: { account_id: "a" } })]) {
      await expect(
        promoteVaultCredential("chris_codex", Buffer.from(bad), env),
      ).rejects.toThrow(CODEX_VAULT_CREDENTIAL_REJECTED);
    }
    expect(await fs.readFile(authPath, "utf8")).toBe(SUBSCRIPTION_AUTH);
  });

  it("leaves no temp files behind", async () => {
    await promoteVaultCredential("chris_codex", Buffer.from(SUBSCRIPTION_AUTH), env);
    const entries = await fs.readdir(path.join(root, "chris_codex"));
    expect(entries.filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });
});
