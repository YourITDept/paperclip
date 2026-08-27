import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  ClaudeVaultCodeUnexpectedError,
  ClaudeVaultLoginConflictError,
  ClaudeVaultNameInvalidError,
  ClaudeVaultNotFoundError,
  claudeVaultLoginService,
  type ClaudeVaultLoginActor,
  type ClaudeVaultLoginSessionView,
} from "../services/claude-vault-login-service.js";

// The goal this service exists for: one Paperclip instance provisioning SEVERAL
// Claude identities, so several agents can each run as a different account.
//
// The tests drive the real service against a fake `claude` binary that reproduces
// the captured setup-token screens. Everything below the fake — the host
// pseudo-terminal, the shared login PTY transport, the setup-token runner, its
// prompt parser and token binder, and the atomic promotion into the vault — is
// the production path.
//
// The shape that makes this login different from the Codex one is exercised
// directly: the fake blocks on stdin after printing the prompt, so a test that
// never calls `submitCode` cannot reach the token. The round trip is real.

const CLAUDE_VAULT_ROOT_ENV_KEY = "PAPERCLIP_CLAUDE_VAULT_ROOT";

let root: string;
let scratch: string;
let env: NodeJS.ProcessEnv;
let service: ReturnType<typeof claudeVaultLoginService>;

const ADMIN: ClaudeVaultLoginActor = { actorType: "user", actorId: "admin-1" };
const OTHER_ADMIN_ID = "admin-2";

// The service only uses the db for audit fan-out and the advisory bound-agent
// count, and both are best-effort. A stub proves neither breaks provisioning.
const stubDb = {} as unknown as Db;

/** A well-formed authorization URL. The query keys match the parser contract. */
const VALID_URL =
  "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";

/**
 * A fake `claude` that reproduces the captured login: it prints the sign-in URL
 * and the prompt, **blocks on stdin for the browser code**, then prints the
 * success screen carrying a synthetic token. No real token is present.
 *
 * The tail must be at least 20 characters: the parser's FULL_TOKEN_RE rejects a
 * bare prefix and a short, noisy candidate, so a shorter fake silently fails to
 * bind and the login reports a plain failure.
 */
async function fakeClaudeFor(tokenTail: string, label: string): Promise<string> {
  const token = `sk-ant-oat01-${tokenTail}`;
  const file = path.join(scratch, `claude-${label}`);
  await fs.writeFile(
    file,
    `#!/bin/sh
cat <<'PROMPT'
Welcome to Claude Code
Browser didn't open? Use the url below to sign in (c to copy)
${VALID_URL}
Paste code here if prompted >
PROMPT
# The round trip: nothing further is printed until a code arrives on stdin.
read _code
cat <<'SUCCESS'

Your OAuth token (valid for 1 year):

${token}

Store this token securely. You won't be able to see it again.
SUCCESS
`,
    { mode: 0o700 },
  );
  return file;
}

/** A fake claude that fails the way a declined or expired login does. */
async function failingClaude(label: string): Promise<string> {
  const file = path.join(scratch, `claude-fail-${label}`);
  await fs.writeFile(file, `#!/bin/sh\necho 'login failed' >&2\nexit 1\n`, { mode: 0o700 });
  return file;
}

