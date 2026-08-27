import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  VaultLoginConflictError,
  VaultNameInvalidError,
  VaultNotFoundError,
  codexVaultLoginService,
  type VaultLoginActor,
  type VaultLoginSessionView,
} from "../services/codex-vault-login-service.js";

// The goal this service exists for: one Paperclip instance provisioning SEVERAL
// Codex identities, so several agents can each run as a different account.
//
// The tests drive the real service against a fake `codex` binary that reproduces
// the captured device-login prompt. Everything below the fake — the host
// pseudo-terminal, the prompt parser, the descriptor-bound credential read, the
// atomic promotion into the vault — is the production path.

const CODEX_VAULT_ROOT_ENV_KEY = "PAPERCLIP_CODEX_VAULT_ROOT";

let root: string;
let scratch: string;
let env: NodeJS.ProcessEnv;
let service: ReturnType<typeof codexVaultLoginService>;

const ADMIN: VaultLoginActor = { actorType: "user", actorId: "admin-1" };
const OTHER_ADMIN_ID = "admin-2";

// The service only uses the db for audit fan-out, and every audit call is
// best-effort. A stub proves audit failures never break provisioning.
const stubDb = {} as unknown as Db;

const PROMPT_LINES = [
  "1. Open this link in your browser and sign in to your account",
  "https://auth.openai.com/codex/device",
  "2. Enter this one-time code (expires in 15 minutes)",
  "WXYZ-12345",
  "Device codes are a common phishing target. Never share this code.",
].join("\n");

/** A fake codex that prints the real prompt then writes a credential. */
async function fakeCodexFor(accountId: string, label: string): Promise<string> {
  const auth = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `id-${label}`,
      access_token: `access-${label}`,
      refresh_token: `refresh-${label}`,
      account_id: accountId,
    },
    last_refresh: "2026-08-24T14:28:52Z",
  });
  const file = path.join(scratch, `codex-${label}`);
  await fs.writeFile(
    file,
    `#!/bin/sh\ncat <<'PROMPT'\n${PROMPT_LINES}\nPROMPT\n` +
      `printf '%s' '${auth}' > "$CODEX_HOME/auth.json"\n` +
      `chmod 600 "$CODEX_HOME/auth.json"\n`,
    { mode: 0o700 },
  );
  return file;
}

/** A fake codex that fails the way a declined or expired login does. */
async function failingCodex(label: string): Promise<string> {
  const file = path.join(scratch, `codex-fail-${label}`);
  await fs.writeFile(file, `#!/bin/sh\necho 'login failed' >&2\nexit 1\n`, { mode: 0o700 });
  return file;
}

