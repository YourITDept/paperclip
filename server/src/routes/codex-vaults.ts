import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import {
  VaultLoginConflictError,
  VaultNameInvalidError,
  codexVaultLoginService,
  type VaultLoginActor,
} from "../services/codex-vault-login-service.js";
import { getActorInfo } from "./authz.js";

// The Codex credential vault routes.
//
// A vault is one named directory holding one Codex identity's durable
// credential. Provisioning several vaults is how an instance runs several agents
// against several Codex accounts: each agent binds to a vault through
// `env.PAPERCLIP_CODEX_VAULT`, and the adapter symlinks that vault's `auth.json`
// into the agent's own managed home.
//
// Authorization: every route requires instance admin. A vault lives outside every
// company's isolation boundary — the vault root is a host path, not company
// state — so company-scoped permissions are not the right gate. The one-time
// login prompt is additionally owner-scoped: only the admin who started a session
// can read its code, so one admin's device code never appears in another's
// browser.

/**
 * Requires an instance admin. `local_implicit` is the single-user local mode the
 * rest of the instance routes already treat as admin.
 */
function assertCanManageVaults(req: Request): VaultLoginActor {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
    throw forbidden("Instance admin access required");
  }
  const actor = getActorInfo(req);
  if (actor.actorType !== "user") {
    throw forbidden("A board user identity is required to manage Codex vaults.");
  }
  return { actorType: actor.actorType, actorId: actor.actorId };
}

/**
 * Reads the session owner. The prompt is bound to the user who started the
 * login, so this identity gates every session read.
 */
function ownerId(req: Request): string {
  const actor = getActorInfo(req);
  if (actor.actorType !== "user") {
    throw forbidden("A board user identity is required to manage Codex vaults.");
  }
  return actor.actorId;
}

function readVaultName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("A vault name is required.");
  }
  return value.trim();
}

export function codexVaultRoutes(db: Db) {
  const router = Router();
  const service = codexVaultLoginService(db);

  // List every vault and whether it holds a usable credential. The summary
  // carries a masked account suffix and never a token or a full account id.
  router.get("/instance/codex-vaults", async (req, res) => {
    assertCanManageVaults(req);
    res.json({ root: service.vaultRoot(), vaults: await service.list() });
  });

  // Create an empty vault. The login also creates the directory, so this exists
  // only to stage a name before signing in to it.
  router.post("/instance/codex-vaults", async (req, res) => {
    const actor = assertCanManageVaults(req);
    const name = readVaultName((req.body as Record<string, unknown> | undefined)?.name);
    try {
      res.status(201).json(await service.create(name, actor));
    } catch (error) {
      if (error instanceof VaultNameInvalidError) throw badRequest(error.message);
      throw error;
    }
  });

  // Start a device login for one vault. Returns at once; the client polls the
  // session for the one-time prompt and the outcome.
  router.post("/instance/codex-vaults/:name/login-sessions", async (req, res) => {
    const actor = assertCanManageVaults(req);
    const name = readVaultName(req.params.name);
    try {
      const session = await service.start(
        { vaultName: name, startedByUserId: actor.actorId },
        actor,
      );
      res.status(201).json(session);
    } catch (error) {
      if (error instanceof VaultNameInvalidError) throw badRequest(error.message);
      // A second login for the same vault would race the same credential file.
      if (error instanceof VaultLoginConflictError) throw conflict(error.message);
      throw error;
    }
  });

  // Read a login session. A non-owner receives a 404 rather than a 403, so the
  // existence of another admin's session is not disclosed.
  router.get("/instance/codex-vaults/login-sessions/:sessionId", async (req, res) => {
    assertCanManageVaults(req);
    const session = service.read(req.params.sessionId as string, ownerId(req));
    if (!session) throw notFound("Login session not found.");
    res.json(session);
  });

  // Cancel an in-flight login.
  router.post("/instance/codex-vaults/login-sessions/:sessionId/cancel", async (req, res) => {
    assertCanManageVaults(req);
    const session = service.cancel(req.params.sessionId as string, ownerId(req));
    if (!session) throw notFound("Login session not found.");
    res.json(session);
  });

  return router;
}
