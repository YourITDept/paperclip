/**
 * Job handlers — the only file in this module that touches Paperclip.
 *
 * Everything goes through `accessService`, never a raw write, and that is the
 * whole reason this runs inside Paperclip instead of in the onboarding
 * container:
 *
 *   - `ensureRoleDefaultGrants` writes `principal_permission_grants`.
 *     `decidePrincipalGrant` (services/authorization.ts) needs an explicit
 *     grant row for every permission except a narrow `tools:*` fallback for
 *     owner/admin, so a membership with no grants is a person who signs in,
 *     sees the company, and can do nothing. It is type-clean and looks exactly
 *     like a bug.
 *   - `promoteInstanceAdmin` is idempotent, which matters because replay is the
 *     normal case here rather than the exception.
 *
 * WHERE POLICY LIVES. All of it here. The onboarding side's only connector is
 * the database: it knows people, emails, who the billing contact is and what
 * the account stage is, and it has no way to learn what a Paperclip company or
 * role or grant is. So it asserts facts and this file decides what they mean —
 * see `roleFor`, which is the single place a role is chosen.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, count, countDistinct, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@paperclipai/shared";
import { accessService } from "../services/access.js";
import { agentService } from "../services/agents.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import {
  PAPERCLIP_OPERATIONAL_SKILL_KEY,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { secretService } from "../services/secrets.js";
import { companyService } from "../services/companies.js";
import { issueService } from "../services/issues.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "../services/issue-assignment-wakeup.js";
import { normalizeHumanRole } from "../services/company-member-roles.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { ProvisioningStore } from "./store.js";

/** Retrying will not change the outcome. The row stops here and someone looks. */
export class PermanentJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * The job is correct; something it depends on does not exist yet.
 *
 * Not a failure, and must not spend the failure budget — see `store.park`.
 */
export class ParkJobError extends Error {
  constructor(
    message: string,
    readonly retryInMs: number = 5 * 60_000,
  ) {
    super(message);
    this.name = "ParkJobError";
  }
}

export type JobResult = Record<string, unknown>;

/**
 * Normalise an email exactly as `extractProxyHeaderEmail` does in
 * `auth/proxy-header-auth.ts`.
 *
 * This is not input validation — the rows come from our own onboarding script
 * through a role that can only append. It is an identity contract. The proxy
 * asserts nothing but an email and resolves the user by `lower(user.email)`;
 * if this file and that one ever disagreed about which row an address means, a
 * provisioned person would sign in as somebody else or as nobody, and nothing
 * would error.
 *
 * The one rule deliberately NOT copied is the allowed-domain filter. That is a
 * proxy deployment concern; refusing to create the row here would turn a
 * misconfigured domain list into a person who silently never arrives.
 */
export function readEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320) return null;
  if (trimmed.includes(",")) return null;
  // Any whitespace or C0/DEL control character, written as escapes so the
  // range survives being copied between files. Hyphens are legal in domain
  // names and must not be caught here.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  const email = trimmed.toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [localPart, domain] = parts;
  if (!localPart || !domain) return null;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  return email;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Translate an assignability refusal into a permanent failure.
 *
 * `assertAssignableAgent` throws a 409 whose `details` already carry
 * `agent_not_assignable` and the reason — `assignee_terminated`,
 * `pending_approval`, one of the org-chain reasons. Reusing Paperclip's own
 * code rather than minting one keeps the operator reading a single vocabulary.
 *
 * None of those change on a retry, so they must not spend the failure budget
 * five times before anyone sees them. Anything else is passed through
 * untouched, so a genuinely transient database error still retries.
 */
function asPermanentAssignmentError(err: unknown, agentName: string): unknown {
  if (!(err instanceof HttpError)) return err;
  const details = (err.details ?? null) as { code?: unknown; reason?: unknown } | null;
  if (details?.code !== "agent_not_assignable") return err;
  const reason = typeof details.reason === "string" ? details.reason : "unknown";
  return new PermanentJobError(
    `cannot assign work to ${agentName}: ${reason} (${err.message})`,
    "agent_not_assignable",
  );
}

function readInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * Normalise a requested issue prefix.
 *
 * `companies.issue_prefix` is plain text with a unique index — the `[A-Z]{1,3}`
 * shape is what `deriveIssuePrefixBase` happens to produce, not a constraint —
 * so a caller-supplied prefix can be longer and can carry digits. That is the
 * point: an instance code like `dev92` becomes `DEV92`, which the derived form
 * could never produce because it strips digits.
 *
 * Upper-cased because the UI resolves the URL segment with
 * `issuePrefix.toUpperCase() === companyPrefix.toUpperCase()`, so storing it
 * lower-case would work but display inconsistently.
 *
 * A hyphen is rejected outright: issue identifiers are `PREFIX-123`, and a
 * prefix containing the separator makes them ambiguous to read back.
 */
export function readIssuePrefix(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const prefix = raw.toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(prefix)) return null;
  return prefix;
}

/**
 * The entire role policy, in one function.
 *
 * Outseta cannot make this decision — its connector is the database and it has
 * no idea what a Paperclip role is. It sends facts; this decides.
 *
 *   instance owner  -> owner     our own mailbox: the account that can always
 *                                get in, and the only role holding
 *                                users:manage_permissions
 *   Outseta primary -> admin     the customer's billing contact
 *   everyone else   -> operator  can be assigned work
 *
 * KNOWN CONSEQUENCE, chosen rather than inherited. `routes/access.ts` requires
 * `users:manage_permissions` even to LIST members, and only `owner` holds it —
 * so the primary contact cannot manage their own team, and the owner mailbox
 * does it for them. If customers should later manage their own membership, the
 * primary becomes `owner` and this is the only line that changes.
 *
 * The `role` fallback is transitional. The onboarding side currently decides
 * the role and ships the answer; until it moves to sending facts, honour what
 * it sent but normalise it here so the grant policy is already ours.
 */
export function roleFor(payload: Record<string, unknown>): HumanCompanyMembershipRole {
  if (payload.isInstanceOwner === true) return "owner";
  if (payload.isPrimary === true) return "admin";
  if (payload.role !== undefined) return normalizeHumanRole(payload.role, "operator");
  return "operator";
}

/**
 * What a handler knows about the row it is applying, beyond the payload.
 *
 * Only `agent.task` reads it today, and only for the idempotency key.
 */
export type ProvisioningJobContext = {
  /** `provisioning_jobs.idempotency_key` for the row being applied. */
  idempotencyKey: string;
};

export type ProvisioningHandlerDeps = {
  /**
   * The process's heartbeat scheduler, for waking an agent that has just been
   * given work.
   *
   * PASSED IN, NEVER CONSTRUCTED HERE. `heartbeatService` is a stateful
   * scheduler that claims runs and holds leases; a second instance inside one
   * process is a bug, not a duplicate object.
   *
   * Null when `HEARTBEAT_SCHEDULER_ENABLED=false`, in which case there is
   * nothing to wake and `agent.task` says so in its result rather than
   * pretending otherwise.
   */
  heartbeat?: IssueAssignmentWakeupDeps | null;
};

