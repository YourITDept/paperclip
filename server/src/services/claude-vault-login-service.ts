import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  CLAUDE_SETUP_TOKEN_COMMAND,
  createClaudeHostSetupTokenTransport,
  createClaudeLoginStagingDir,
  deleteVault,
  ensureVaultDir,
  isValidVaultName,
  listVaults,
  promoteVaultCredential,
  readVaultSummary,
  removeClaudeLoginStagingDir,
  removeVaultCredential,
  resolveVaultDir,
  resolveVaultRoot,
  runSetupTokenLogin,
  vaultExists,
  type ClaudeVaultSummary,
} from "@paperclipai/adapter-claude-local/server";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

// The Claude credential vault login service.
//
// It is the Claude counterpart of `codex-vault-login-service.ts`, and the shape
// an operator sees is the same: create a named directory, sign in, sign out,
// delete. The login itself is different, and the difference is visible in this
// file's session states.
//
// A Codex device login is one-way: Paperclip shows a URL and a code, the operator
// approves in a browser, and the login completes on its own.
//
// A Claude `setup-token` login is a **round trip**: Paperclip shows an
// authorization URL, the operator signs in and is handed a browser code, and that
// code has to come *back* through Paperclip and be written to the waiting child.
// So this service has a state the Codex one does not — `waiting_for_code` — and
// an extra call, {@link submitCode}, that no Codex vault route needs.
//
// Everything below the session is reused from claude-local unchanged:
// `runSetupTokenLogin` drives the login, the setup-token parser finds the prompt
// and binds the token, and the shared login PTY transport adapts the host session
// into the runner's driver shape. This file owns the session lifecycle, the
// owner-scoping, the staging-then-promote sequence, and the audit trail.

/** The login window. The Claude sign-in screen states a 15-minute code lifetime. */
export const CLAUDE_VAULT_LOGIN_TIMEOUT_MS = 16 * 60 * 1000;

/** How long a finished session stays readable before it is swept. */
const TERMINAL_SESSION_TTL_MS = 10 * 60 * 1000;

export interface ClaudeVaultLoginActor {
  actorType: "user";
  actorId: string;
}

/**
 * `waiting_for_code` is the Claude-specific state: the authorization URL is on
 * screen and the service is holding the child open for the operator's code.
 */
export type ClaudeVaultLoginState = "starting" | "waiting_for_code" | "success" | "failed";

export interface ClaudeVaultLoginSessionView {
  sessionId: string;
  vaultName: string;
  state: ClaudeVaultLoginState;
  /** The authorization URL, shown once while the session is live. */
  url: string | null;
  /** True once a code has been accepted, so the client stops offering the field. */
  codeSubmitted: boolean;
  error: string | null;
}

interface ClaudeVaultLoginSession {
  sessionId: string;
  vaultName: string;
  state: ClaudeVaultLoginState;
  url: string | null;
  codeSubmitted: boolean;
  error: string | null;
  ownerUserId: string;
  controller: AbortController;
  /** Hands the operator's code to the waiting runner. Set once the prompt lands. */
  deliverCode: ((code: string) => void) | null;
  terminalAt: number | null;
}

export class ClaudeVaultLoginConflictError extends Error {
  constructor(public readonly vaultName: string) {
    super(`A Claude login is already in progress for "${vaultName}".`);
    this.name = "ClaudeVaultLoginConflictError";
  }
}

export class ClaudeVaultNameInvalidError extends Error {
  constructor() {
    super(
      "A login name must be 2-40 characters of lowercase letters, digits, underscore, or hyphen, starting with a letter or digit.",
    );
    this.name = "ClaudeVaultNameInvalidError";
  }
}

export class ClaudeVaultNotFoundError extends Error {
  constructor(public readonly vaultName: string) {
    super(`Claude login "${vaultName}" was not found.`);
    this.name = "ClaudeVaultNotFoundError";
  }
}

