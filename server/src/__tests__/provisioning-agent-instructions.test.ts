import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
    `Skipping provisioning instruction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * FORK-CARRIED (CustomCodeDoc §4 change set 11).
 *
 * Two code paths create agents and only one of them seeded instructions.
 * `agentRoutes` calls `materializeDefaultInstructionsBundleForNewAgent` after
 * its create; this module calls `agentService.create` directly, and
 * `services/agents.ts` has no notion of instructions at all — so every agent
 * provisioned from the queue was born with an EMPTY bundle while looking
 * completely normal in the UI. Reported by the operator 2026-09-09.
 *
 * Nothing else catches this: the agent row is valid, the config is valid, the
 * adapter runs, and the only symptom is an agent with no Execution Contract.
 */
describeEmbeddedPostgres("provisioning agent.create — default instructions", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousHome = process.env.PAPERCLIP_HOME;
  // The managed bundle is written under the instance root, which is derived from
  // PAPERCLIP_HOME. Without this the suite would write into the real deployment.
  const tmpHome = path.join(os.tmpdir(), `paperclip-provisioning-instructions-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpHome, { recursive: true });
    process.env.PAPERCLIP_HOME = tmpHome;
    const started = await startEmbeddedPostgresTestDatabase("provisioning-instructions");
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

  async function readConfig(agentId: string) {
    const agent = await agentService(db).getById(agentId);
    return (agent?.adapterConfig ?? {}) as Record<string, unknown>;
  }

  async function entryFilePath(agentId: string) {
    const config = await readConfig(agentId);
    return config.instructionsFilePath as string | undefined;
  }

  it("gives a provisioned agent the default instruction bundle", async () => {
    const companyId = await seedCompany();
    const result = await handlers().run("agent.create", payload(companyId)) as { agentId: string };

    const config = await readConfig(result.agentId);
    expect(config.instructionsBundleMode).toBe("managed");
    expect(config.instructionsEntryFile).toBe("AGENTS.md");

    const filePath = config.instructionsFilePath as string;
    expect(filePath).toContain(result.agentId);
    // Assert the CONTENT, not just that a file exists: an empty AGENTS.md would
    // satisfy every structural check above and is exactly the bug being fixed.
    const contents = await readFile(filePath, "utf8");
    expect(contents).toContain("Execution Contract");
    expect(contents.length).toBeGreaterThan(1000);
  });

  it("does not clobber instructions a person edited, on replay", async () => {
    const companyId = await seedCompany();
    const first = await handlers().run("agent.create", payload(companyId)) as { agentId: string };
    const filePath = (await entryFilePath(first.agentId))!;

    await writeFile(filePath, "Hand-edited by the operator.\n", "utf8");

    // A replay takes the reconcile path, which must merge and never reseed.
    const second = await handlers().run("agent.create", payload(companyId)) as { agentId: string };
    expect(second.agentId).toBe(first.agentId);
    expect(await readFile(filePath, "utf8")).toBe("Hand-edited by the operator.\n");
  });

  it("leaves adapters that do not support a bundle alone", async () => {
    const companyId = await seedCompany();
    const result = await handlers().run(
      "agent.create",
      payload(companyId, { name: "Webhook Agent", adapterType: "http" }),
    ) as { agentId: string };

    const config = await readConfig(result.agentId);
    expect(config.instructionsBundleMode).toBeUndefined();
    expect(config.instructionsFilePath).toBeUndefined();
  });
});