/** Polls a session to a terminal state. */
async function settle(sessionId: string, ownerUserId = ADMIN.actorId): Promise<VaultLoginSessionView> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = service.read(sessionId, ownerUserId);
    if (session && (session.state === "success" || session.state === "failed")) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("login session never reached a terminal state");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-svc-root-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vault-svc-bin-"));
  env = { ...process.env, [CODEX_VAULT_ROOT_ENV_KEY]: root };
  service = codexVaultLoginService(stubDb);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("provisioning multiple Codex accounts", () => {
  it("creates independent vaults holding different identities", async () => {
    const first = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("11111111-1111-1111-1111-aaaaaaaaaaaa", "one"),
        env,
      },
      ADMIN,
    );
    expect((await settle(first.sessionId)).state).toBe("success");

    const second = await service.start(
      {
        vaultName: "acct_two",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("22222222-2222-2222-2222-bbbbbbbbbbbb", "two"),
        env,
      },
      ADMIN,
    );
    expect((await settle(second.sessionId)).state).toBe("success");

    const vaults = await service.list(env);
    expect(vaults.map((vault) => vault.name)).toEqual(["acct_one", "acct_two"]);
    expect(vaults.every((vault) => vault.hasCredential)).toBe(true);

    // Two different accounts, kept apart.
    const [one, two] = vaults;
    expect(one.accountSuffix).toBe("aaaaaaaaaaaa");
    expect(two.accountSuffix).toBe("bbbbbbbbbbbb");
    expect(one.accountSuffix).not.toBe(two.accountSuffix);

    // And on disk, two distinct credentials.
    const readAuth = async (name: string) =>
      JSON.parse(await fs.readFile(path.join(root, name, "auth.json"), "utf8"));
    expect((await readAuth("acct_one")).tokens.refresh_token).toBe("refresh-one");
    expect((await readAuth("acct_two")).tokens.refresh_token).toBe("refresh-two");
  });

  it("re-logging into a vault replaces that identity and leaves others alone", async () => {
    const first = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("11111111-1111-1111-1111-aaaaaaaaaaaa", "one"),
        env,
      },
      ADMIN,
    );
    await settle(first.sessionId);
    const other = await service.start(
      {
        vaultName: "acct_two",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("22222222-2222-2222-2222-bbbbbbbbbbbb", "two"),
        env,
      },
      ADMIN,
    );
    await settle(other.sessionId);

    // Sign in to acct_one again, this time as a different account.
    const again = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("33333333-3333-3333-3333-cccccccccccc", "three"),
        env,
      },
      ADMIN,
    );
    expect((await settle(again.sessionId)).state).toBe("success");

    const vaults = await service.list(env);
    expect(vaults.find((vault) => vault.name === "acct_one")?.accountSuffix).toBe("cccccccccccc");
    // The untouched vault must be exactly as it was.
    expect(vaults.find((vault) => vault.name === "acct_two")?.accountSuffix).toBe("bbbbbbbbbbbb");
  });
});

describe("login session lifecycle", () => {
  it("surfaces the one-time prompt then clears it on completion", async () => {
    const started = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("11111111-1111-1111-1111-aaaaaaaaaaaa", "one"),
        env,
      },
      ADMIN,
    );
    expect(started.state).toBe("starting");

    // The prompt appears while the login is waiting.
    let sawPrompt: VaultLoginSessionView | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const session = service.read(started.sessionId, ADMIN.actorId);
      if (session?.code) {
        sawPrompt = session;
        break;
      }
      if (session?.state === "success" || session?.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sawPrompt?.url).toBe("https://auth.openai.com/codex/device");
    expect(sawPrompt?.code).toBe("WXYZ-12345");
    expect(sawPrompt?.expiresAt).toBeGreaterThan(Date.now());

    // Once terminal the one-time prompt is dropped, so it cannot be replayed.
    const done = await settle(started.sessionId);
    expect(done.state).toBe("success");
    expect(done.url).toBeNull();
    expect(done.code).toBeNull();
  });

  it("refuses a second concurrent login for the same vault", async () => {
    const slow = path.join(scratch, "codex-slow");
    await fs.writeFile(slow, `#!/bin/sh\nsleep 2\nexit 1\n`, { mode: 0o700 });
    const first = await service.start(
      { vaultName: "acct_one", startedByUserId: ADMIN.actorId, codexCommand: slow, env },
      ADMIN,
    );
    await expect(
      service.start(
        { vaultName: "acct_one", startedByUserId: ADMIN.actorId, codexCommand: slow, env },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(VaultLoginConflictError);

    // A different vault is unaffected — provisioning accounts in parallel is the
    // whole point.
    const other = await service.start(
      {
        vaultName: "acct_two",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("22222222-2222-2222-2222-bbbbbbbbbbbb", "two"),
        env,
      },
      ADMIN,
    );
    expect((await settle(other.sessionId)).state).toBe("success");

    service.cancel(first.sessionId, ADMIN.actorId);
    await settle(first.sessionId);
  });

  it("releases the vault after a login finishes, so a retry can start", async () => {
    const failing = await failingCodex("retry");
    const first = await service.start(
      { vaultName: "acct_one", startedByUserId: ADMIN.actorId, codexCommand: failing, env },
      ADMIN,
    );
    expect((await settle(first.sessionId)).state).toBe("failed");

    const retry = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("11111111-1111-1111-1111-aaaaaaaaaaaa", "one"),
        env,
      },
      ADMIN,
    );
    expect((await settle(retry.sessionId)).state).toBe("success");
  });

  it("leaves an existing credential intact when a re-login fails", async () => {
    const good = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("11111111-1111-1111-1111-aaaaaaaaaaaa", "one"),
        env,
      },
      ADMIN,
    );
    await settle(good.sessionId);
    const before = await fs.readFile(path.join(root, "acct_one", "auth.json"), "utf8");

    const bad = await service.start(
      { vaultName: "acct_one", startedByUserId: ADMIN.actorId, codexCommand: await failingCodex("x"), env },
      ADMIN,
    );
    expect((await settle(bad.sessionId)).state).toBe("failed");
    // Staging means a failed login never reaches the vault agents are using.
    expect(await fs.readFile(path.join(root, "acct_one", "auth.json"), "utf8")).toBe(before);
  });
});

