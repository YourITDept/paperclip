import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { provisioningHandlers } from "../provisioning/handlers.js";
import { isKnownJobType, provisioningStore } from "../provisioning/store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping provisioning agent.task tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * `agent.task` — giving a named agent work through the same queue that
 * provisions it. The contract is in the onboarding repo's
 * `outseta-paperclip-integration/docs/06-AGENT-TASKS.md`.
 *
 * This is the first job type that SPENDS MONEY on being applied, so the two
 * tests that matter most are the two about not spending it twice and not
 * spending it never: the `taskKey` dedupe, and the `todo` default that stops a
 * task inheriting the `backlog` column default and waking nobody.
 */
describeEmbeddedPostgres("provisioning agent.task", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-provisioning-agent-task-${randomUUID()}`);

  /**
   * Stands in for the process heartbeat. Records what it was asked to wake and
   * with what, so a test can prove the wakeup carried the assignee's id rather
   * than merely that some call happened.
   */
  let wakeups: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
  const heartbeat = {
    wakeup: async (agentId: string, opts: Record<string, unknown>) => {
      wakeups.push({ agentId, opts });
      return null;
    },
  };

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("provisioning-agent-task");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  beforeEach(() => {
    wakeups = [];
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  function handlers(opts: { heartbeat?: typeof heartbeat | null } = {}) {
    return provisioningHandlers(db, provisioningStore(db), {
      heartbeat: opts.heartbeat === undefined ? heartbeat : opts.heartbeat,
    });
  }

  /** A job row's context, as the worker hands it to a handler. */
  function jobContext(idempotencyKey = `job-${randomUUID()}`) {
    return { idempotencyKey };
  }

  async function seedCompany(name = "Test Company 1") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 2)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  const AGENT_NAME = "OpenRouter Codex Agent";

  async function seedAgent(companyId: string, name = AGENT_NAME) {
    return agentService(db).create(companyId, { name, adapterType: "codex_local", adapterConfig: {} });
  }

  const COMMAND =
    "Report which large language model you are actually running.\nYou were provisioned to run `openai/gpt-5.6-luna`.";

  function taskPayload(companyId: string, overrides: Record<string, unknown> = {}) {
    return {
      companyId,
      agentName: AGENT_NAME,
      title: "Which model is OpenRouter Codex Agent running?",
      command: COMMAND,
      status: "todo",
      taskKey: "report-model-codex",
      ...overrides,
    };
  }

  it("is in the job vocabulary, so an early row parks instead of dying", () => {
    // The worker fails an unregistered type PERMANENTLY, and content-addressed
    // keys mean a terminal row is never re-queued — so the name has to be here
    // before anything enqueues one.
    expect(isKnownJobType("agent.task")).toBe(true);
  });

  it("creates an issue assigned to the named agent and wakes it", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);

    const result = await handlers().run("agent.task", taskPayload(companyId), jobContext());

    expect(result).toMatchObject({
      companyId,
      agentId: agent.id,
      deduplicated: false,
      wakeupQueued: true,
    });
    // `identifier` is what a person can act on — the URL and every comment
    // thread use it — so the control plane has to get it back.
    expect(result.identifier).toMatch(/^T[A-Z0-9]+-\d+$/);

    const [issue] = await db.select().from(issues).where(eq(issues.id, result.issueId as string));
    expect(issue.assigneeAgentId).toBe(agent.id);
    expect(issue.description).toBe(COMMAND);
    expect(issue.status).toBe("todo");

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0].agentId).toBe(agent.id);
    expect(wakeups[0].opts).toMatchObject({ source: "assignment", reason: "issue_assigned" });
  });

  it("defaults the status to todo, not the backlog column default", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);

    // `issues.status` defaults to `backlog`, and a backlog issue wakes nobody.
    // A payload that says nothing about status must NOT inherit that: it would
    // queue work that sits there with every other sign of success.
    const result = await handlers().run(
      "agent.task",
      taskPayload(companyId, { status: undefined }),
      jobContext(),
    );

    const [issue] = await db.select().from(issues).where(eq(issues.id, result.issueId as string));
    expect(issue.status).toBe("todo");
    expect(result.wakeupQueued).toBe(true);
    expect(wakeups[0].agentId).toBe(agent.id);
  });

  it("accepts backlog, wakes nobody, and says so", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);

    const result = await handlers().run(
      "agent.task",
      taskPayload(companyId, { status: "backlog" }),
      jobContext(),
    );

    // "The job succeeded and the agent did nothing" has to be distinguishable
    // from a broken wakeup, which is the whole reason this is in the result.
    expect(result).toMatchObject({ wakeupQueued: false, wakeupSkipped: "backlog" });
    expect(wakeups).toHaveLength(0);
  });

  it("deduplicates a re-queued task on taskKey — one issue, one run", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);

    // A re-queued task is the NORMAL case: every account callback re-asserts
    // the whole plan. Two different job rows, same taskKey.
    const first = await handlers().run("agent.task", taskPayload(companyId), jobContext("job-a"));
    const second = await handlers().run("agent.task", taskPayload(companyId), jobContext("job-b"));

    expect(second.issueId).toBe(first.issueId);
    expect(second).toMatchObject({ deduplicated: true, wakeupQueued: false, wakeupSkipped: "deduplicated" });
    expect(await db.select().from(issues)).toHaveLength(1);
    // The second run was already bought by the first. Waking again would pay
    // for the same work twice.
    expect(wakeups).toHaveLength(1);
  });

  it("falls back to the job's own idempotency key when no taskKey is sent", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);
    const payload = taskPayload(companyId, { taskKey: undefined });

    const first = await handlers().run("agent.task", payload, jobContext("job-same"));
    const second = await handlers().run("agent.task", payload, jobContext("job-same"));
    expect(second.issueId).toBe(first.issueId);
    expect(second.deduplicated).toBe(true);

    // A different job row with no taskKey is a different assertion, so it is a
    // different issue — the queue key is the fallback, not a title match.
    const third = await handlers().run("agent.task", payload, jobContext("job-other"));
    expect(third.issueId).not.toBe(first.issueId);
  });

  it("parks — naming the agent — until agent.create has landed", async () => {
    const companyId = await seedCompany();

    // A task queued behind a plan expansion arrives seconds before its agent on
    // a fresh instance, so this must park rather than fail.
    await expect(handlers().run("agent.task", taskPayload(companyId), jobContext())).rejects.toThrow(
      /waiting for agent OpenRouter Codex Agent/,
    );
    expect(await db.select().from(issues)).toHaveLength(0);

    await seedAgent(companyId);
    const result = await handlers().run("agent.task", taskPayload(companyId), jobContext());
    expect(result.wakeupQueued).toBe(true);
  });

  it("fails permanently on a payload that can never work", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);

    await expect(
      handlers().run("agent.task", taskPayload(companyId, { command: undefined }), jobContext()),
    ).rejects.toMatchObject({ code: "invalid_payload" });

    // `issues.status` is plain text with no check constraint, so a typo would
    // otherwise be written happily and produce an issue nothing picks up.
    await expect(
      handlers().run("agent.task", taskPayload(companyId, { status: "to-do" }), jobContext()),
    ).rejects.toMatchObject({ code: "invalid_payload" });

    await expect(
      handlers().run("agent.task", taskPayload(companyId, { priority: "urgent" }), jobContext()),
    ).rejects.toMatchObject({ code: "invalid_payload" });

    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("fails permanently, not five times, when the agent cannot take work", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    await agentService(db).update(agent.id, { status: "terminated" });

    // Paperclip already produces `agent_not_assignable` with a reason; reusing
    // its code keeps one vocabulary in front of the operator. Retrying would
    // spend the failure budget on an answer that cannot change.
    await expect(handlers().run("agent.task", taskPayload(companyId), jobContext())).rejects.toMatchObject({
      code: "agent_not_assignable",
    });
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("titles an untitled task from the command's first line", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);
    const long = `${"x".repeat(200)}\nsecond line`;

    const result = await handlers().run(
      "agent.task",
      taskPayload(companyId, { title: undefined, command: long }),
      jobContext(),
    );

    const [issue] = await db.select().from(issues).where(eq(issues.id, result.issueId as string));
    expect(issue.title.length).toBeLessThanOrEqual(80);
    expect(issue.title.startsWith("xxx")).toBe(true);
    expect(issue.title).not.toContain("second line");
  });

  it("still creates the issue when there is no scheduler to wake", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId);

    // HEARTBEAT_SCHEDULER_ENABLED=false. The handler must not build its own
    // heartbeat to get around this — a second scheduler in one process claims
    // runs the first one owns.
    const result = await handlers({ heartbeat: null }).run(
      "agent.task",
      taskPayload(companyId),
      jobContext(),
    );

    expect(result).toMatchObject({
      wakeupQueued: false,
      wakeupSkipped: "heartbeat_scheduler_disabled",
    });
    expect(await db.select().from(issues)).toHaveLength(1);
  });
});
