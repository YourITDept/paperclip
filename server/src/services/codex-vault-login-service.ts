import { randomUUID } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  CODEX_VAULT_CREDENTIAL_REJECTED,
  createHostLoginDriver,
  createLoginStagingHome,
  deleteVault,
  ensureVaultDir,
  isValidVaultName,
  listVaults,
  promoteVaultCredential,
  readVaultSummary,
  removeVaultCredential,
  resolveVaultDir,
  vaultExists,
  removeLoginStagingHome,
  resolveCodexExecutable,
  CODEX_LOGIN_BIN_ENV_KEY,
  resolveVaultRoot,
  runDeviceLogin,
  CODEX_DEVICE_LOGIN_COMMAND,
  type CodexVaultSummary,
} from "@paperclipai/adapter-codex-local/server";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

// The Codex credential vault login service.
//
// It provisions a named vault — one directory holding one Codex identity's
// durable credential — by running `codex login --device-auth` on a host
// pseudo-terminal, showing the operator the one-time code, and promoting the
// resulting credential into the vault.
//
// Why vaults exist: Codex refresh tokens rotate and are single-use, so several
// agents cannot each hold a copy of one identity's credential without
// invalidating each other. A vault is the single writable credential per
// identity; agent homes symlink it. Provisioning several vaults is how one
// instance runs several agents against several Codex accounts.
//
// Security:
//   - The one-time code and login URL live in memory only. They are never
//     persisted, never logged, and readable only by the user who started the
//     session.
//   - The credential is staged in a private temp home and promoted only after it
//     validates, so a failed login never touches a vault agents are running on.
//   - Activity records carry the vault name and a masked account suffix. They
//     never carry a token, a full account id, a URL, or a code.

/** The device code expires in 15 minutes; the run is capped just past that. */
export const VAULT_LOGIN_TIMEOUT_MS = 16 * 60 * 1000;
/** How long a finished session stays readable before it is swept. */
const TERMINAL_SESSION_TTL_MS = 10 * 60 * 1000;
/** Codex states the code expires in 15 minutes. */
const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * The audit actor for a vault action. It mirrors the fields `logActivity`
 * requires, so a route can pass `getActorInfo(req)` straight through.
 */
export interface VaultLoginActor {
  actorType: LogActivityInput["actorType"];
  actorId: string;
}

export type VaultLoginState = "starting" | "waiting" | "success" | "failed";

/** The owner-visible session view. Only the owner ever receives url/code. */
export interface VaultLoginSessionView {
  sessionId: string;
  vaultName: string;
  state: VaultLoginState;
  url: string | null;
  code: string | null;
  expiresAt: number | null;
  error: string | null;
}

interface VaultLoginSession {
  sessionId: string;
  vaultName: string;
  state: VaultLoginState;
  url: string | null;
  code: string | null;
  expiresAt: number | null;
  error: string | null;
  ownerUserId: string;
  controller: AbortController;
  terminalAt: number | null;
}

/** Thrown when a login is already running for the same vault. */
export class VaultLoginConflictError extends Error {
  constructor(vaultName: string) {
    super(`A login is already running for vault "${vaultName}".`);
    this.name = "VaultLoginConflictError";
  }
}

/** Thrown for a malformed vault name. Carries no candidate bytes. */
export class VaultNameInvalidError extends Error {
  constructor() {
    super(
      "A vault name must be 2-40 characters of lowercase letters, digits, underscore, or hyphen, starting with a letter or digit.",
    );
    this.name = "VaultNameInvalidError";
  }
}

/** Thrown when an action names a vault that does not exist. */
export class VaultNotFoundError extends Error {
  constructor(public readonly vaultName: string) {
    super(`Codex login "${vaultName}" was not found.`);
    this.name = "VaultNotFoundError";
  }
}

export interface StartVaultLoginInput {
  vaultName: string;
  startedByUserId: string;
  /** Overrides the codex executable. Used by tests; never taken from a request. */
  codexCommand?: string;
  env?: NodeJS.ProcessEnv;
}