describe("authorization and validation", () => {
  it("hides a session from an admin who did not start it", async () => {
    const started = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("11111111-1111-1111-1111-aaaaaaaaaaaa", "one"),
        env,
      },
      ADMIN,
    );
    // A one-time code must never appear in another admin's browser.
    expect(service.read(started.sessionId, OTHER_ADMIN_ID)).toBeNull();
    expect(service.cancel(started.sessionId, OTHER_ADMIN_ID)).toBeNull();
    expect(service.read(started.sessionId, ADMIN.actorId)).not.toBeNull();
    await settle(started.sessionId);
  });

  it("rejects malformed vault names before any filesystem work", async () => {
    for (const name of ["../escape", "a/b", "UPPER", "x", "a b", "a;id"]) {
      await expect(
        service.start({ vaultName: name, startedByUserId: ADMIN.actorId, env }, ADMIN),
      ).rejects.toBeInstanceOf(VaultNameInvalidError);
      await expect(service.create(name, ADMIN, env)).rejects.toBeInstanceOf(VaultNameInvalidError);
    }
    expect(await service.list(env)).toEqual([]);
  });

  it("creates an empty vault with no credential", async () => {
    const created = await service.create("staged", ADMIN, env);
    expect(created.hasCredential).toBe(false);
    expect((await fs.stat(path.join(root, "staged"))).mode & 0o777).toBe(0o700);
  });
});

