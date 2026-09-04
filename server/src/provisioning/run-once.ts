#!/usr/bin/env node
/**
 * Drain the provisioning queue once, then exit.
 *
 * For the onboarding scripts. They already run `database.js` and the Hostinger
 * deploy step by hand; this is the same shape — run it after a deploy and the
 * owner is provisioned immediately instead of on the next 15-second poll.
 *
 *   docker exec <container> node server/dist/provisioning/run-once.js
 *
 * IT TAKES NO ARGUMENTS ON PURPOSE. There is no user id, email or company to
 * pass: every job row already carries what it needs, and the instance state,
 * the roster and the company all come from the database at the moment it runs.
 * Anything passed on a command line would be a second source of truth for
 * something the queue already knows, and the two would eventually disagree.
 *
 * Prints one line of JSON so a shell script can branch on it, and exits
 * non-zero only if the drain itself threw. A job that failed is reported in the
 * queue, not by this exit code — the two are different questions.
 */

import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { createProvisioningWorker } from "./worker.js";
import { PROVISIONING_ENABLED_ENV, provisioningWorkerEnabled } from "./index.js";

async function main(): Promise<number> {
  const force = process.argv.includes("--force");

  if (!provisioningWorkerEnabled() && !force) {
    // Exit 0: for an onboarding script, "this instance is not wired to Outseta"
    // is a normal answer, not a failure. `--force` is for looking at an
    // instance whose flag is deliberately off.
    process.stdout.write(
      `${JSON.stringify({ ok: true, skipped: `${PROVISIONING_ENABLED_ENV} is not set`, processed: 0 })}\n`,
    );
    return 0;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "DATABASE_URL is not set" })}\n`);
    return 2;
  }

  const db = createDb(url);

  // Paperclip's own tables have to exist before a job can be applied: every
  // handler writes `user`, `companies` or `company_memberships`, and those are
  // created by Paperclip's migrations on its first boot.
  //
  // This matters because of the order onboarding runs in. `database.js` creates
  // the database and queues the owner BEFORE the container is deployed, so
  // there is a real window where the queue is full and `public` is still empty.
  // Draining in that window would throw `undefined_table` per job, which is
  // indistinguishable from a transient fault: five backoff attempts each and
  // every one of them lands in `dead` — and because the enqueuer keys on
  // content, a dead job is never re-queued. The whole owner bootstrap would be
  // lost to a race.
  //
  // So check, and say so plainly instead.
  const bootstrapped = await db
    .execute(sql`SELECT to_regclass('public.user') IS NOT NULL AS ready`)
    .then((result) => {
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
      return (rows[0] as { ready?: boolean } | undefined)?.ready === true;
    });

  if (!bootstrapped) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        skipped: "Paperclip has not migrated this database yet; start the server once first",
        processed: 0,
      })}\n`,
    );
    return 0;
  }

  // Poll and reaper intervals are pushed out of the way: this process exists to
  // run exactly one pass and leave. `drain()` is called directly.
  const worker = createProvisioningWorker(db, {
    pollIntervalMs: 60 * 60_000,
    reapIntervalMs: 60 * 60_000,
  });

  try {
    const processed = await worker.drain();
    process.stdout.write(`${JSON.stringify({ ok: true, processed })}\n`);
    return 0;
  } finally {
    await worker.stop();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    logger.error({ err }, "provisioning: run-once failed");
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`,
    );
    process.exitCode = 1;
  });