/** Polls a session until it reaches `state`, or throws. */
async function waitFor(
  sessionId: string,
  state: ClaudeVaultLoginSessionView["state"] | "terminal",
  ownerUserId = ADMIN.actorId,
): Promise<ClaudeVaultLoginSessionView> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const session = service.read(sessionId, ownerUserId);
    if (session) {
      const terminal = session.state === "success" || session.state === "failed";
      if (state === "terminal" ? terminal : session.state === state) return session;
      if (terminal) return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`login session never reached ${state}`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-vault-svc-root-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "claude-vault-svc-bin-"));
  env = { ...process.env, [CLAUDE_VAULT_ROOT_ENV_KEY]: root };
  service = claudeVaultLoginService(stubDb);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("provisioning multiple Claude accounts", () => {
  it("completes the code round trip and stores the credential", async () => {
    const started = await service.start(
      {
        vaultName: "acct_one",
        startedByUserId: ADMIN.actorId,
        claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "one"),
        env,
      },
      ADMIN,
    );

    // The login stops at the prompt and waits. This is the state a Codex device
    // login never has.
    const waiting = await waitFor(started.sessionId, "waiting_for_code");
    expect(waiting.state).toBe("waiting_for_code");
    expect(waiting.url).toBe(VALID_URL);
    expect(waiting.codeSubmitted).toBe(false);

    service.submitCode(started.sessionId, ADMIN.actorId, "BROWSER-CODE-1");
    expect((await waitFor(started.sessionId, "terminal")).state).toBe("success");

    const vaults = await service.list(env);
    expect(vaults).toHaveLength(1);
    expect(vaults[0]).toMatchObject({
      name: "acct_one",
      hasCredential: true,
      authMode: "setup_token",
      tokenSuffix: "AAAABBBBCCCCDDDDEEEE1111".slice(-8),
    });
  });

  it("keeps two accounts distinct on disk", async () => {
    for (const [name, tail, label] of [
      ["acct_one", "AAAABBBBCCCCDDDDEEEE1111", "one"],
      ["acct_two", "DDDDEEEEFFFFGGGGHHHH2222", "two"],
    ] as const) {
      const started = await service.start(
        { vaultName: name, startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor(tail, label), env },
        ADMIN,
      );
      await waitFor(started.sessionId, "waiting_for_code");
      service.submitCode(started.sessionId, ADMIN.actorId, "BROWSER-CODE");
      expect((await waitFor(started.sessionId, "terminal")).state).toBe("success");
    }

    const vaults = await service.list(env);
    expect(vaults.map((v) => v.name)).toEqual(["acct_one", "acct_two"]);
    expect(vaults[0].tokenSuffix).not.toBe(vaults[1].tokenSuffix);
  });

  it("never writes into the vault when the login fails", async () => {
    await service.create("untouched", ADMIN, env);
    const started = await service.start(
      {
        vaultName: "untouched",
        startedByUserId: ADMIN.actorId,
        claudeCommand: await failingClaude("x"),
        env,
      },
      ADMIN,
    );
    expect((await waitFor(started.sessionId, "terminal")).state).toBe("failed");
    // The login runs against a private staging directory, so a failure leaves the
    // vault exactly as it was.
    expect(await service.list(env)).toMatchObject([{ name: "untouched", hasCredential: false }]);
  });

  it("leaves an existing credential byte-identical when a re-login fails", async () => {
    const first = await service.start(
      { vaultName: "stable", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "s1"), env },
      ADMIN,
    );
    await waitFor(first.sessionId, "waiting_for_code");
    service.submitCode(first.sessionId, ADMIN.actorId, "CODE");
    await waitFor(first.sessionId, "terminal");
    const before = await fs.readFile(path.join(root, "stable", ".credentials.json"), "utf8");

    const second = await service.start(
      { vaultName: "stable", startedByUserId: ADMIN.actorId, claudeCommand: await failingClaude("s2"), env },
      ADMIN,
    );
    expect((await waitFor(second.sessionId, "terminal")).state).toBe("failed");
    expect(await fs.readFile(path.join(root, "stable", ".credentials.json"), "utf8")).toBe(before);
  });
});

describe("session lifecycle and authorization", () => {
  it("refuses a second concurrent login for the same vault but allows another", async () => {
    const first = await service.start(
      { vaultName: "busy", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "b1"), env },
      ADMIN,
    );
    await waitFor(first.sessionId, "waiting_for_code");

    await expect(
      service.start({ vaultName: "busy", startedByUserId: ADMIN.actorId, env }, ADMIN),
    ).rejects.toBeInstanceOf(ClaudeVaultLoginConflictError);

    // Parallel provisioning of a different account is the point.
    const other = await service.start(
      { vaultName: "other", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("DDDDEEEEFFFFGGGGHHHH2222", "b2"), env },
      ADMIN,
    );
    await waitFor(other.sessionId, "waiting_for_code");
    service.cancel(first.sessionId, ADMIN.actorId);
    service.cancel(other.sessionId, ADMIN.actorId);
  });

  it("hides a session from another admin, and refuses their code", async () => {
    const started = await service.start(
      { vaultName: "owned", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "o1"), env },
      ADMIN,
    );
    await waitFor(started.sessionId, "waiting_for_code");
    // A non-owner gets null, which the route turns into a 404 rather than a 403,
    // so the existence of another admin's session is not disclosed.
    expect(service.read(started.sessionId, OTHER_ADMIN_ID)).toBeNull();
    expect(service.submitCode(started.sessionId, OTHER_ADMIN_ID, "CODE")).toBeNull();
    expect(service.cancel(started.sessionId, OTHER_ADMIN_ID)).toBeNull();
    service.cancel(started.sessionId, ADMIN.actorId);
  });

  it("accepts a code once and refuses a replay", async () => {
    const started = await service.start(
      { vaultName: "once", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "r1"), env },
      ADMIN,
    );
    await waitFor(started.sessionId, "waiting_for_code");
    service.submitCode(started.sessionId, ADMIN.actorId, "CODE-1");
    expect(() => service.submitCode(started.sessionId, ADMIN.actorId, "CODE-2")).toThrow(
      ClaudeVaultCodeUnexpectedError,
    );
    await waitFor(started.sessionId, "terminal");
  });

  it("refuses a code for a session that never reached the prompt", async () => {
    const started = await service.start(
      { vaultName: "early", startedByUserId: ADMIN.actorId, claudeCommand: await failingClaude("e1"), env },
      ADMIN,
    );
    await waitFor(started.sessionId, "terminal");
    expect(() => service.submitCode(started.sessionId, ADMIN.actorId, "CODE")).toThrow(
      ClaudeVaultCodeUnexpectedError,
    );
  });

  it("cancelling a waiting login ends it without writing a credential", async () => {
    const started = await service.start(
      { vaultName: "cancelled", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "c1"), env },
      ADMIN,
    );
    await waitFor(started.sessionId, "waiting_for_code");
    const view = service.cancel(started.sessionId, ADMIN.actorId);
    expect(view?.state).toBe("failed");
    expect(await service.list(env)).toMatchObject([{ name: "cancelled", hasCredential: false }]);
  });

  it("drops the URL once the session is terminal, so it cannot be replayed", async () => {
    const started = await service.start(
      { vaultName: "dropped", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "d1"), env },
      ADMIN,
    );
    await waitFor(started.sessionId, "waiting_for_code");
    service.cancel(started.sessionId, ADMIN.actorId);
    expect(service.read(started.sessionId, ADMIN.actorId)?.url).toBeNull();
  });
});

