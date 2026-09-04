/**
 * Queue access for the Outseta provisioning worker.
 *
 * This file is the ONLY place in Paperclip that names the `provisioning`
 * schema, and the only place in this module that writes SQL text.
 *
 * WHY RAW SQL AND NOT DRIZZLE TABLES. These tables are not ours. They are
 * created upstream by the onboarding tooling (`database.js` in
 * Octobot-Onboard) before this container has ever started, because the first
 * thing queued is the instance owner and it has to be waiting when Paperclip
 * first boots. Defining drizzle table objects for them would put them on
 * drizzle-kit's map — and drizzle-kit generates migrations from a diff, so a
 * table it can see but does not find in a migration is a table it will offer to
 * drop. Staying invisible to it is the point.
 *
 * WHY THEY LIVE OUTSIDE `public`. Paperclip refuses to migrate a database that
 * has tables but no migration journal (`inspectMigrations` in
 * packages/db/src/client.ts), and every check it makes is scoped to
 * `table_schema = 'public'`. Keeping the queue in its own schema means a
 * brand-new instance still looks empty and bootstraps normally, so the queue
 * can exist and hold jobs before the first boot.
 *
 * WHY THE NARROW HANDLE. `SqlRunner` is `Pick<Db, "execute">` rather than `Db`,
 * so this file cannot reach a Paperclip table even by accident: `.select()`,
 * `.insert()`, `.transaction()` and `db.query.*` are not on the type. Applying
 * a job is `handlers.ts`'s job and it goes through the base services.
 *
 * Table names are written out literally rather than built from constants so
 * that grepping this file for `FROM|INTO|UPDATE` proves every statement stays
 * inside the `provisioning` schema.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** The only capability this file is allowed. Deliberately NOT `Db`. */
export type SqlRunner = Pick<Db, "execute">;

/**
 * Every job type the enqueue side may legitimately produce, including the
 * three nothing enqueues yet.
 *
 * This list is what separates "we have not built that handler" from "this row
 * is corrupt". The first parks and waits for a build that knows what to do
 * with it; the second fails permanently. Getting that backwards is expensive:
 * the enqueuer's idempotency keys are content-addressed, so a job that reaches
 * a terminal state is never re-queued by a later identical event, and a type
 * we simply had not written yet would be dead for good.
 */
