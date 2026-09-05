/**
 * The provisioning worker.
 *
 * Claims rows from `provisioning.provisioning_jobs` and applies them through
 * `handlers.ts`. It is a `setInterval` and nothing more.
 *
 * WHY POLL AND NOT LISTEN/NOTIFY. The design this came from paired a 30s poll
 * with `LISTEN`, and was careful to say why: notifications are not durable, so
 * a notification that fires while the listener is disconnected is gone and
 * nothing redelivers it. `LISTEN` was only ever a latency optimisation and the
 * poll was the guarantee.
 *
 * It is dropped here. It is the one thing in this module that would need a
 * dedicated postgres.js connection — and therefore a `postgres` dependency in
 * `server/package.json`, which this fork re-applies its patches over on every
 * re-branch — and everything it buys is latency on a path where nothing waits
 * on a sub-second answer: the jobs are queued while a container is still being
 * deployed. The enqueue side still issues `pg_notify` into a channel nobody
 * listens on, which costs nothing and leaves the door open.
 *
 * The startup drain is the important half. Jobs are queued before this
 * container has ever existed — the instance owner among them — so the first
 * pass on boot IS the onboarding.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ParkJobError, PermanentJobError, provisioningHandlers } from "./handlers.js";
import { isKnownJobType, provisioningStore } from "./store.js";

export type ProvisioningWorkerOptions = {
  /** How often to look for work. Cheap: an index lookup that usually finds none. */
  pollIntervalMs?: number;
  /** How often to return jobs orphaned by a hard kill. */
  reapIntervalMs?: number;
  /** A `running` row older than this had its worker go away. */
  reapAfterMs?: number;
  /** Upper bound on one pass, so a bad batch cannot spin. */
  maxJobsPerPass?: number;
};

export type ProvisioningWorker = {
  drain: () => Promise<number>;
  stop: () => Promise<void>;
};

/** Transient backoff: ~30s, 1m, 2m, 4m, 8m, capped at 15m. */
function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

export function createProvisioningWorker(db: Db, options: ProvisioningWorkerOptions = {}): ProvisioningWorker {
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const reapIntervalMs = options.reapIntervalMs ?? 5 * 60_000;
  const reapAfterMs = options.reapAfterMs ?? 15 * 60_000;
  const maxJobsPerPass = options.maxJobsPerPass ?? 50;

  // Identifies this process in `claimed_by`, so a row stuck in `running` says
  // which container dropped it.
  const workerId = `${process.pid}:${randomUUID().slice(0, 8)}`;

  const store = provisioningStore(db);
  const handlers = provisioningHandlers(db, store);

  let stopped = false;
  let draining = false;
  let again = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reapTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<unknown> | null = null;

  /** Decide what a thrown error means and record it. */
  async function settleFailure(
    job: { id: string; jobType: string; attempts: number; maxAttempts: number },
    err: unknown,
  ): Promise<void> {
    if (err instanceof ParkJobError) {
      await store.park(job.id, err.message, err.retryInMs);
      logger.info(
        { jobId: job.id, jobType: job.jobType, retryInMs: err.retryInMs, reason: err.message },
        "provisioning: job parked, waiting on a precondition",
      );
      return;
    }

    if (err instanceof PermanentJobError) {
      await store.failPermanent(job.id, err.code, err.message);
      logger.warn(
        { jobId: job.id, jobType: job.jobType, code: err.code },
        "provisioning: job failed permanently",
      );
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (job.attempts >= job.maxAttempts) {
      await store.giveUp(job.id, message);
      logger.error(
        { jobId: job.id, jobType: job.jobType, attempts: job.attempts },
        "provisioning: job exhausted its retries",
      );
      return;
    }

    const delay = backoffMs(job.attempts);
    await store.retryLater(job.id, message, delay);
    logger.warn(
      { jobId: job.id, jobType: job.jobType, attempts: job.attempts, retryInMs: delay, err },
      "provisioning: job failed, scheduled a retry",
    );
  }

  /** Claim and apply until the queue is empty or the pass budget is spent. */
  async function drain(): Promise<number> {
    if (draining) {
      // A pass is already running. Note that another is warranted rather than
      // running two at once.
      again = true;
      return 0;
    }
    draining = true;
    let processed = 0;

    try {
      while (!stopped && processed < maxJobsPerPass) {
        const job = await store.claimOne(workerId);
        if (!job) break;
        processed += 1;

        // Not in the vocabulary at all: a corrupt row or a typo, and no build
        // will ever know what to do with it. Known-but-unbuilt types are parked
        // by `handlers.run` instead.
        if (!isKnownJobType(job.jobType)) {
          await store.failPermanent(
            job.id,
            "unknown_job_type",
            `${job.jobType} is not a provisioning job type`,
          );
          logger.warn({ jobId: job.id, jobType: job.jobType }, "provisioning: unknown job type");
          continue;
        }

        try {
          const payload = job.payload ?? {};
          const result = await handlers.run(job.jobType, payload);
          await store.succeed(job.id, result);
          // A payload that carried a credential is blanked once it has been
          // applied, so the key does not outlive the job in a retained row.
          if (handlers.carriesCredential(job.jobType, payload)) {
            await store.clearPayload(job.id);
          }
          logger.info({ jobId: job.id, jobType: job.jobType, result }, "provisioning: job applied");
        } catch (err) {
          await settleFailure(job, err);
        }
      }
    } finally {
      draining = false;
    }

    if (again && !stopped) {
      again = false;
      return processed + (await drain());
    }
    return processed;
  }

  /** Fire a pass without letting its failure escape into the caller. */
  function schedule(reason: string): void {
    if (stopped) return;
    inFlight = drain()
      .then((processed) => {
        // Routine polls stay silent when there is nothing to do - a line every
        // 15 seconds would bury the ones that matter. The startup pass always
        // reports, including when it found nothing: an empty queue at boot is a
        // legitimate state (the instance was brought up before anything was
        // queued for it) and the operator needs to see that the worker looked
        // and is waiting, not that it failed to start.
        if (processed > 0) {
          logger.info({ processed, reason }, "provisioning: pass complete");
        } else if (reason === "startup") {
          logger.info(
            { reason },
            "provisioning: nothing queued yet - polling for work",
          );
        }
      })
      // Never let a worker error take the process down. The timer keeps firing
      // and the next poll retries; there is no state in which this stops
      // looking.
      .catch((err) => logger.error({ err, reason }, "provisioning: pass failed"));
  }

  pollTimer = setInterval(() => schedule("poll"), pollIntervalMs);
  pollTimer.unref?.();

  reapTimer = setInterval(() => {
    if (stopped) return;
    inFlight = store
      .reapStuck(reapAfterMs)
      .then((reclaimed) => {
        if (reclaimed > 0) {
          logger.warn({ reclaimed }, "provisioning: reclaimed jobs orphaned by a departed worker");
          schedule("reap");
        }
      })
      .catch((err) => logger.error({ err }, "provisioning: reaper failed"));
  }, reapIntervalMs);
  reapTimer.unref?.();

  // Everything queued before this container existed. On a new instance this is
  // the whole of onboarding.
  schedule("startup");

  return {
    drain,

    async stop() {
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (reapTimer) {
        clearInterval(reapTimer);
        reapTimer = null;
      }
      // Let the job in hand finish rather than leaving a row stuck in `running`
      // with nobody holding it.
      if (inFlight) await inFlight.catch(() => undefined);
      logger.info({ workerId }, "provisioning: worker stopped");
    },
  };
}
