import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import {
  ClaudeVaultCodeUnexpectedError,
  ClaudeVaultLoginConflictError,
  ClaudeVaultNameInvalidError,
  ClaudeVaultNotFoundError,
  claudeVaultLoginService,
  type ClaudeVaultLoginActor,
} from "../services/claude-vault-login-service.js";
import { getActorInfo } from "./authz.js";

// The Claude credential vault routes.
//
// A vault is one named directory holding one Claude account's credential. An
// agent uses it by setting `env.CLAUDE_CONFIG_DIR` to the directory's full path,
// which Claude reads on both the CLI and ACP engines.
//
// These mirror the Codex vault routes with one addition. The Claude login is a
// round trip — Paperclip shows an authorization URL, the operator signs in and is
// handed a browser code, and that code has to come back — so there is a
// `POST .../login-sessions/:sessionId/code` that the Codex flow has no need for.
//
// Authorization: every route requires instance admin. A vault lives outside every
// company's isolation boundary — the vault root is a host path, not company
// state — so company-scoped permissions are not the right gate. The login session
// is additionally owner-scoped: only the admin who started it can read its URL or
// submit its code.

/**
 * Requires an instance admin. `local_implicit` is the single-user local mode the
 * rest of the instance routes already treat as admin.
 */
function assertCanManageVaults(req: Request): ClaudeVaultLoginActor {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
    throw forbidden("Instance admin access required");
  }
  const actor = getActorInfo(req);
  if (actor.actorType !== "user") {
    throw forbidden("A board user identity is required to manage Claude logins.");
  }
  return { actorType: actor.actorType, actorId: actor.actorId };
}

/** Reads the session owner. The login is bound to the user who started it. */
function ownerId(req: Request): string {
  const actor = getActorInfo(req);
  if (actor.actorType !== "user") {
    throw forbidden("A board user identity is required to manage Claude logins.");
  }
  return actor.actorId;
}

function readVaultName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("A login name is required.");
  }
  return value.trim();
}

/**
 * The browser code the operator pastes back. Bounded and non-empty; the runner
 * validates the rest by whether the login actually completes.
 */
function readLoginCode(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("A login code is required.");
  }
  const code = value.trim();
  if (code.length > 512) throw badRequest("That login code is not valid.");
  return code;
}

export function claudeVaultRoutes(db: Db) {
  const router = Router();
  const service = claudeVaultLoginService(db);

  // List every vault, whether it holds a usable credential, and how many agents
  // are bound to it. The summary carries a masked token suffix and never a token.
  router.get("/instance/claude-vaults", async (req, res) => {
    assertCanManageVaults(req);
    res.json({ root: service.vaultRoot(), vaults: await service.listWithUsage() });
  });

  // Create an empty vault. The login also creates the directory, so this exists
  // only to stage a name before signing in to it.
  router.post("/instance/claude-vaults", async (req, res) => {
    const actor = assertCanManageVaults(req);
    const name = readVaultName((req.body as Record<string, unknown> | undefined)?.name);
    try {
      res.status(201).json(await service.create(name, actor));
    } catch (error) {
      if (error instanceof ClaudeVaultNameInvalidError) throw badRequest(error.message);
      throw error;
    }
  });

  // Start a setup-token login. Returns at once; the client polls the session for
  // the authorization URL, then posts the operator's code back.
  router.post("/instance/claude-vaults/:name/login-sessions", async (req, res) => {
    const actor = assertCanManageVaults(req);
    const name = readVaultName(req.params.name);
    try {
      const session = await service.start(
        { vaultName: name, startedByUserId: actor.actorId },
        actor,
      );
      res.status(201).json(session);
    } catch (error) {
      if (error instanceof ClaudeVaultNameInvalidError) throw badRequest(error.message);
      // A second login for the same vault would race the same credential file.
      if (error instanceof ClaudeVaultLoginConflictError) throw conflict(error.message);
      throw error;
    }
  });

  // Read a login session. A non-owner receives a 404 rather than a 403, so the
  // existence of another admin's session is not disclosed.
  router.get("/instance/claude-vaults/login-sessions/:sessionId", async (req, res) => {
    assertCanManageVaults(req);
    const session = service.read(req.params.sessionId as string, ownerId(req));
    if (!session) throw notFound("Login session not found.");
    res.json(session);
  });

  // Submit the browser code. This is the Claude-specific half of the round trip;
  // the Codex device login has no equivalent.
  router.post("/instance/claude-vaults/login-sessions/:sessionId/code", async (req, res) => {
    assertCanManageVaults(req);
    const code = readLoginCode((req.body as Record<string, unknown> | undefined)?.code);
    try {
      const session = service.submitCode(req.params.sessionId as string, ownerId(req), code);
      if (!session) throw notFound("Login session not found.");
      res.json(session);
    } catch (error) {
      // The session is not waiting for a code — already submitted, already
      // finished, or never reached the prompt.
      if (error instanceof ClaudeVaultCodeUnexpectedError) throw conflict(error.message);
      throw error;
    }
  });

  // Cancel an in-flight login.
  router.post("/instance/claude-vaults/login-sessions/:sessionId/cancel", async (req, res) => {
    assertCanManageVaults(req);
    const session = service.cancel(req.params.sessionId as string, ownerId(req));
    if (!session) throw notFound("Login session not found.");
    res.json(session);
  });

  // Remove a vault's credential and keep the vault. Idempotent on an existing
  // vault that holds no credential; a 404 only when there is no vault at all.
  router.delete("/instance/claude-vaults/:name/credential", async (req, res) => {
    const actor = assertCanManageVaults(req);
    const name = readVaultName(req.params.name);
    try {
      res.json(await service.removeCredential(name, actor));
    } catch (error) {
      if (error instanceof ClaudeVaultNameInvalidError) throw badRequest(error.message);
      if (error instanceof ClaudeVaultNotFoundError) throw notFound(error.message);
      // A sign-out during a login would race the same credential file.
      if (error instanceof ClaudeVaultLoginConflictError) throw conflict(error.message);
      throw error;
    }
  });

  // Delete a vault directory outright. Irreversible, and it breaks every agent
  // whose CLAUDE_CONFIG_DIR names this path.
  router.delete("/instance/claude-vaults/:name", async (req, res) => {
    const actor = assertCanManageVaults(req);
    const name = readVaultName(req.params.name);
    try {
      const result = await service.remove(name, actor);
      if (!result.deleted) throw notFound("Claude login not found.");
      res.json(result);
    } catch (error) {
      if (error instanceof ClaudeVaultNameInvalidError) throw badRequest(error.message);
      if (error instanceof ClaudeVaultLoginConflictError) throw conflict(error.message);
      throw error;
    }
  });

  return router;
}