/** Thrown when a code arrives for a session that is not waiting for one. */
export class ClaudeVaultCodeUnexpectedError extends Error {
  constructor() {
    super("This login is not waiting for a code.");
    this.name = "ClaudeVaultCodeUnexpectedError";
  }
}

export interface StartClaudeVaultLoginInput {
  vaultName: string;
  startedByUserId: string;
  /** Overrides the claude executable. Used by tests; never taken from a request. */
  claudeCommand?: string;
  /** Overrides the `script` binary. Used by tests; never taken from a request. */
  scriptCommand?: string;
  env?: NodeJS.ProcessEnv;
}

export function claudeVaultLoginService(db: Db) {
  const sessions = new Map<string, ClaudeVaultLoginSession>();
  // One in-flight login per vault. A second start would race the same credential
  // file, so it is refused rather than queued.
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
    actor: ClaudeVaultLoginActor,
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
          entityType: "claude_vault",
          entityId: vaultName,
          details: { vaultName, ...details },
        }).catch(() => undefined),
      ),
    );
  }

  /**
   * The agents bound to a vault, matched on the exact `CLAUDE_CONFIG_DIR` string
   * in their persisted adapter config. This is the blast radius of removing a
   * credential or deleting a vault.
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
        .where(sql`${agents.adapterConfig} -> 'env' ->> 'CLAUDE_CONFIG_DIR' = ${dir}`);
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

  function toView(session: ClaudeVaultLoginSession): ClaudeVaultLoginSessionView {
    return {
      sessionId: session.sessionId,
      vaultName: session.vaultName,
      state: session.state,
      url: session.url,
      codeSubmitted: session.codeSubmitted,
      error: session.error,
    };
  }

  function finish(
    session: ClaudeVaultLoginSession,
    state: "success" | "failed",
    error?: string,
  ): void {
    session.state = state;
    // Drop the one-time prompt the moment it can no longer be acted on.
    session.url = null;
    session.deliverCode = null;
    session.error = error ?? null;
    session.terminalAt = Date.now();
    if (activeByVault.get(session.vaultName) === session.sessionId) {
      activeByVault.delete(session.vaultName);
    }
  }

  return {
    vaultRoot(env: NodeJS.ProcessEnv = process.env): string {
      return resolveVaultRoot(env);
    },

    /** Lists every vault and whether it currently holds a usable credential. */
    async list(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeVaultSummary[]> {
      return listVaults(env);
    },

    /**
     * The listing plus each vault's bound-agent count. One query for every vault
     * rather than one per vault. A database error degrades every count to zero
     * rather than failing the page — the counts are advisory.
     */
    async listWithUsage(
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<(ClaudeVaultSummary & { boundAgentCount: number })[]> {
      const vaults = await listVaults(env);
      if (vaults.length === 0) return [];
      const byDir = new Map(vaults.map((vault) => [vault.dir, 0]));
      try {
        const rows = await db
          .select({ home: sql<string>`${agents.adapterConfig} -> 'env' ->> 'CLAUDE_CONFIG_DIR'` })
          .from(agents)
          .where(sql`${agents.adapterConfig} -> 'env' ->> 'CLAUDE_CONFIG_DIR' in ${[...byDir.keys()]}`);
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

    /** The agents bound to this vault. See {@link agentsUsingVault}. */
    agentsUsing: agentsUsingVault,

    /**
     * Creates an empty vault directory with no credential. Useful for staging a
     * name before logging into it; the login also creates the directory.
     */
    async create(
      vaultName: string,
      actor: ClaudeVaultLoginActor,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<ClaudeVaultSummary> {
      if (!isValidVaultName(vaultName)) throw new ClaudeVaultNameInvalidError();
      await ensureVaultDir(vaultName, env);
      await audit("claude.vault.created", vaultName, actor);
      return readVaultSummary(vaultName, env);
    },

    /**
     * Starts a `claude setup-token` login for one vault.
     *
     * The login runs against a **private staging config directory**, never the
     * vault. `setup-token` writes machine metadata into its config directory, and
     * a cancelled or failed login must not touch a vault agents are running
     * against. Only a token that the runner has bound from the success record
     * reaches {@link promoteVaultCredential}, so the vault only ever receives
     * bytes that already passed validation.
     */
    async start(
      input: StartClaudeVaultLoginInput,
      actor: ClaudeVaultLoginActor,
    ): Promise<ClaudeVaultLoginSessionView> {
      sweep();
      const { vaultName, startedByUserId } = input;
      if (!isValidVaultName(vaultName)) throw new ClaudeVaultNameInvalidError();
      if (activeByVault.has(vaultName)) throw new ClaudeVaultLoginConflictError(vaultName);

      const env = input.env ?? process.env;
      const sessionId = randomUUID();
      const session: ClaudeVaultLoginSession = {
        sessionId,
        vaultName,
        state: "starting",
        url: null,
        codeSubmitted: false,
        error: null,
        ownerUserId: startedByUserId,
        controller: new AbortController(),
        deliverCode: null,
        terminalAt: null,
      };
      sessions.set(sessionId, session);
      activeByVault.set(vaultName, sessionId);

      await ensureVaultDir(vaultName, env).catch(() => undefined);
      await audit("claude.vault.login.started", vaultName, actor);

      // The login runs detached from the request. Everything below records its
      // outcome on the session; nothing here throws into the caller.
      void (async () => {
        const stagingDir = await createClaudeLoginStagingDir();
        const transport = createClaudeHostSetupTokenTransport({
          configDir: stagingDir,
          env,
          scriptCommand: input.scriptCommand,
          claudeCommand: input.claudeCommand,
        });

        // Bridge the operator's code from `submitCode` into the runner's
        // `provideCode`. A resolved promise hands it across; an abort rejects it
        // so the runner stops waiting instead of hanging to the timeout.
        const codeReady = new Promise<string>((resolve, reject) => {
          session.deliverCode = resolve;
          const abort = () => reject(new Error("cancelled"));
          if (session.controller.signal.aborted) abort();
          else session.controller.signal.addEventListener("abort", abort, { once: true });
        });
        // The runner rejects when `provideCode` rejects. Consume the pending
        // rejection here too, so a cancel never becomes an unhandled rejection.
        codeReady.catch(() => {});

        try {
          const result = await runSetupTokenLogin(transport, {
            command: CLAUDE_SETUP_TOKEN_COMMAND,
            timeoutMs: CLAUDE_VAULT_LOGIN_TIMEOUT_MS,
            signal: session.controller.signal,
            onPrompt: (prompt) => {
              if (session.state !== "starting") return;
              session.url = prompt.url;
              session.state = "waiting_for_code";
            },
            provideCode: () => codeReady,
            onCredential: async (authBytes) => {
              // The one place the token exists in this service. It is written
              // straight into the vault and never stored on the session, never
              // logged, and never returned to a caller.
              const token = authBytes.toString("utf8").trim();
              await promoteVaultCredential(vaultName, token, env);
            },
            log: () => {},
          });

          if (result.outcome === "success" && result.credentialDelivered) {
            finish(session, "success");
            const summary = await readVaultSummary(vaultName, env).catch(() => null);
            await audit("claude.vault.login.succeeded", vaultName, actor, {
              authMode: summary?.authMode ?? null,
              tokenSuffix: summary?.tokenSuffix ?? null,
            });
          } else {
            finish(session, "failed", "The Claude login did not complete.");
            await audit("claude.vault.login.failed", vaultName, actor, {
              outcome: result.outcome,
            });
          }
        } catch (error) {
          const message =
            error instanceof Error && error.message === "cancelled"
              ? "The login was cancelled."
              : "The Claude login did not complete.";
          finish(session, "failed", message);
          await audit("claude.vault.login.failed", vaultName, actor, { outcome: "error" });
        } finally {
          await transport.dispose().catch(() => undefined);
          // Removed on every path, including failures, so a staging directory
          // never outlives its login.
          await removeClaudeLoginStagingDir(stagingDir);
        }
      })();

      return toView(session);
    },

    /**
     * Reads a login session. Owner-scoped: a non-owner gets `null`, which the
     * route turns into a 404 rather than a 403, so the existence of another
     * admin's session is not disclosed.
     */
    read(sessionId: string, ownerUserId: string): ClaudeVaultLoginSessionView | null {
      const session = sessions.get(sessionId);
      if (!session || session.ownerUserId !== ownerUserId) return null;
      return toView(session);
    },

    /**
     * Hands the operator's browser code to the waiting login. The Claude-specific
     * half of the round trip; there is no Codex equivalent.
     *
     * Accepted exactly once, and only while the session is waiting — a second
     * submission, or one for a session that never reached the prompt, is refused
     * rather than written to a child that is not reading.
     */
    submitCode(
      sessionId: string,
      ownerUserId: string,
      code: string,
    ): ClaudeVaultLoginSessionView | null {
      const session = sessions.get(sessionId);
      if (!session || session.ownerUserId !== ownerUserId) return null;
      if (session.state !== "waiting_for_code" || session.codeSubmitted || !session.deliverCode) {
        throw new ClaudeVaultCodeUnexpectedError();
      }
      session.codeSubmitted = true;
      const deliver = session.deliverCode;
      session.deliverCode = null;
      deliver(code.trim());
      return toView(session);
    },

    /** Cancels an in-flight login. */
    cancel(sessionId: string, ownerUserId: string): ClaudeVaultLoginSessionView | null {
      const session = sessions.get(sessionId);
      if (!session || session.ownerUserId !== ownerUserId) return null;
      if (session.state === "success" || session.state === "failed") return toView(session);
      session.controller.abort();
      finish(session, "failed", "The login was cancelled.");
      return toView(session);
    },

    /**
     * Removes a vault's credential and leaves everything else in place. The
     * reversible "remove the authorization": the directory, its `settings.json`,
     * and its path survive, so an agent pointed at it keeps resolving and a later
     * sign-in restores it. Refused while a login for the same vault is in flight.
     */
    async removeCredential(
      vaultName: string,
      actor: ClaudeVaultLoginActor,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<ClaudeVaultSummary> {
      if (!isValidVaultName(vaultName)) throw new ClaudeVaultNameInvalidError();
      if (activeByVault.has(vaultName)) throw new ClaudeVaultLoginConflictError(vaultName);
      // "No such vault" and "vault with no credential" are different answers. The
      // first is a 404; the second is a success, because the caller's intent is
      // already satisfied.
      if (!(await vaultExists(vaultName, env))) throw new ClaudeVaultNotFoundError(vaultName);
      const removed = await removeVaultCredential(vaultName, env);
      await audit("claude.vault.credential.removed", vaultName, actor, { removed });
      return readVaultSummary(vaultName, env);
    },

    /**
     * Deletes a vault directory outright. Irreversible, and it breaks every agent
     * whose `CLAUDE_CONFIG_DIR` names this path — {@link agentsUsing} is what the
     * caller should show before asking for confirmation.
     */
    async remove(
      vaultName: string,
      actor: ClaudeVaultLoginActor,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<{ name: string; deleted: boolean }> {
      if (!isValidVaultName(vaultName)) throw new ClaudeVaultNameInvalidError();
      if (activeByVault.has(vaultName)) throw new ClaudeVaultLoginConflictError(vaultName);
      const agentsBound = await agentsUsingVault(vaultName, env);
      const deleted = await deleteVault(vaultName, env);
      await audit("claude.vault.deleted", vaultName, actor, {
        deleted,
        boundAgentCount: agentsBound.length,
      });
      return { name: vaultName, deleted };
    },
  };
}

export type ClaudeVaultLoginService = ReturnType<typeof claudeVaultLoginService>;
