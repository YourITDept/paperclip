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
import { and, count, countDistinct, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships } from "@paperclipai/db";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
import { accessService } from "../services/access.js";
import { companyService } from "../services/companies.js";
import { normalizeHumanRole } from "../services/company-member-roles.js";
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

export function provisioningHandlers(db: Db, store: ProvisioningStore) {
  const access = accessService(db);
  const companiesSvc = companyService(db);

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

  const handlers: Record<string, (payload: Record<string, unknown>) => Promise<JobResult>> = {
    "instance.state": instanceState,
    "user.upsert": userUpsert,
    "company.create": companyCreate,
    "membership.set": membershipSet,
  };

  return {
    async run(jobType: string, payload: Record<string, unknown>): Promise<JobResult> {
      const handler = handlers[jobType];
      // Known to the vocabulary but not built yet: park it rather than fail it.
      // The enqueuer keys on content, so a terminal row is never re-queued and
      // failing here would kill the job for good — including after we ship the
      // handler it was waiting for.
      if (!handler) throw new ParkJobError(`no handler built for ${jobType} yet`);
      return handler(payload);
    },
  };
}
