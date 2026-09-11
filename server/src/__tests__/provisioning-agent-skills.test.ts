import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { provisioningHandlers } from "../provisioning/handlers.js";
import { provisioningStore } from "../provisioning/store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping provisioning skill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * FORK-CARRIED (CustomCodeDoc §4 change set 11).
 *
 * The company skill page lists only agents whose SAVED skill list names the
 * skill. Claude and Codex agents receive the `paperclip` skill at run time
 * without it being saved, and `agent.create` saved no skills at all, so no
 * provisioned agent ever appeared under that skill. Reported by the operator
 * 2026-09-11.
 */
describeEmbeddedPostgres("provisioning agent.create — default paperclip skill", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousHome = process.env.PAPERCLIP_HOME;
  // agent.create also seeds instructions under the instance root, derived from
  // PAPERCLIP_HOME. Without this the suite would write into the real deployment.
  const tmpHome = path.join(os.tmpdir(), `paperclip-provisioning-skills-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpHome, { recursive: true });
    process.env.PAPERCLIP_HOME = tmpHome;
    const started = await startEmbeddedPostgresTestDatabase("provisioning-skills");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function handlers() {
    return provisioningHandlers(db, provisioningStore(db));
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Bring Your AI to Life",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  function payload(companyId: string, overrides: Record<string, unknown> = {}) {
    return { companyId, name: "OpenRouter Codex Agent", adapterType: "codex_local", ...overrides };
  }

  async function readSkillSync(agentId: string) {
    const agent = await agentService(db).getById(agentId);
    const config = (agent?.adapterConfig ?? {}) as Record<string, unknown>;
    return config.paperclipSkillSync as { desiredSkills?: string[] } | undefined;
  }

  it("saves the paperclip skill on a provisioned Codex agent", async () => {
    const companyId = await seedCompany();
    const result = await handlers().run("agent.create", payload(companyId)) as { agentId: string };

    expect((await readSkillSync(result.agentId))?.desiredSkills).toEqual(["paperclipai/paperclip/paperclip"]);
  });

  it("saves the paperclip skill on a provisioned Claude agent", async () => {
    const companyId = await seedCompany();
    const result = await handlers().run(
      "agent.create",
      payload(companyId, { name: "Claude Agent", adapterType: "claude_local" }),
    ) as { agentId: string };

    expect((await readSkillSync(result.agentId))?.desiredSkills).toEqual(["paperclipai/paperclip/paperclip"]);
  });

  it("leaves adapters without skill sync alone", async () => {
    const companyId = await seedCompany();
    const result = await handlers().run(
      "agent.create",
      payload(companyId, { name: "Webhook Agent", adapterType: "http" }),
    ) as { agentId: string };

    expect(await readSkillSync(result.agentId)).toBeUndefined();
  });

  it("does not add the skill to an agent that already exists", async () => {
    const companyId = await seedCompany();
    const existing = await agentService(db).create(companyId, {
      name: "OpenRouter Codex Agent",
      adapterType: "codex_local",
      adapterConfig: { env: {} },
    });

    // A payload that changes something, so the reconcile path really writes.
    const result = await handlers().run(
      "agent.create",
      payload(companyId, { model: "gpt-5.5" }),
    ) as { agentId: string; updated: boolean };

    expect(result.agentId).toBe(existing.id);
    expect(result.updated).toBe(true);
    expect(await readSkillSync(existing.id)).toBeUndefined();
  });
});
