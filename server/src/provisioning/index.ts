/**
 * Outseta provisioning — the one seam into the rest of the server.
 *
 * `server/src/index.ts` calls `startProvisioningWorker` and, in its shutdown
 * handler, `stop()`. Nothing else in Paperclip imports from this directory.
 * Delete the directory and remove those two lines and the fork is unchanged.
 */

import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { createProvisioningWorker, type ProvisioningWorker, type ProvisioningWorkerOptions } from "./worker.js";

export { createProvisioningWorker } from "./worker.js";
export type { ProvisioningWorker, ProvisioningWorkerOptions } from "./worker.js";
export { provisioningStore, JOB_TYPES, isKnownJobType } from "./store.js";
export { provisioningHandlers, roleFor, readEmail, ParkJobError, PermanentJobError } from "./handlers.js";

export const PROVISIONING_ENABLED_ENV = "PAPERCLIP_PROVISIONING_WORKER_ENABLED";

const TRUTHY = new Set(["true", "1", "yes", "on"]);

/**
 * The gate. Nothing in this module runs unless it returns true.
 *
 * It is the signal that the onboarding tooling has set this instance up and
 * the queue is there to read. It governs both halves of the job — the startup
 * drain that onboards whoever was queued before the container existed, and the
 * poll that keeps users in step afterwards. There is no separate switch.
 *
 * DEFAULT FALSE. Unset means an ordinary Paperclip instance that knows nothing
 * about Outseta, and it must not go looking for a schema that is not there.
 *
 * An unrecognised value is false AND warns. That case is a typo — `ture`,
 * `enabled`, a stray quote — and treating it silently as false would give an
 * instance that onboards nobody with nothing in the log to say why. This
 * integration has a standing catalogue of failures that produce no error;
 * a misspelled flag should not join it.
 *
 * It is NOT a security boundary. It says "Outseta is configured here" and
 * nothing more.
 */
export function provisioningWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PROVISIONING_ENABLED_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "") return false;
  if (TRUTHY.has(value)) return true;
  if (value === "false" || value === "0" || value === "no" || value === "off") return false;
  logger.warn(
    { [PROVISIONING_ENABLED_ENV]: raw },
    `provisioning: ${PROVISIONING_ENABLED_ENV} is set to an unrecognised value; treating it as disabled`,
  );
  return false;
}

/** A handle that does nothing, so the call site needs no conditional. */
function inertWorker(): ProvisioningWorker {
  return { drain: async () => 0, stop: async () => {} };
}

/**
 * Start the worker if this instance is wired to Outseta.
 *
 * When the flag is off this returns without retaining `db`, registering a
 * timer, or issuing a statement — the base behaves exactly as if this module
 * were not compiled in. `stop()` on the returned handle is always safe to call,
 * because the shutdown handler calls it unconditionally.
 */
export function startProvisioningWorker(
  db: Db,
  options: ProvisioningWorkerOptions = {},
): ProvisioningWorker {
  if (!provisioningWorkerEnabled()) {
    logger.info(`provisioning: worker disabled - ${PROVISIONING_ENABLED_ENV} is not set`);
    return inertWorker();
  }

  const worker = createProvisioningWorker(db, options);
  logger.info(
    { pollIntervalMs: options.pollIntervalMs ?? 15_000 },
    "provisioning: worker enabled - draining provisioning.provisioning_jobs",
  );
  return worker;
}