describe("removing an authorization", () => {
  async function signIn(name: string, tail: string, label: string): Promise<void> {
    const started = await service.start(
      { vaultName: name, startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor(tail, label), env },
      ADMIN,
    );
    await waitFor(started.sessionId, "waiting_for_code");
    service.submitCode(started.sessionId, ADMIN.actorId, "CODE");
    expect((await waitFor(started.sessionId, "terminal")).state).toBe("success");
  }

  it("signs a vault out, keeping the directory, and lets it be signed in again", async () => {
    await signIn("revocable", "AAAABBBBCCCCDDDDEEEE1111", "rev");

    const after = await service.removeCredential("revocable", ADMIN, env);
    expect(after).toMatchObject({ name: "revocable", hasCredential: false, tokenSuffix: null });
    await expect(fs.access(path.join(root, "revocable", "settings.json"))).resolves.toBeUndefined();

    await signIn("revocable", "DDDDEEEEFFFFGGGGHHHH2222", "rev2");
    expect((await service.list(env))[0]).toMatchObject({ hasCredential: true });
  });

  it("signing one vault out leaves the other account untouched", async () => {
    await signIn("keep_me", "AAAABBBBCCCCDDDDEEEE1111", "keep");
    await signIn("drop_me", "DDDDEEEEFFFFGGGGHHHH2222", "drop");

    await service.removeCredential("drop_me", ADMIN, env);

    const vaults = await service.list(env);
    expect(vaults.find((v) => v.name === "keep_me")).toMatchObject({ hasCredential: true });
    expect(vaults.find((v) => v.name === "drop_me")).toMatchObject({ hasCredential: false });
  });

  it("deletes a vault outright and drops it from the listing", async () => {
    await signIn("temporary", "AAAABBBBCCCCDDDDEEEE1111", "tmp");
    await expect(service.remove("temporary", ADMIN, env)).resolves.toEqual({
      name: "temporary",
      deleted: true,
    });
    expect(await service.list(env)).toEqual([]);
    await expect(fs.access(path.join(root, "temporary"))).rejects.toThrow();
  });

  it("signing out a vault that does not exist is a not-found, not a crash", async () => {
    await expect(service.removeCredential("never_created", ADMIN, env)).rejects.toBeInstanceOf(
      ClaudeVaultNotFoundError,
    );
    await service.create("exists_but_empty", ADMIN, env);
    await expect(service.removeCredential("exists_but_empty", ADMIN, env)).resolves.toMatchObject({
      hasCredential: false,
    });
  });

  it("reports deleted:false for a vault that was never provisioned", async () => {
    await expect(service.remove("never_existed", ADMIN, env)).resolves.toEqual({
      name: "never_existed",
      deleted: false,
    });
  });

  it("refuses both removals while a login for that vault is in flight", async () => {
    const started = await service.start(
      { vaultName: "busy_vault", startedByUserId: ADMIN.actorId, claudeCommand: await fakeClaudeFor("AAAABBBBCCCCDDDDEEEE1111", "bv"), env },
      ADMIN,
    );
    await waitFor(started.sessionId, "waiting_for_code");

    await expect(service.removeCredential("busy_vault", ADMIN, env)).rejects.toBeInstanceOf(
      ClaudeVaultLoginConflictError,
    );
    await expect(service.remove("busy_vault", ADMIN, env)).rejects.toBeInstanceOf(
      ClaudeVaultLoginConflictError,
    );

    service.cancel(started.sessionId, ADMIN.actorId);
    await waitFor(started.sessionId, "terminal");
    await expect(service.remove("busy_vault", ADMIN, env)).resolves.toMatchObject({ deleted: true });
  });

  it("rejects an invalid name on both removal paths", async () => {
    await expect(service.removeCredential("../escape", ADMIN, env)).rejects.toBeInstanceOf(
      ClaudeVaultNameInvalidError,
    );
    await expect(service.remove("../escape", ADMIN, env)).rejects.toBeInstanceOf(
      ClaudeVaultNameInvalidError,
    );
  });

  it("degrades the bound-agent warning to empty rather than failing when the db is unavailable", async () => {
    await service.create("unbound", ADMIN, env);
    await expect(service.agentsUsing("unbound", env)).resolves.toEqual([]);
    await expect(service.listWithUsage(env)).resolves.toMatchObject([{ boundAgentCount: 0 }]);
    await expect(service.remove("unbound", ADMIN, env)).resolves.toMatchObject({ deleted: true });
  });
});