export function provisioningHandlers(
  db: Db,
  store: ProvisioningStore,
  deps: ProvisioningHandlerDeps = {},
) {
  const access = accessService(db);
  const companiesSvc = companyService(db);
  const agentsSvc = agentService(db);
  const instructionsSvc = agentInstructionsService();

  /**
   * Give a provisioned agent the same starting instructions the board UI gives
   * one, because nothing else will.
   *
   * Two paths create agents and only one of them seeds instructions.
   * `agentRoutes` calls `materializeDefaultInstructionsBundleForNewAgent` after
   * its create; this module calls `agentsSvc.create` directly, and
   * `services/agents.ts` has no notion of instructions at all. So every agent
   * provisioned from the queue started life with an EMPTY instruction bundle —
   * no Execution Contract, no final-disposition checklist, no work-product
   * rules — while looking completely normal in the UI. Reported by the operator
   * 2026-09-09.
   *
   * Deliberately seed-only, never replace:
   *   - `replaceExisting: false` keeps a bundle that is already on disk;
   *   - the explicit-config check mirrors the route's `hasExplicitInstructionsBundle`
   *     so a payload that names its own instructions wins;
   *   - only the create path calls this. `reconcileAgent` does not, so a later
   *     queue row cannot overwrite instructions a person edited by hand. That
   *     matches this module's standing "merge, never replace" rule.
   *
   * Never fatal. The agent exists and is usable by the time we get here, and a
   * thrown error would fail the job into a retry that finds the agent already
   * present, takes the reconcile path, and therefore never seeds at all — the
   * failure would make the gap permanent instead of transient.
   */
  async function seedDefaultInstructions(agent: {
    id: string; companyId: string; name: string; role: string;
    adapterType: string; adapterConfig: unknown;
  }): Promise<void> {
    try {
      if (findActiveServerAdapter(agent.adapterType)?.supportsInstructionsBundle !== true) return;
      const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const alreadyConfigured = [
        "instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile",
        "instructionsFilePath", "agentsMdPath",
      ].some((key) => typeof config[key] === "string" && config[key] !== "");
      if (alreadyConfigured) return;

      const files = await loadDefaultAgentInstructionsBundle(
        resolveDefaultAgentInstructionsBundleRole(agent.role),
      );
      const materialized = await instructionsSvc.materializeManagedBundle(agent, files, {
        entryFile: "AGENTS.md",
        replaceExisting: false,
      });
      await agentsSvc.update(agent.id, { adapterConfig: materialized.adapterConfig });
      logger.info(
        { agentId: agent.id, companyId: agent.companyId, role: agent.role, files: Object.keys(files) },
        "provisioning: seeded default agent instructions",
      );
    } catch (err) {
      logger.error(
        { err, agentId: agent.id, companyId: agent.companyId },
        "provisioning: failed to seed default agent instructions; agent has an EMPTY bundle",
      );
    }
  }

  const secretsSvc = secretService(db);
  const issuesSvc = issueService(db);
  const heartbeat = deps.heartbeat ?? null;

  /**
   * Find or create the `user` row.
   *
   * This row is not a convenience, it is the precondition for signing in:
   * `resolveProxyHeaderUser` matches `lower(user.email)`, and a person with no
   * row here simply is not anybody, whatever the proxy asserts.
   */
  async function ensureUser(email: string, name: string | null) {
    const existing = await db
      .select({ id: authUsers.id, name: authUsers.name })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`)
      .then((rows) => rows[0] ?? null);

    if (existing) {
      // Only write when there is something new to write; a no-op UPDATE on
      // every replay would churn `updated_at` for no reason.
      if (name && name !== existing.name) {
        await db
          .update(authUsers)
          .set({ name, updatedAt: new Date() })
          .where(eq(authUsers.id, existing.id));
      }
      return { userId: existing.id, created: false };
    }

    const now = new Date();
    const inserted = await db
      .insert(authUsers)
      .values({
        id: randomUUID(),
        // `name` is NOT NULL. The onboarding side often has no name for the
        // instance owner mailbox, and the email is a better placeholder than
        // an empty string.
        name: name ?? email,
        email,
        // Outseta verified this address. That is the premise of the whole
        // chain, and there is no email transport here to verify it again.
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: authUsers.id })
      .then((rows) => rows[0] ?? null);

    if (!inserted) throw new Error("insert into user returned no row");
    logger.info({ userId: inserted.id, email }, "provisioning: created user");
    return { userId: inserted.id, created: true };
  }

  /**
   * Resolve which company a job is addressed to.
   *
   * Four ways to name one, most specific first. The onboarding side cannot know
   * the uuid — Paperclip mints it — so the middle two exist to let a job target
   * a company by something the caller already knows.
   *
   *   companyId      the uuid, when the caller has read one back
   *   companyPrefix  the issue prefix: `companies.issue_prefix`, the code in
   *                  the URI (`/PAP/...`) and in issue ids (`PAP-123`). It
   *                  carries a unique index, so this is exact.
   *   companyName    the name, matched exactly. NOT unique in the schema, so
   *                  two companies sharing a name is ambiguous, not a pick.
   *   none of them   the instance's single active company
   *
   * ON MORE THAN ONE COMPANY. A job that names none, on an instance that has
   * several, is under-specified and no retry will fix it — so it fails
   * permanently rather than parking, because parking would wait for a condition
   * that never arrives. The answer is to name the company: once an instance has
   * a second one, every job has to say which. `company.create` returns both the
   * id and the prefix in its result for exactly that reason.
   */
  async function resolveCompanyId(payload: Record<string, unknown>): Promise<string> {
    const explicitId = readString(payload.companyId);
    if (explicitId) {
      const row = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, explicitId))
        .then((rows) => rows[0] ?? null);
      if (!row) throw new PermanentJobError(`company ${explicitId} not found`, "company_not_found");
      return row.id;
    }

    // Normalised through the same reader `company.create` uses, so the two
    // agree on what a prefix is. A malformed one fails PERMANENTLY rather than
    // parking: parking waits for a company that can never be created, because
    // `company.create` would reject the same value — a job waiting for ever on
    // an impossible condition is the quiet failure this design keeps avoiding.
    if (payload.companyPrefix !== undefined) {
      const prefix = readIssuePrefix(payload.companyPrefix);
      if (!prefix) {
        throw new PermanentJobError(
          "companyPrefix must be 1-12 letters or digits and contain no hyphen",
          "invalid_payload",
        );
      }
      // Case-insensitive to match the UI, which resolves the URL segment with
      // `issuePrefix.toUpperCase() === companyPrefix.toUpperCase()`.
      const row = await db
        .select({ id: companies.id })
        .from(companies)
        .where(sql`upper(${companies.issuePrefix}) = ${prefix}`)
        .then((rows) => rows[0] ?? null);
      if (!row) {
        // Parked, not failed: a well-formed prefix is a real target that may
        // simply not exist yet, because `company.create` has not run.
        throw new ParkJobError(`waiting for a company with prefix ${prefix}`);
      }
      return row.id;
    }

    const name = readString(payload.companyName);
    if (name) {
      const rows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.name, name))
        .limit(2);
      if (rows.length === 1) return rows[0].id;
      if (rows.length === 0) throw new ParkJobError(`waiting for a company named ${name}`);
      throw new PermanentJobError(
        `more than one company is named ${name}; address the job by companyPrefix or companyId`,
        "ambiguous_company",
      );
    }

    // LIMIT 2: enough to tell "one" from "more than one" without reading the
    // whole table.
    const active = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.status, "active"))
      .limit(2);

    if (active.length === 1) return active[0].id;
    if (active.length === 0) {
      throw new ParkJobError("waiting for a company to exist in this instance");
    }
    throw new PermanentJobError(
      "this instance has more than one active company and the job names none; " +
        "re-queue it with companyPrefix or companyId",
      "ambiguous_company",
    );
  }

  /**
   * Seats are per person, not per membership: somebody already active anywhere
   * in this instance is already counted, so joining a second company must not
   * be blocked at the limit.
   */
  async function assertSeatAvailable(userId: string, role: HumanCompanyMembershipRole) {
    // The instance owner is never seat-limited. An instance whose administrator
    // cannot be provisioned is one nobody can support, wind down or migrate,
    // and that is a worse outcome than being one over a plan limit.
    if (role === "owner") return;

    const state = await store.readInstanceState();
    if (!state?.maxUsers) return;

    const alreadyActive = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (alreadyActive) return;

    const current = await db
      .select({ value: countDistinct(companyMemberships.principalId) })
      .from(companyMemberships)
      .where(
        and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")),
      )
      .then((rows) => Number(rows[0]?.value ?? 0));

    if (current >= state.maxUsers) {
      // Permanent on purpose. A seat limit is a billing decision, and retrying
      // it for hours only delays somebody finding out.
      throw new PermanentJobError(
        `user limit reached (${current}/${state.maxUsers})`,
        "user_limit_reached",
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Handlers                                                            */
  /* ------------------------------------------------------------------ */

  /** Billing stage and plan limits for this instance. */
  async function instanceState(payload: Record<string, unknown>): Promise<JobResult> {
    const raw = readString(payload.sourceUpdatedAt);
    const sourceUpdatedAt = raw ? new Date(raw) : null;
    if (sourceUpdatedAt && Number.isNaN(sourceUpdatedAt.getTime())) {
      throw new PermanentJobError("sourceUpdatedAt is not a date", "invalid_payload");
    }

    // Delivery is not ordered and the onboarding side retries for hours, so a
    // late event can otherwise overwrite newer state with older values.
    const existing = await store.readInstanceState();
    if (existing?.sourceUpdatedAt && sourceUpdatedAt && sourceUpdatedAt < existing.sourceUpdatedAt) {
      return { skipped: "stale_event" };
    }

    const accountStage = readInt(payload.accountStage);
    await store.writeInstanceState({
      outsetaAccountUid: readString(payload.outsetaAccountUid),
      accountStage,
      maxCompanies: readInt(payload.maxCompanies),
      maxUsers: readInt(payload.maxUsers),
      sourceUpdatedAt,
    });

    return { applied: true, accountStage };
  }

  /**
   * Create or update a person, and set or clear instance-admin.
   *
   * This grants no company access, and on a brand-new instance it does not need
   * to: `POST /api/companies` requires `actor.isInstanceAdmin`
   * (routes/companies.ts), and `resolveProxyHeaderActor` reads that straight
   * from `instance_user_roles` on every request. So a `user` row plus this flag
   * is the entire first-boot path — the owner can sign in through the proxy and
   * create the first company with nothing else provisioned.
   */
  async function userUpsert(payload: Record<string, unknown>): Promise<JobResult> {
    const email = readEmail(payload.email);
    if (!email) throw new PermanentJobError("a valid email is required", "invalid_payload");

    const { userId, created } = await ensureUser(email, readString(payload.name));

    let instanceAdmin: boolean | null = null;
    if (payload.isInstanceAdmin === true) {
      await access.promoteInstanceAdmin(userId);
      instanceAdmin = true;
      logger.info({ userId, email }, "provisioning: granted instance admin");
    } else if (payload.isInstanceAdmin === false) {
      // Cleared as well as set: a lapsed account loses the flag, and a
      // returning customer has it restored by the next event rather than by
      // somebody remembering to put it back.
      await access.demoteInstanceAdmin(userId);
      instanceAdmin = false;
    }

    return { userId, created, instanceAdmin };
  }


  /**
   * Create a company, owned by the instance owner.
   *
   * An ADD mechanism, not a one-time bootstrap. An instance starts with one
   * company so `membership.set` can resolve `companyId: null`, but nothing
   * stops it having more, and this job is how they arrive.
   *
   * `companyPrefix` does double duty, deliberately:
   *
   *   a company already has it  -> adopt that one, re-assert ownership
   *   nothing has it            -> CREATE the company with that prefix
   *
   * which is what makes the prefix usable as a caller-chosen key. The caller
   * picks it up front, every later job addresses the company by it, and there
   * is no read-back step in between.
   *
   * ALWAYS through `companyService`, never an INSERT into `companies`. `create`
   * resolves a unique issue prefix, calls `ensureLocalEnvironment` and runs
   * `autoProvisionBundledAgents`; a raw insert yields a row that lists fine and
   * breaks when opened.
   *
   * IDEMPOTENT BY NAME when no prefix is given. The queue key stops a replay of
   * the same job, but two separately-keyed jobs asking for the same company must
   * not produce two. Without this an instance ends up with `Test` and `Test`,
   * told apart only by their derived prefixes (`TES`, `TESA`).
   */
  async function companyCreate(payload: Record<string, unknown>): Promise<JobResult> {
    const adopt = async (companyId: string) => {
      const row = await db
        .select({ name: companies.name, issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!row) throw new PermanentJobError(`company ${companyId} not found`, "company_not_found");
      const email = readEmail(payload.ownerEmail);
      if (email) {
        // Re-assert ownership even on an existing company: this job is about
        // the owner as much as the company, and it repairs a membership
        // somebody removed by hand.
        const owner = await ensureUser(email, readString(payload.ownerName));
        await applyOwner(companyId, owner.userId);
      }
      return { companyId, name: row.name, issuePrefix: row.issuePrefix, created: false };
    };

    // An explicit uuid means "make sure this one exists and is owned".
    const explicitId = readString(payload.companyId);
    if (explicitId) return adopt(explicitId);

    const requestedPrefix = readIssuePrefix(payload.companyPrefix ?? payload.issuePrefix);
    if (payload.companyPrefix !== undefined && !requestedPrefix) {
      throw new PermanentJobError(
        "companyPrefix must be 1-12 letters or digits and contain no hyphen",
        "invalid_payload",
      );
    }

    if (requestedPrefix) {
      const held = await db
        .select({ id: companies.id })
        .from(companies)
        .where(sql`upper(${companies.issuePrefix}) = ${requestedPrefix}`)
        .then((rows) => rows[0] ?? null);
      if (held) return adopt(held.id);
      // Falls through to create, and the prefix is applied below.
    }

    const name = readString(payload.name);
    if (!name) throw new PermanentJobError("a company name is required", "invalid_payload");

    // Only when the caller gave no prefix: with one, the prefix is the identity
    // and a name collision is irrelevant.
    if (!requestedPrefix) {
      const sameName = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.name, name), eq(companies.status, "active")))
        .limit(2);
      if (sameName.length > 1) {
        throw new PermanentJobError(
          `more than one active company is named ${name}; address this job by companyPrefix`,
          "ambiguous_company",
        );
      }
      if (sameName.length === 1) return adopt(sameName[0].id);
    }

    // Plan limit, against the real count.
    const state = await store.readInstanceState();
    if (state?.maxCompanies) {
      const current = await db
        .select({ value: count() })
        .from(companies)
        .where(eq(companies.status, "active"))
        .then((rows) => Number(rows[0]?.value ?? 0));
      if (current >= state.maxCompanies) {
        // Permanent: a plan limit is a billing decision, not a transient fault.
        throw new PermanentJobError(
          `company limit reached (${current}/${state.maxCompanies})`,
          "company_limit_reached",
        );
      }
    }

    const ownerEmail = readEmail(payload.ownerEmail);
    const owner = ownerEmail ? await ensureUser(ownerEmail, readString(payload.ownerName)) : null;
    const description = readString(payload.description);

    const company = await companiesSvc.create({
      name,
      ...(description ? { description } : {}),
      // Unassigned work lands on the owner rather than nobody.
      ...(owner ? { defaultResponsibleUserId: owner.userId } : {}),
    });

    // `create` always derives its own prefix — `createCompanyWithUniquePrefix`
    // does `.values({ ...data, issuePrefix: candidate })`, so one passed in is
    // overwritten. Setting it is therefore a second step, and it is safe here
    // because a company created moments ago has no issue identifiers to rekey.
    // `resolveRenamedIssuePrefix` leaves an explicit prefix alone by design.
    let issuePrefix = company.issuePrefix;
    if (requestedPrefix && requestedPrefix !== issuePrefix.toUpperCase()) {
      try {
        const renamed = await companiesSvc.update(company.id, { issuePrefix: requestedPrefix });
        issuePrefix = renamed?.issuePrefix ?? requestedPrefix;
      } catch (err) {
        // The unique index caught a prefix another company already holds. The
        // company itself exists and is owned, so this is reported rather than
        // rolled back — but it is permanent, because the caller has to choose
        // a different prefix.
        throw new PermanentJobError(
          `issue prefix ${requestedPrefix} is already taken (company ${company.id} was created as ${issuePrefix})`,
          "issue_prefix_taken",
        );
      }
    }

    if (owner) await applyOwner(company.id, owner.userId);

    logger.info(
      { companyId: company.id, name: company.name, issuePrefix, requested: requestedPrefix },
      "provisioning: created company",
    );
    return { companyId: company.id, name: company.name, issuePrefix, created: true };
  }

  /** Owner membership plus the grants that make it mean anything. */
  async function applyOwner(companyId: string, userId: string): Promise<void> {
    await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.ensureRoleDefaultGrants(companyId, userId, "owner", null);
  }

  /** A membership AND the permission grants that make it mean anything. */
  async function membershipSet(payload: Record<string, unknown>): Promise<JobResult> {
    const email = readEmail(payload.email);
    if (!email) throw new PermanentJobError("a valid email is required", "invalid_payload");

    const role = roleFor(payload);
    const companyId = await resolveCompanyId(payload);
    const { userId, created } = await ensureUser(email, readString(payload.name));
    await assertSeatAvailable(userId, role);

    await access.ensureMembership(companyId, "user", userId, role, "active");
    // Never a hand-built grant list: this derives them from the role, so the
    // role table stays the single definition of what each role can do.
    await access.ensureRoleDefaultGrants(companyId, userId, role, null);

    logger.info({ userId, companyId, role, email }, "provisioning: applied membership");
    return { userId, companyId, role, userCreated: created };
  }


  /* ------------------------------------------------------------------ */
  /* Agents and their credentials                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the credential for a `secret.set` job.
   *
   * Three sources, in precedence order: an inline `value`, a file to read, or
   * an environment variable to read. Whichever resolves first wins.
   *
   * `valueFromEnv` is where this should end up — the container already carries
   * `OPENROUTER_API_KEY` (docker-compose passes it through), so the queue never
   * has to hold the credential at all. `value` is supported because it is what
   * the onboarding side sends today; see `secretValueIsInline` below for the
   * consequence that carries.
   *
   * Nothing resolving is PERMANENT. A secret created empty authenticates fine
   * right up until the agent's first real run, which is the expensive place to
   * discover it.
   */
  async function resolveSecretValue(payload: Record<string, unknown>): Promise<string> {
    const inline = readString(payload.value);
    if (inline) return inline;

    const fromFile = readString(payload.valueFromFile);
    if (fromFile) {
      try {
        const contents = await readFile(fromFile, "utf8");
        // Trailing newlines are normal in a mounted secret file and are not
        // part of the credential.
        const trimmed = contents.trim();
        if (trimmed) return trimmed;
        throw new PermanentJobError(`${fromFile} is empty`, "secret_source_missing");
      } catch (err) {
        if (err instanceof PermanentJobError) throw err;
        throw new PermanentJobError(
          `cannot read ${fromFile}: ${err instanceof Error ? err.message : String(err)}`,
          "secret_source_missing",
        );
      }
    }

    const fromEnv = readString(payload.valueFromEnv);
    if (fromEnv) {
      const value = readString(process.env[fromEnv]);
      if (value) return value;
      throw new PermanentJobError(
        `environment variable ${fromEnv} is not set in this container`,
        "secret_source_missing",
      );
    }

    throw new PermanentJobError(
      "one of value, valueFromFile or valueFromEnv is required",
      "secret_source_missing",
    );
  }

  /** True when the credential travelled in the job row itself. */
  function secretValueIsInline(payload: Record<string, unknown>): boolean {
    return Boolean(readString(payload.value));
  }

  /**
   * Create or rotate a company secret.
   *
   * `key` is the identity and the only thing matched on — `name` is a label
   * matched on by nothing. Several agents deliberately hold the same credential
   * under different keys, so that any one of them can be rotated later without
   * re-credentialling the rest.
   *
   * `rotate` defaults to false, so a replay is a no-op. This differs from
   * `onboard-paperclip-2.sh`, where passing the key by value always rotates and
   * therefore re-credentials every agent bound to it on each run.
   */
  async function secretSet(payload: Record<string, unknown>): Promise<JobResult> {
    const key = readString(payload.key);
    if (!key) throw new PermanentJobError("a secret key is required", "invalid_payload");
    const companyId = await resolveCompanyId(payload);

    const existing = await secretsSvc.getByKey(companyId, key);
    const rotate = payload.rotate === true;

    if (existing && !rotate) {
      // Deliberately does NOT read the source: a no-op should not require the
      // credential to still be available.
      return { secretId: existing.id, key, companyId, rotated: false, created: false };
    }

    const value = await resolveSecretValue(payload);

    if (existing) {
      await secretsSvc.rotate(existing.id, { value });
      logger.info({ secretId: existing.id, key, companyId }, "provisioning: rotated secret");
      return { secretId: existing.id, key, companyId, rotated: true, created: false };
    }

    const created = await secretsSvc.create(companyId, {
      name: readString(payload.name) ?? key,
      // The instance is configured `local_encrypted` (PAPERCLIP_SECRETS_PROVIDER),
      // which is the only provider that takes a literal value.
      provider: "local_encrypted",
      key,
      value,
      ...(readString(payload.description) ? { description: readString(payload.description) } : {}),
    });

    // The value is never echoed — not here, not in `result`. A log line naming
    // the key is enough to trace what happened.
    logger.info({ secretId: created.id, key, companyId }, "provisioning: created secret");
    return { secretId: created.id, key, companyId, rotated: false, created: true };
  }

  /**
   * Resolve one of the secret keys an `agent.create` binds, in the job's target
   * company.
   *
   * Parked rather than failed when the key is absent: the `secret.set` that
   * creates it may simply not have run yet, which is what makes the enqueue
   * order between the two irrelevant.
   *
   * `field` is in the message on purpose. An agent now resolves TWO secrets —
   * its credential and its codex home — and a bare "secret not found" sends
   * whoever reads it to the wrong half of the payload.
   */
  async function resolveAgentSecretId(
    companyId: string,
    key: string,
    field: "secretKey" | "codexHome",
  ): Promise<string> {
    const secret = await secretsSvc.getByKey(companyId, key);
    if (!secret) {
      throw new ParkJobError(`waiting for secret ${key} (${field}) in this company`);
    }
    return secret.id;
  }

  /**
   * Normalise one adapter `env` entry to the two facts worth comparing.
   *
   * A persisted binding is not byte-identical to the one built here: a plain
   * value may be stored as a bare string, and a `secret_ref` carries a
   * `version` this handler never sends. Comparing objects literally would
   * report a difference on every pass and rewrite the agent — and a revision —
   * each time a job replayed.
   */
  function envBindingIdentity(value: unknown): string | null {
    if (typeof value === "string") return value.trim() ? `plain:${value}` : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.type === "plain") {
      return typeof record.value === "string" ? `plain:${record.value}` : null;
    }
    if (record.type === "secret_ref") {
      return typeof record.secretId === "string" ? `secret_ref:${record.secretId}` : null;
    }
    // Anything else — a user_secret_ref, or a shape added later — is compared
    // whole. Getting this wrong costs a redundant update, never a lost binding.
    return `other:${JSON.stringify(record)}`;
  }

  /**
   * Save the `paperclip` skill into a new agent's skill list.
   *
   * Claude and Codex agents already receive it at run time without it being
   * saved (`resolveLegacyPaperclipDesiredSkillNames`), so this changes nothing
   * about what the agent can do. It changes what the company skill page can
   * see: that page lists only agents whose SAVED list names the skill, so every
   * provisioned agent was missing from it. Mirrors `defaultRoleSkillSelections`
   * in routes/agents.ts, which this module bypasses by calling the service.
   *
   * Create only. The operator chose new agents only (2026-09-11), so
   * `reconcileAgent` does not add it to agents that already exist.
   */
  function withDefaultPaperclipSkill(adapterType: string, adapterConfig: Record<string, unknown>) {
    // Native runners get the same authority through their protocol and reject
    // the legacy skill; adapters without skill sync have nowhere to save it.
    if (adapterType === "paperclip_runner") return adapterConfig;
    const adapter = findActiveServerAdapter(adapterType);
    if (!adapter?.listSkills && !adapter?.syncSkills) return adapterConfig;
    return writePaperclipSkillSyncPreference(adapterConfig, [
      { key: PAPERCLIP_OPERATIONAL_SKILL_KEY, versionId: null },
    ]);
  }

  /**
   * Apply an `agent.create` payload to the agent that already carries its name.
   *
   * Merges rather than replaces: entries the payload does not mention are left
   * exactly as they are. That protects the per-agent `CODEX_HOME` the server's
   * own isolation guard writes, and any variable a person added by hand, from
   * being erased by a queue row that never knew about them.
   */
  async function reconcileAgent(
    existing: { id: string; adapterConfig: unknown },
    desired: {
      name: string;
      companyId: string;
      env: Record<string, unknown>;
      model: string | null;
      secretKey: string | null;
      secretEnv: string;
      codexHomeKey: string | null;
      codexHomeSecretId: string | null;
      secretId: string | null;
    },
  ): Promise<JobResult> {
    const currentConfig =
      existing.adapterConfig && typeof existing.adapterConfig === "object" && !Array.isArray(existing.adapterConfig)
        ? { ...(existing.adapterConfig as Record<string, unknown>) }
        : {};
    const currentEnv =
      currentConfig.env && typeof currentConfig.env === "object" && !Array.isArray(currentConfig.env)
        ? { ...(currentConfig.env as Record<string, unknown>) }
        : {};

    // Named so the log line says what moved. An operator reading "updated
    // agent" with no fields cannot tell a real change from a churned revision.
    const changed: string[] = [];
    const nextEnv = { ...currentEnv };
    for (const [varName, binding] of Object.entries(desired.env)) {
      if (envBindingIdentity(currentEnv[varName]) === envBindingIdentity(binding)) continue;
      nextEnv[varName] = binding;
      changed.push(`env.${varName}`);
    }
    if (desired.model && currentConfig.model !== desired.model) changed.push("model");

    if (changed.length === 0) {
      return {
        agentId: existing.id,
        name: desired.name,
        companyId: desired.companyId,
        secretId: desired.secretId,
        codexHomeSecretId: desired.codexHomeSecretId,
        created: false,
        updated: false,
      };
    }

    const nextConfig: Record<string, unknown> = { ...currentConfig, env: nextEnv };
    if (desired.model) nextConfig.model = desired.model;

    // Only `adapterConfig`. `adapterType` and `permissions` are deliberately
    // not re-asserted on an agent that already exists: switching an adapter
    // under a running agent is destructive, and permissions may have been
    // narrowed on purpose after provisioning.
    const updated = await agentsSvc.update(existing.id, { adapterConfig: nextConfig });
    if (!updated) {
      // Listed a moment ago and gone now — a delete raced this job. Park: a
      // replay either finds it again or creates it.
      throw new ParkJobError(`agent ${desired.name} disappeared while being updated`);
    }

    logger.info(
      {
        agentId: existing.id,
        name: desired.name,
        companyId: desired.companyId,
        changed,
        codexHomeKey: desired.codexHomeKey,
        boundTo: desired.secretEnv,
      },
      "provisioning: updated agent",
    );
    return {
      agentId: existing.id,
      name: desired.name,
      companyId: desired.companyId,
      secretId: desired.secretId,
      codexHomeSecretId: desired.codexHomeSecretId,
      created: false,
      updated: true,
      changed,
    };
  }

  /**
   * Create — or reconcile — an agent bound to its company secrets.
   *
   * The binding is a `secret_ref`, not a host environment variable. Resolved
   * adapter env is merged AFTER the host-env projection and is not filtered by
   * it, so a bound key always reaches the child process where a host-exported
   * one depends on the allowlist.
   *
   * Identity is the agent's NAME within the company, and only the name. The
   * queue key stops a replay, but two separately-keyed jobs naming the same
   * agent must not produce two agents, and a job whose payload has moved on —
   * a new model, a different `codexHome` key — must UPDATE the one that exists
   * rather than no-op. A no-op there is what leaves an instance provisioned
   * before this change bound to a codex home nobody maintains, with the queue
   * reporting success: the exact silent state this contract exists to remove.
   *
   * An omitted field asserts nothing. `model`, `codexHome`, `secretKey` and
   * `env` are each applied only when present, so a partial payload cannot strip
   * configuration a person (or the server's own isolation guard) put there.
   */
  async function agentCreate(payload: Record<string, unknown>): Promise<JobResult> {
    const name = readString(payload.name);
    if (!name) throw new PermanentJobError("an agent name is required", "invalid_payload");
    const companyId = await resolveCompanyId(payload);

    // Resolved BEFORE the create/update split, so both paths park on the same
    // condition. An existing agent whose new codex-home secret has not landed
    // yet must wait for it, not silently keep the binding it already has.
    const secretKey = readString(payload.secretKey);
    const secretId = secretKey ? await resolveAgentSecretId(companyId, secretKey, "secretKey") : null;

    // `codexHome` NAMES A SECRET KEY, not a path — the contract changed on
    // 2026-09-07 and the field's type did not, so an old payload and a new one
    // are indistinguishable by shape. The discriminator is that a secret key
    // never begins with `/` (nor `~`, the other path form the adapter calls
    // out). A path-shaped value is a payload written against the retired
    // contract and fails PERMANENTLY rather than being honoured as a literal:
    // an instance half on each contract, with nothing showing which, is exactly
    // the silent failure this change exists to remove.
    const codexHomeKey = readString(payload.codexHome);
    if (codexHomeKey && /^[/~]/.test(codexHomeKey)) {
      throw new PermanentJobError(
        `codexHome must name a company secret, not a path (got ${codexHomeKey})`,
        "codex_home_not_a_secret_key",
      );
    }
    const codexHomeSecretId = codexHomeKey
      ? await resolveAgentSecretId(companyId, codexHomeKey, "codexHome")
      : null;

    // The binding VARIABLE NAME is payload-driven, not a constant: it has to
    // match whatever the vault's config.toml auth command actually reads. A
    // secret bound to a name nothing looks at is configured-looking and 401s on
    // the agent's first run.
    const secretEnv = readString(payload.secretEnv) ?? "OPENROUTER_API_KEY";
    const env: Record<string, unknown> = {};

    // Any extra plain variables the caller wants in the agent's environment,
    // as a flat { NAME: "value" } map. Applied first so the two derived
    // entries below win on a collision — `codexHome` and `secretKey` are the
    // explicit way to set those two, and a plain string smuggled in here for
    // CODEX_HOME would silently beat the field that exists for it.
    const extraEnv = payload.env;
    if (extraEnv && typeof extraEnv === "object" && !Array.isArray(extraEnv)) {
      // `varName`, not `name`: the agent's own name is in scope here and
      // shadowing it is how the wrong string ends up in the wrong field.
      for (const [varName, raw] of Object.entries(extraEnv as Record<string, unknown>)) {
        const value = readString(raw);
        // Empty values are dropped rather than bound to "": binding a variable
        // to an empty string is a different fact from leaving it unset, and the
        // adapters read it that way.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) || !value) continue;
        env[varName] = { type: "plain", value };
      }
    }

    // Bound the same way the credential is, so the path exists in exactly one
    // place and every agent naming that key moves with it. `secret_ref` is
    // available here rather than assumed: `codexLocalEnvKeyConfigured`
    // (routes/agents.ts) already counts a `secret_ref` CODEX_HOME as
    // configured, `resolveAdapterConfigForRuntime` dereferences env bindings
    // before the adapter is invoked, and the fork's own device-login flow
    // creates a `CODEX_HOME_<handle>` secret for agents to bind to.
    //
    // One visible consequence: an env var resolved from a secret is added to
    // the run's `secretKeys`, so CODEX_HOME reads `***REDACTED***` in the
    // `adapter.invoke` event. That is the log line only — the child process
    // receives the resolved path.
    //
    // Omitted rather than sent empty: an absent codexHome means the
    // Paperclip-managed home, directly. There is no environment fallback —
    // `PAPERCLIP_CODEX_HOME` is retired on this path, so an omission cannot
    // quietly mean "whatever this container was configured with".
    if (codexHomeSecretId) env.CODEX_HOME = { type: "secret_ref", secretId: codexHomeSecretId };
    if (secretId) env[secretEnv] = { type: "secret_ref", secretId };

    const model = readString(payload.model);
    const adapterConfig: Record<string, unknown> = { env };
    // Never send model:"" — an empty string suppresses the --model flag the
    // vault relies on, which is not the same as leaving it unset.
    if (model) adapterConfig.model = model;

    const existing = await agentsSvc
      .list(companyId)
      .then((rows) => rows.find((row) => row.name === name) ?? null);
    if (existing) {
      return reconcileAgent(existing, { name, companyId, env, model, secretKey, secretEnv, codexHomeKey, codexHomeSecretId, secretId });
    }

    const adapterType = readString(payload.adapterType) ?? "codex_local";
    const agent = await agentsSvc.create(companyId, {
      name,
      adapterType,
      adapterConfig: withDefaultPaperclipSkill(adapterType, adapterConfig),
      // Only sent when it actually changes a default.
      ...(payload.canCreateAgents === true ? { permissions: { canCreateAgents: true } } : {}),
    });

    await seedDefaultInstructions(agent);

    logger.info(
      {
        agentId: agent.id,
        name,
        companyId,
        model,
        secretKey,
        boundTo: secretEnv,
        codexHomeKey,
        // An explicit codex home is a HAND-OFF: Codex treats that home as
        // user-managed, so Paperclip will not seed auth into it, will not merge
        // PAPERCLIP_CODEX_PROVIDERS and will not rewrite its config.toml. The
        // vault at that path has to carry a working config.toml whose auth
        // command reads the same variable `secretEnv` names, and neither side
        // can detect a mismatch — it is configured-looking and 401s on the
        // first real run.
        ...(codexHomeKey ? { authSeeding: "skipped: explicit codexHome" } : {}),
      },
      "provisioning: created agent",
    );
    return { agentId: agent.id, name, companyId, secretId, codexHomeSecretId, created: true };
  }

  /**
   * Find an existing `user` row by address, without creating one.
   *
   * Matched on `lower(email)`, the same way `ensureUser` writes it and
   * `resolveProxyHeaderUser` reads it. If those three ever disagreed about
   * which row an address means, a revocation would archive somebody else's
   * memberships — which is the one mistake here that cannot be undone by
   * re-running the job.
   */
  async function findUserByEmail(email: string): Promise<{ id: string } | null> {
    return db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`)
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Refuse a revocation that would leave a company without an active owner, or
   * the instance without an admin — BEFORE anything is archived.
   *
   * `archiveMember` performs the owner check itself, inside its own
   * transaction, per company. That is correct but it is checked too late for
   * this job: a person can hold memberships in several companies, each archived
   * in its own transaction, so a conflict raised on the third would leave the
   * first two already archived and the job permanently failed — a half-revoked
   * person nobody asked for. Checking every target first makes the normal
   * failure all-or-nothing.
   *
   * The instance-admin half is an ADDITION to what the control plane asked for.
   * Its stated reason for the owner guard — "we would rather see `last_owner`
   * in the queue than an instance nobody can administer" — applies with equal
   * force to the last `instance_admin`, who is the only principal that can
   * create companies. Remove it if you would rather the queue never blocked on
   * this.
   */
  async function assertRevocationLeavesAnAdmin(
    userId: string,
    memberships: Array<{ id: string; companyId: string; status: string; membershipRole: string | null }>,
  ): Promise<void> {
    for (const membership of memberships) {
      if (membership.status !== "active" || membership.membershipRole !== "owner") continue;
      const [{ owners }] = await db
        .select({ owners: count() })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, membership.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            eq(companyMemberships.membershipRole, "owner"),
          ),
        );
      if (owners <= 1) {
        throw new PermanentJobError(
          `removing this person would leave company ${membership.companyId} with no active owner`,
          "last_owner",
        );
      }
    }

    const holdsInstanceAdmin = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows.length > 0);
    if (!holdsInstanceAdmin) return;

    const [{ admins }] = await db
      .select({ admins: count() })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));
    if (admins <= 1) {
      throw new PermanentJobError(
        "removing this person would leave the instance with no instance admin",
        "last_instance_admin",
      );
    }
  }

  /**
   * Revoke a person's access. The ONLY job type that takes something away.
   *
   * Every other handler asserts a desired state and converges on it, so a
   * replay is harmless by construction. This one is different in kind, and two
   * things follow from that.
   *
   * ARCHIVE, NEVER DELETE. 125 columns across this database hold a user id and
   * only 5 carry a foreign key to `user`. A `DELETE` would succeed, cascade
   * those 5, and leave up to 120 columns pointing at an id that no longer
   * exists — issues assigned to nobody, comments by nobody, approvals decided
   * by nobody, with no error anywhere. `company_memberships.principal_id` is
   * among the unconstrained ones because it is polymorphic.
   *
   * NO COMPANY NAMED MEANS EVERY COMPANY. That is the opposite of
   * `membership.set`, deliberately: adding somebody to every company is a
   * decision, removing them is not. A payload that does name one is read as
   * "just this one".
   */
  async function membershipRemove(payload: Record<string, unknown>): Promise<JobResult> {
    const email = readEmail(payload.email);
    if (!email) throw new PermanentJobError("a valid email is required", "invalid_payload");

    const user = await findUserByEmail(email);
    if (!user) {
      // SUCCESS, not failure. Somebody removed before they were ever
      // provisioned is the ordinary case — a person who signed up and left
      // without signing in — and a permanent error would put a red row on a
      // healthy instance for a job that has nothing to do.
      logger.info({ email }, "provisioning: nothing to revoke, no such user");
      return { email, removed: false, reason: "no_such_user" };
    }

    // An explicitly named company narrows this to that one. `companyName` is
    // read through `readString` so an empty string does not count as naming
    // one — an empty name must not silently become "revoke everywhere".
    const namesCompany =
      readString(payload.companyId) !== null ||
      payload.companyPrefix !== undefined ||
      readString(payload.companyName) !== null;
    const scopedCompanyId = namesCompany ? await resolveCompanyId(payload) : null;

    const memberships = await db
      .select({
        id: companyMemberships.id,
        companyId: companyMemberships.companyId,
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, user.id),
          ...(scopedCompanyId ? [eq(companyMemberships.companyId, scopedCompanyId)] : []),
        ),
      );

    await assertRevocationLeavesAnAdmin(user.id, memberships);

    // `archiveMember` is the right primitive rather than `setUserCompanyAccess`,
    // which looks closer but refuses this job outright: it throws
    // "Owners and admins cannot be removed from company access" and
    // "Instance admins cannot be removed", guards written for a person editing
    // access in the UI. The Outseta primary contact arrives as `admin`, so that
    // path would refuse the common case. `archiveMember` carries the guard that
    // matters here — the last active owner — and nothing else.
    //
    // It also reassigns the person's open issues and resets anything
    // `in_progress` back to `todo`, which plain membership archival does not.
    // Work does not silently belong to somebody who no longer exists.
    const archived: string[] = [];
    let reassignedIssues = 0;
    for (const membership of memberships) {
      // Already archived returns the row with a zero count, so a replay is a
      // no-op rather than an error.
      const result = await access.archiveMember(membership.companyId, membership.id);
      if (!result) continue;
      if (membership.status !== "archived") archived.push(membership.companyId);
      reassignedIssues += result.reassignedIssueCount;
    }

    // Instance-admin is instance-wide, so it only goes when the revocation is
    // instance-wide. Scoping to one company and silently stripping it would
    // remove access the payload never mentioned.
    const demoted = scopedCompanyId ? null : await access.demoteInstanceAdmin(user.id);

    // CREDENTIALS THAT ALREADY EXIST, and the reason this is not optional.
    // Archiving a membership stops AUTHORISATION, but a live session cookie or
    // a board API key is a credential already in somebody's hands. A person
    // removed from the account should stop being able to act, not stop being
    // able to start. Skipped for a company-scoped removal, where the person
    // legitimately keeps access to everything else.
    let sessionsRevoked = 0;
    let apiKeysRevoked = 0;
    if (!scopedCompanyId) {
      sessionsRevoked = await db
        .delete(authSessions)
        .where(eq(authSessions.userId, user.id))
        .returning({ id: authSessions.id })
        .then((rows) => rows.length);
      // Revoked, not deleted — `board_api_keys` carries `revoked_at` for
      // exactly this, and the row is the audit record of a key having existed.
      apiKeysRevoked = await db
        .update(boardApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(boardApiKeys.userId, user.id), isNull(boardApiKeys.revokedAt)))
        .returning({ id: boardApiKeys.id })
        .then((rows) => rows.length);
    }

    logger.info(
      {
        userId: user.id,
        email,
        scope: scopedCompanyId ?? "instance",
        companiesArchived: archived.length,
        reassignedIssues,
        instanceAdminDemoted: Boolean(demoted),
        sessionsRevoked,
        apiKeysRevoked,
      },
      "provisioning: revoked access",
    );

    return {
      userId: user.id,
      email,
      removed: true,
      scope: scopedCompanyId ?? "instance",
      companiesArchived: archived.length,
      companies: archived,
      reassignedIssues,
      instanceAdminDemoted: Boolean(demoted),
      sessionsRevoked,
      apiKeysRevoked,
    };
  }

  /**
   * Resolve an agent by NAME within a company.
   *
   * Same rule as `secretKey` and `codexHome`: the onboarding side names things
   * and this side resolves them, because it cannot know a uuid. PARKS when the
   * name does not resolve — on a fresh instance a task queued behind a plan
   * expansion can arrive seconds before the `agent.create` that makes it.
   */
  async function resolveAgentByName(companyId: string, agentName: string) {
    // `includeTerminated` deliberately. `list` hides terminated agents by
    // default, and without this a task addressed to one would look like a task
    // addressed to an agent that does not exist yet — so it would PARK, waiting
    // for a condition that never arrives, invisible to the queue check by
    // design. Found it here rather than in production. Resolving it means the
    // create below refuses it loudly as `agent_not_assignable` instead.
    const agent = await agentsSvc
      .list(companyId, { includeTerminated: true })
      .then((rows) => rows.find((row) => row.name === agentName) ?? null);
    if (!agent) {
      // The name is in the message on purpose: a task resolves a company AND an
      // agent, and "not found" without it sends the reader to the wrong half of
      // the payload.
      throw new ParkJobError(`waiting for agent ${agentName} in this company`);
    }
    return agent;
  }

  /** The board label when the payload sends none: the command's first line. */
  function firstLine(command: string): string {
    const line = command.split("\n", 1)[0]?.trim() ?? "";
    // Never empty — `readString` already rejected an all-whitespace command, so
    // a blank first line means the command starts with newlines and the second
    // line is the real one.
    const source = line || command.trim();
    return source.length > 80 ? `${source.slice(0, 79).trimEnd()}…` : source;
  }

  /**
   * Give a named agent a piece of work.
   *
   * There is no task table in Paperclip and no RPC to call: the unit of work is
   * an ISSUE, and assigning it is setting `issues.assignee_agent_id`. So this
   * creates one issue, assigned, and then wakes the agent.
   *
   * THIS IS THE FIRST JOB TYPE THAT SPENDS MONEY ON BEING APPLIED. Every other
   * payload describes state to converge on; this one is a command an agent runs
   * with its own credentials. Two things follow, and both are load-bearing
   * below: the status must not silently be one that wakes nobody, and a
   * re-queued row must not buy the same run twice.
   */
  async function agentTask(
    payload: Record<string, unknown>,
    job: ProvisioningJobContext,
  ): Promise<JobResult> {
    const agentName = readString(payload.agentName);
    const command = readString(payload.command);
    if (!agentName || !command) {
      throw new PermanentJobError(
        "agentName and command are both required",
        "invalid_payload",
      );
    }

    // Validated here rather than left to the insert. An unknown status is a
    // `text` column with no check constraint, so it would be written happily
    // and produce an issue no board shows and no agent picks up.
    const status = readString(payload.status) ?? "todo";
    if (!(ISSUE_STATUSES as readonly string[]).includes(status)) {
      throw new PermanentJobError(`unknown issue status ${status}`, "invalid_payload");
    }
    const priority = readString(payload.priority);
    if (priority && !(ISSUE_PRIORITIES as readonly string[]).includes(priority)) {
      throw new PermanentJobError(`unknown issue priority ${priority}`, "invalid_payload");
    }

    const companyId = await resolveCompanyId(payload);
    const agent = await resolveAgentByName(companyId, agentName);

    // `issues.status` defaults to `backlog`, and a backlog issue wakes nobody
    // (`issue-assignment-wakeup.ts`). So the default here is `todo` — the
    // status is load-bearing, not decoration, and inheriting the column default
    // would queue work that sits there showing every other sign of success.
    //
    // `backlog` remains a legitimate thing to ask for — put it on the board, do
    // not start it — which is why it is accepted rather than rejected, and why
    // `wakeupQueued` is in the result: "the job succeeded and the agent did
    // nothing" has to be distinguishable from a broken wakeup.
    const title = readString(payload.title) ?? firstLine(command);

    // TWO LAYERS OF IDEMPOTENCY, AND BOTH ARE NEEDED. The queue's own key stops
    // this ROW being applied twice; it does nothing about a second row being
    // queued, which is the normal case — every account callback re-asserts the
    // whole plan, and operator commands key on the clock deliberately. So the
    // task's own key goes through to `issueService.create`, which returns the
    // existing issue instead of creating a second one and a second agent run.
    //
    // The window is seven days (ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS),
    // after which the same taskKey creates a new issue. That is right for a
    // recurring task and wrong to lean on as a unique constraint.
    const idempotencyKey = readString(payload.taskKey) ?? job.idempotencyKey;

    let deduplicated = false;
    let issue: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      issue = await issuesSvc.create(companyId, {
        title,
        description: command,
        assigneeAgentId: agent.id,
        status,
        ...(priority ? { priority } : {}),
        idempotencyKey,
        onDeduplicated: () => {
          deduplicated = true;
        },
      });
    } catch (err) {
      // `assertAssignableAgent` throws a 409 carrying `agent_not_assignable`
      // and the reason (terminated, pending_approval, a broken org chain). None
      // of those change on a retry, so they are permanent here rather than
      // spending the failure budget five times over.
      throw asPermanentAssignmentError(err, agentName);
    }

    // AFTER THE COMMIT, NEVER INSIDE IT. The wakeup is the only part of this
    // that is not the database's problem, and the issues route does the same:
    // create, commit, then wake, fire-and-forget, so a scheduler hiccup cannot
    // fail an issue that was created.
    //
    // Not woken when the issue was deduplicated: the run it would wake for was
    // already bought by the job that created it.
    const wakeupSkipped = deduplicated
      ? "deduplicated"
      : status === "backlog"
        ? "backlog"
        : !heartbeat
          ? "heartbeat_scheduler_disabled"
          : null;
    const wakeupQueued = wakeupSkipped === null;
    if (wakeupQueued && heartbeat) {
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "provisioning.agent.task",
        requestedByActorType: "system",
        taskKey: readString(payload.taskKey),
      });
    }

    logger.info(
      {
        issueId: issue.id,
        identifier: issue.identifier,
        companyId,
        agentId: agent.id,
        agentName,
        status,
        deduplicated,
        wakeupQueued,
        ...(wakeupSkipped ? { wakeupSkipped } : {}),
      },
      "provisioning: dispatched agent task",
    );

    // `identifier` is the one a person can act on — it is what the URL and
    // every comment thread use — so it is in the result for the control plane
    // to record against the account.
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      companyId,
      agentId: agent.id,
      deduplicated,
      wakeupQueued,
      ...(wakeupSkipped ? { wakeupSkipped } : {}),
    };
  }

  const handlers: Record<
    string,
    (payload: Record<string, unknown>, job: ProvisioningJobContext) => Promise<JobResult>
  > = {
    "instance.state": instanceState,
    "user.upsert": userUpsert,
    "company.create": companyCreate,
    "membership.set": membershipSet,
    "membership.remove": membershipRemove,
    "secret.set": secretSet,
    "agent.create": agentCreate,
    "agent.task": agentTask,
  };

  return {
    /**
     * True when this job type carried a credential in its payload, so the
     * worker can clear the row after it succeeds. A `secret.set` with an inline
     * `value` is the one exception to keeping terminal rows intact: the audit
     * trail should record what happened without retaining the key.
     */
    carriesCredential(jobType: string, payload: Record<string, unknown>): boolean {
      return jobType === "secret.set" && secretValueIsInline(payload);
    },

    async run(
      jobType: string,
      payload: Record<string, unknown>,
      job: ProvisioningJobContext,
    ): Promise<JobResult> {
      const handler = handlers[jobType];
      // Known to the vocabulary but not built yet: park it rather than fail it.
      // The enqueuer keys on content, so a terminal row is never re-queued and
      // failing here would kill the job for good — including after we ship the
      // handler it was waiting for.
      if (!handler) throw new ParkJobError(`no handler built for ${jobType} yet`);
      return handler(payload, job);
    },
  };
}