export const JOB_TYPES = [
  "instance.state",
  "user.upsert",
  "company.create",
  "membership.set",
  "membership.remove",
  "company.reconcile",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export function isKnownJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

export type JobRow = {
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

export type InstanceState = {
  outsetaAccountUid: string | null;
  accountStage: number | null;
  maxCompanies: number | null;
  maxUsers: number | null;
  sourceUpdatedAt: Date | null;
};

/** Postgres `undefined_table`. */
const UNDEFINED_TABLE = "42P01";
/** Postgres `invalid_schema_name`. */
const UNDEFINED_SCHEMA = "3F000";

function isMissingQueue(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === UNDEFINED_TABLE || code === UNDEFINED_SCHEMA;
}

/**
 * Normalise what `db.execute` hands back.
 *
 * drizzle returns the driver's own result: postgres.js yields an array-like of
 * rows, node-postgres yields `{ rows }`. Accepting both means this file does
 * not silently return zero rows if the driver underneath is ever swapped.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function toInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export type ProvisioningStore = ReturnType<typeof provisioningStore>;

export function provisioningStore(run: SqlRunner) {
  /**
   * True once we have said the queue is absent, so a plain Paperclip instance
   * with the flag set by mistake logs one line rather than one every 15s.
   */
  let warnedMissing = false;

  /**
   * A missing queue is not an error.
   *
   * The tables are created upstream. On a database that never went through the
   * onboarding tooling — a dev box, a restored dump, an instance stood up by
   * hand — they are simply absent, and there is nothing to drain. Caught per
   * call rather than probed once at startup, so the worker starts working by
   * itself the moment the tables appear, with no restart and no assumption
   * about the order the two sides came up in.
   */
  async function guard<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isMissingQueue(err)) throw err;
      if (!warnedMissing) {
        warnedMissing = true;
        logger.info(
          { operation: what },
          "provisioning: queue tables are absent; idle until the onboarding tooling creates them",
        );
      }
      return fallback;
    }
  }

  /**
   * Claim exactly one eligible job.
   *
   * `FOR UPDATE SKIP LOCKED` steps over a row another process holds instead of
   * waiting on it. A hot restart briefly runs two containers against one
   * database; without it both would claim the same row and apply it twice.
   * It is also why this statement cannot block: there is no lock to wait for.
   */
  async function claimOne(workerId: string): Promise<JobRow | null> {
    return guard("claim", async () => {
      const result = await run.execute(sql`
        UPDATE provisioning.provisioning_jobs
        SET status = 'running',
            attempts = attempts + 1,
            claimed_at = now(),
            claimed_by = ${workerId},
            updated_at = now()
        WHERE id = (
          SELECT id FROM provisioning.provisioning_jobs
          WHERE status = 'pending' AND run_after <= now()
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, job_type, payload, attempts, max_attempts
      `);
      const row = rowsOf<Record<string, unknown>>(result)[0];
      if (!row) return null;
      return {
        id: String(row.id),
        jobType: String(row.job_type),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        attempts: toInt(row.attempts),
        maxAttempts: toInt(row.max_attempts),
      };
    }, null);
  }

  async function succeed(id: string, result: Record<string, unknown>): Promise<void> {
    await guard("succeed", async () => {
      await run.execute(sql`
        UPDATE provisioning.provisioning_jobs
        SET status = 'succeeded',
            result = ${JSON.stringify(result)}::jsonb,
            error_code = NULL,
            error_message = NULL,
            finished_at = now(),
            updated_at = now()
        WHERE id = ${id}
      `);
    }, undefined);
  }

  /** Permanent. Nothing about a retry would change the outcome. */
  async function failPermanent(id: string, code: string, message: string): Promise<void> {
    await guard("fail", async () => {
      await run.execute(sql`
        UPDATE provisioning.provisioning_jobs
        SET status = 'failed',
            error_code = ${code},
            error_message = ${message},
            finished_at = now(),
            updated_at = now()
        WHERE id = ${id}
      `);
    }, undefined);
  }

  /** Transient. Back off and spend one of the attempts. */
  async function retryLater(id: string, message: string, delayMs: number): Promise<void> {
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    await guard("retry", async () => {
      await run.execute(sql`
        UPDATE provisioning.provisioning_jobs
        SET status = 'pending',
            error_message = ${message},
            run_after = now() + (${seconds}::int * interval '1 second'),
            updated_at = now()
        WHERE id = ${id}
      `);
    }, undefined);
  }

  /** The retry budget is spent. Terminal, and someone should look. */
  async function giveUp(id: string, message: string): Promise<void> {
    await guard("give-up", async () => {
      await run.execute(sql`
        UPDATE provisioning.provisioning_jobs
        SET status = 'dead',
            error_code = 'max_attempts_exceeded',
            error_message = ${message},
            finished_at = now(),
            updated_at = now()
        WHERE id = ${id}
      `);
    }, undefined);
  }

  /**
   * Park: the job is correct but a precondition is not met yet.
   *
   * Waiting for something to exist is not a failure and must not spend a
   * failure budget. The owner's `membership.set` arrives before any company
   * does, and the wait is however long it takes somebody to sign in and create
   * one — which can be a day. Five backoff attempts expire in about fifteen
   * minutes, and a job that reached `dead` is never re-queued, because the
   * enqueuer keys on content rather than time.
   *
   * So the claim's increment is given back and the row goes back to `pending`
   * with a future `run_after`. `error_code` stays NULL deliberately: this row
   * is pending and correct, and setting a code would put it in the onboarding
   * side's error report.
   */
  async function park(id: string, reason: string, delayMs: number): Promise<void> {
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    await guard("park", async () => {
      await run.execute(sql`
        UPDATE provisioning.provisioning_jobs
        SET status = 'pending',
            attempts = GREATEST(attempts - 1, 0),
            error_code = NULL,
            error_message = ${reason},
            run_after = now() + (${seconds}::int * interval '1 second'),
            updated_at = now()
        WHERE id = ${id}
      `);
    }, undefined);
  }

  /**
   * Return jobs orphaned by a hard kill.
   *
   * `attempts` is deliberately NOT reset. A job that reliably kills the process
   * would otherwise loop for ever; leaving the count alone means it still
   * exhausts its budget and lands in `dead` where somebody can see it.
   * `claimed_by` is left in place too — it records which process dropped it.
   */
  async function reapStuck(olderThanMs: number): Promise<number> {
    const seconds = Math.max(1, Math.round(olderThanMs / 1000));
    return guard("reap", async () => {
      const result = await run.execute(sql`
        UPDATE provisioning.provisioning_jobs
        SET status = 'pending',
            run_after = now(),
            error_message = 'reclaimed after the worker holding it went away',
            updated_at = now()
        WHERE status = 'running'
          AND claimed_at < now() - (${seconds}::int * interval '1 second')
        RETURNING id
      `);
      return rowsOf(result).length;
    }, 0);
  }

  async function readInstanceState(): Promise<InstanceState | null> {
    return guard("read-state", async () => {
      const result = await run.execute(sql`
        SELECT outseta_account_uid, account_stage, max_companies, max_users, source_updated_at
        FROM provisioning.outseta_instance_state
        WHERE singleton_key = 'default'
        LIMIT 1
      `);
      const row = rowsOf<Record<string, unknown>>(result)[0];
      if (!row) return null;
      const updated = row.source_updated_at;
      return {
        outsetaAccountUid: row.outseta_account_uid == null ? null : String(row.outseta_account_uid),
        accountStage: toNullableInt(row.account_stage),
        maxCompanies: toNullableInt(row.max_companies),
        maxUsers: toNullableInt(row.max_users),
        sourceUpdatedAt: updated == null ? null : new Date(String(updated)),
      };
    }, null);
  }

  /**
   * Upsert the singleton. `ON CONFLICT` on `singleton_key` rather than a
   * read-then-write, so two workers during a hot restart cannot both decide the
   * row is missing and insert it.
   */
  async function writeInstanceState(patch: InstanceState): Promise<void> {
    const updatedAt = patch.sourceUpdatedAt ? patch.sourceUpdatedAt.toISOString() : null;
    await guard("write-state", async () => {
      await run.execute(sql`
        INSERT INTO provisioning.outseta_instance_state (
          singleton_key, outseta_account_uid, account_stage,
          max_companies, max_users, source_updated_at, updated_at
        ) VALUES (
          'default', ${patch.outsetaAccountUid}, ${patch.accountStage},
          ${patch.maxCompanies}, ${patch.maxUsers}, ${updatedAt}::timestamptz, now()
        )
        ON CONFLICT (singleton_key) DO UPDATE SET
          outseta_account_uid = EXCLUDED.outseta_account_uid,
          account_stage = EXCLUDED.account_stage,
          max_companies = EXCLUDED.max_companies,
          max_users = EXCLUDED.max_users,
          source_updated_at = EXCLUDED.source_updated_at,
          updated_at = now()
      `);
    }, undefined);
  }

  return {
    claimOne,
    succeed,
    failPermanent,
    retryLater,
    giveUp,
    park,
    reapStuck,
    readInstanceState,
    writeInstanceState,
  };
}