describe("removing an authorization", () => {
  it("signs a vault out, keeping the directory, and lets it be signed in again", async () => {
    const started = await service.start(
      {
        vaultName: "revocable",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("33333333-3333-3333-3333-cccccccccccc", "rev"),
        env,
      },
      ADMIN,
    );
    expect((await settle(started.sessionId)).state).toBe("success");

    const after = await service.removeCredential("revocable", ADMIN, env);
    expect(after).toMatchObject({ name: "revocable", hasCredential: false, accountSuffix: null });

    // The vault is still listed and its directory still exists, so an agent
    // whose CODEX_HOME names it keeps resolving.
    const listed = await service.list(env);
    expect(listed.map((vault) => vault.name)).toEqual(["revocable"]);
    await expect(fs.access(path.join(root, "revocable", "config.toml"))).resolves.toBeUndefined();

    const again = await service.start(
      {
        vaultName: "revocable",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("33333333-3333-3333-3333-cccccccccccc", "rev2"),
        env,
      },
      ADMIN,
    );
    expect((await settle(again.sessionId)).state).toBe("success");
    expect((await service.list(env))[0]).toMatchObject({ hasCredential: true });
  });

  it("signing one vault out leaves the other account untouched", async () => {
    for (const [name, account, label] of [
      ["keep_me", "44444444-4444-4444-4444-dddddddddddd", "keep"],
      ["drop_me", "55555555-5555-5555-5555-eeeeeeeeeeee", "drop"],
    ] as const) {
      const started = await service.start(
        { vaultName: name, startedByUserId: ADMIN.actorId, codexCommand: await fakeCodexFor(account, label), env },
        ADMIN,
      );
      expect((await settle(started.sessionId)).state).toBe("success");
    }

    await service.removeCredential("drop_me", ADMIN, env);

    const vaults = await service.list(env);
    expect(vaults.find((vault) => vault.name === "keep_me")).toMatchObject({
      hasCredential: true,
      accountSuffix: "dddddddddddd",
    });
    expect(vaults.find((vault) => vault.name === "drop_me")).toMatchObject({ hasCredential: false });
  });

  it("deletes a vault outright and drops it from the listing", async () => {
    const started = await service.start(
      {
        vaultName: "temporary",
        startedByUserId: ADMIN.actorId,
        codexCommand: await fakeCodexFor("66666666-6666-6666-6666-ffffffffffff", "tmp"),
        env,
      },
      ADMIN,
    );
    expect((await settle(started.sessionId)).state).toBe("success");

    await expect(service.remove("temporary", ADMIN, env)).resolves.toEqual({
      name: "temporary",
      deleted: true,
    });
    expect(await service.list(env)).toEqual([]);
    await expect(fs.access(path.join(root, "temporary"))).rejects.toThrow();
  });

  it("reports deleted:false for a vault that was never provisioned", async () => {
    await expect(service.remove("never_existed", ADMIN, env)).resolves.toEqual({
      name: "never_existed",
      deleted: false,
    });
  });

  it("refuses both removals while a login for that vault is in flight", async () => {
    // A sign-out or delete racing a device login would race the same credential
    // file, exactly as a second concurrent login would.
    const slowCodex = path.join(scratch, "codex-slow");
    await fs.writeFile(
      slowCodex,
      `#!/bin/sh\ncat <<'PROMPT'\n${PROMPT_LINES}\nPROMPT\nsleep 5\n`,
      { mode: 0o700 },
    );
    const started = await service.start(
      { vaultName: "busy_vault", startedByUserId: ADMIN.actorId, codexCommand: slowCodex, env },
      ADMIN,
    );

    await expect(service.removeCredential("busy_vault", ADMIN, env)).rejects.toBeInstanceOf(
      VaultLoginConflictError,
    );
    await expect(service.remove("busy_vault", ADMIN, env)).rejects.toBeInstanceOf(
      VaultLoginConflictError,
    );

    service.cancel(started.sessionId, ADMIN.actorId);
    await settle(started.sessionId);
    // Once the login is terminal the vault can be removed normally.
    await expect(service.remove("busy_vault", ADMIN, env)).resolves.toMatchObject({ deleted: true });
  });

  it("signing out a vault that does not exist is a not-found, not a crash", async () => {
    // Regression: the missing case reached the directory lock and threw ENOENT,
    // which the route turned into a 500. "No such vault" is a 404; "vault with
    // no credential" stays a success.
    await expect(service.removeCredential("never_created", ADMIN, env)).rejects.toBeInstanceOf(
      VaultNotFoundError,
    );
    await service.create("exists_but_empty", ADMIN, env);
    await expect(service.removeCredential("exists_but_empty", ADMIN, env)).resolves.toMatchObject({
      name: "exists_but_empty",
      hasCredential: false,
    });
  });

  it("rejects an invalid name on both removal paths", async () => {
    await expect(service.removeCredential("../escape", ADMIN, env)).rejects.toBeInstanceOf(
      VaultNameInvalidError,
    );
    await expect(service.remove("../escape", ADMIN, env)).rejects.toBeInstanceOf(
      VaultNameInvalidError,
    );
  });

  it("degrades the bound-agent warning to empty rather than failing when the db is unavailable", async () => {
    // The service here holds a stub db with no query methods. agentsUsing must
    // swallow that: the count is advisory, and an operator must still be able to
    // delete a vault when the agents table cannot be read.
    await service.create("unbound", ADMIN, env);
    await expect(service.agentsUsing("unbound", env)).resolves.toEqual([]);
    await expect(service.listWithUsage(env)).resolves.toMatchObject([{ boundAgentCount: 0 }]);
    await expect(service.remove("unbound", ADMIN, env)).resolves.toMatchObject({ deleted: true });
  });
});