export function codexVaultLoginService(db: Db) {
  const sessions = new Map<string, VaultLoginSession>();
  // One in-flight login per vault. A second start for the same vault would race
  // the same credential file, so it is refused rather than queued.
  const activeByVault = new Map<string, string>();
  const settings = instanceSettingsService(db);

  /**
   * Records a non-secret activity row on every company. An instance-level action
   * has no single owning company, so it fans out the way the instance settings
   * routes already do, keeping it visible in each company's audit view.
   */
  async function audit(
    action: string,
    vaultName: string,
    actor: VaultLoginActor,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const companyIds = await settings.listCompanyIds().catch(() => [] as string[]);
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action,
          entityType: "codex_vault",
          entityId: vaultName,
          details: { vaultName, ...details },
        }).catch(() => undefined),
      ),
    );
  }

  /**
   * The agents bound to a vault, matched on the exact `CODEX_HOME` string in
   * their persisted adapter config.
   *
   * This is the blast radius of removing a credential or deleting a vault, and
   * it is why the delete confirmation can say something concrete. The match is
   * exact rather than prefix-based because `CODEX_HOME` names the directory
   * itself; an agent pointed at a subdirectory is not using this vault as its
   * home.
   *
   * Never throws into a delete path — an unavailable database yields an empty
   * list, which degrades the warning rather than blocking the operator.
   */
  async function agentsUsingVault(
    vaultName: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ id: string; name: string; companyId: string }[]> {
    if (!isValidVaultName(vaultName)) return [];
    let dir: string;
    try {
      dir = resolveVaultDir(vaultName, env);
    } catch {
      return [];
    }
    try {
      return await db
        .select({ id: agents.id, name: agents.name, companyId: agents.companyId })
        .from(agents)
        .where(sql`${agents.adapterConfig} -> 'env' ->> 'CODEX_HOME' = ${dir}`);
    } catch {
      return [];
    }
  }

  function sweep(): void {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.terminalAt !== null && now - session.terminalAt > TERMINAL_SESSION_TTL_MS) {
        sessions.delete(id);
      }
    }
  }

  function toView(session: VaultLoginSession): VaultLoginSessionView {
    return {
      sessionId: session.sessionId,
      vaultName: session.vaultName,
      state: session.state,
      url: session.url,
      code: session.code,
      expiresAt: session.expiresAt,
      error: session.error,
    };
  }

  function finish(session: VaultLoginSession, state: "success" | "failed", error?: string): void {
    session.state = state;
    // Drop the one-time prompt the moment it can no longer be acted on.
    session.url = null;
    session.code = null;
    session.expiresAt = null;
    session.error = error ?? null;
    session.terminalAt = Date.now();
    activeByVault.delete(session.vaultName);
  }

  return {
    /** The vault root this instance provisions into. */
    vaultRoot(env: NodeJS.ProcessEnv = process.env): string {
      return resolveVaultRoot(env);
    },

    /** Lists every vault and whether it currently holds a usable credential. */
    async list(env: NodeJS.ProcessEnv = process.env): Promise<CodexVaultSummary[]> {
      return listVaults(env);
    },

    /**
     * The listing plus each vault's bound-agent count.
     *
     * One query for every vault rather than one per vault: the directories are
     * resolved up front and matched as a set, so adding vaults does not add
     * round trips. A database error degrades every count to zero rather than
     * failing the page — the counts are advisory, and an operator who cannot
     * list their logins because the agents table is unavailable is worse off
     * than one who sees the logins without warnings.
     */
    async listWithUsage(
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<(CodexVaultSummary & { boundAgentCount: number })[]> {
      const vaults = await listVaults(env);
      if (vaults.length === 0) return [];
      const byDir = new Map(vaults.map((vault) => [vault.dir, 0]));
      try {
        const rows = await db
          .select({ home: sql<string>`${agents.adapterConfig} -> 'env' ->> 'CODEX_HOME'` })
          .from(agents)
          .where(
            sql`${agents.adapterConfig} -> 'env' ->> 'CODEX_HOME' in ${[...byDir.keys()]}`,
          );
        for (const row of rows) {
          if (row.home !== null && byDir.has(row.home)) {
            byDir.set(row.home, (byDir.get(row.home) ?? 0) + 1);
          }
        }
      } catch {
        // counts stay zero
      }
      return vaults.map((vault) => ({ ...vault, boundAgentCount: byDir.get(vault.dir) ?? 0 }));
    },

    /**
     * Creates an empty vault directory with no credential. Useful for staging a
     * name before logging into it; the login also creates the directory.
     */
    async create(
      vaultName: string,
      actor: VaultLoginActor,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<CodexVaultSummary> {
      if (!isValidVaultName(vaultName)) throw new VaultNameInvalidError();
      await ensureVaultDir(vaultName, env);
      await audit("codex.vault.created", vaultName, actor);
      return readVaultSummary(vaultName, env);
    },

    /** The agents bound to this vault. See {@link agentsUsingVault}. */
    agentsUsing: agentsUsingVault,

    /**
     * Removes a vault's credential and leaves everything else in place.
     *
     * This is the reversible "remove the authorization" action: the directory,
     * its `config.toml`, and its path all survive, so an agent pointed at it
     * keeps resolving and a later sign-in restores it. Refused while a login for
     * the same vault is in flight, for the same reason a second login is —
     * both would race the same credential file.
     */
    async removeCredential(
      vaultName: string,
      actor: VaultLoginActor,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<CodexVaultSummary> {
      if (!isValidVaultName(vaultName)) throw new VaultNameInvalidError();
      if (activeByVault.has(vaultName)) throw new VaultLoginConflictError(vaultName);
      // "No such vault" and "vault with no credential" are different answers.
      // The first is a 404; the second is a success, because the caller's intent
      // is already satisfied. Without this the missing case reached the
      // directory lock, whose realpath throws ENOENT, and surfaced as a 500.
      if (!(await vaultExists(vaultName, env))) throw new VaultNotFoundError(vaultName);
      const removed = await removeVaultCredential(vaultName, env);
      // Audited even when there was nothing to remove: the operator pressed the
      // button, and "tried to sign out an already-empty vault" is the kind of
      // thing an audit trail should be able to answer.
      await audit("codex.vault.credential.removed", vaultName, actor, { removed });
      return readVaultSummary(vaultName, env);
    },

    /**
     * Deletes a vault directory outright.
     *
     * Irreversible, and it breaks every agent whose `CODEX_HOME` names this
     * path — {@link agentsUsing} is what the caller should show before asking
     * for confirmation. Refused while a login is in flight so a device login
     * cannot promote a credential into a directory being removed.
     */
    async remove(
      vaultName: string,
      actor: VaultLoginActor,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<{ name: string; deleted: boolean }> {
      if (!isValidVaultName(vaultName)) throw new VaultNameInvalidError();
      if (activeByVault.has(vaultName)) throw new VaultLoginConflictError(vaultName);
      const agentsBound = await agentsUsingVault(vaultName, env);
      const deleted = await deleteVault(vaultName, env);
      await audit("codex.vault.deleted", vaultName, actor, {
        deleted,
        // Recorded because it is the fact you want when an agent starts failing
        // an hour later and nobody remembers the vault existed.
        boundAgentCount: agentsBound.length,
      });
      return { name: vaultName, deleted };
    },

    /**
     * Starts a device login for one vault. Returns as soon as the session exists;
     * the caller polls {@link read} for the prompt and the outcome.
     */
    async start(
      input: StartVaultLoginInput,
      actor: VaultLoginActor,
    ): Promise<VaultLoginSessionView> {
      sweep();
      const { vaultName, startedByUserId } = input;
      if (!isValidVaultName(vaultName)) throw new VaultNameInvalidError();
      if (activeByVault.has(vaultName)) throw new VaultLoginConflictError(vaultName);

      const env = input.env ?? process.env;
      const sessionId = randomUUID();
      const session: VaultLoginSession = {
        sessionId,
        vaultName,
        state: "starting",
        url: null,
        code: null,
        expiresAt: null,
        error: null,
        ownerUserId: startedByUserId,
        controller: new AbortController(),
        terminalAt: null,
      };
      sessions.set(sessionId, session);
      activeByVault.set(vaultName, sessionId);

      await ensureVaultDir(vaultName, env).catch(() => undefined);
      await audit("codex.vault.login.started", vaultName, actor);

      // The login runs detached from the request. Everything below records its
      // outcome on the session; nothing here throws into the caller.
      void (async () => {
        // Preflight the executable. The server frequently runs with a minimal
        // PATH that omits the shell's npm bin directory, and without this the
        // failure surfaces as a generic "login failed" with nothing pointing at
        // the real cause.
        const codexCommand =
          input.codexCommand ?? (await resolveCodexExecutable(env).catch(() => null));
        if (!codexCommand) {
          finish(
            session,
            "failed",
            `Could not find the codex executable. Put it on the server's PATH or set ${CODEX_LOGIN_BIN_ENV_KEY} to its absolute path.`,
          );
          await audit("codex.vault.login.failed", vaultName, actor, { outcome: "codex_not_found" });
          return;
        }
        const staging = await createLoginStagingHome();
        try {
          const driver = createHostLoginDriver({
            sessionHome: staging,
            codexCommand,
            env,
          });
          let credential: Buffer | null = null;
          const result = await runDeviceLogin(driver, {
            command: CODEX_DEVICE_LOGIN_COMMAND,
            timeoutMs: VAULT_LOGIN_TIMEOUT_MS,
            signal: session.controller.signal,
            onPrompt: (prompt) => {
              session.state = "waiting";
              session.url = prompt.url;
              session.code = prompt.code;
              session.expiresAt = Date.now() + CODE_TTL_MS;
            },
            onCredential: (bytes) => {
              credential = bytes;
            },
            authPath: path.join(staging, "auth.json"),
          });

          if (result.outcome !== "success") {
            const reason =
              result.outcome === "timeout"
                ? "The login timed out before it was approved."
                : result.outcome === "cancelled"
                  ? "The login was cancelled."
                  : "Codex ended the login without signing in.";
            finish(session, "failed", reason);
            await audit("codex.vault.login.failed", vaultName, actor, {
              outcome: result.outcome,
            });
            return;
          }
          if (credential === null) {
            finish(session, "failed", "The login finished but produced no credential.");
            await audit("codex.vault.login.failed", vaultName, actor, { outcome: "no_credential" });
            return;
          }

          // Promotion validates the bytes again and writes atomically under the
          // vault lock, so a running agent following the symlink sees either the
          // old credential or the new one.
          await promoteVaultCredential(vaultName, credential, env);
          const summary = await readVaultSummary(vaultName, env);
          finish(session, "success");
          await audit("codex.vault.login.succeeded", vaultName, actor, {
            authMode: summary.authMode,
            // A masked suffix is enough to tell two accounts apart in an audit
            // trail without recording the identity itself.
            accountSuffix: summary.accountSuffix,
          });
        } catch (error) {
          const rejected =
            error instanceof Error && error.message === CODEX_VAULT_CREDENTIAL_REJECTED;
          finish(
            session,
            "failed",
            rejected
              ? "The login produced a credential Codex would not accept."
              : "The login failed before a credential could be stored.",
          );
          await audit("codex.vault.login.failed", vaultName, actor, {
            outcome: rejected ? "credential_rejected" : "error",
          });
        } finally {
          // The staging home holds a real credential until promotion; remove it
          // on every path, including a thrown one.
          await removeLoginStagingHome(staging);
        }
      })();

      return toView(session);
    },

    /**
     * Reads a session. Only the user who started it receives the prompt, so a
     * one-time code never reaches another admin's browser. A non-owner read
     * returns null, which the route renders as a 404.
     */
    read(sessionId: string, ownerUserId: string): VaultLoginSessionView | null {
      sweep();
      const session = sessions.get(sessionId);
      if (!session || session.ownerUserId !== ownerUserId) return null;
      return toView(session);
    },

    /** Cancels an in-flight login. Only the owner may cancel. */
    cancel(sessionId: string, ownerUserId: string): VaultLoginSessionView | null {
      const session = sessions.get(sessionId);
      if (!session || session.ownerUserId !== ownerUserId) return null;
      if (session.terminalAt === null) session.controller.abort();
      return toView(session);
    },
  };
}

export type CodexVaultLoginService = ReturnType<typeof codexVaultLoginService>;
