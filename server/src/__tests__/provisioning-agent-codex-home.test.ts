import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { PermanentJobError, ParkJobError, provisioningHandlers } from "../provisioning/handlers.js";
import { provisioningStore } from "../provisioning/store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping provisioning codex-home tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * `agent.create` binds an agent's codex home the same way it binds the
 * provider credential: `payload.codexHome` names a COMPANY SECRET KEY, and the
 * secret's value is the path.
 *
 * The contract these cover is in the onboarding repo's
 * `outseta-paperclip-integration/docs/99-AGENT-NOTES.md` (2026-09-07). Each
 * test below is one clause of it, because the field's type did not change when
 * its meaning did — an old path and a new key are both strings, so nothing but
 * these assertions distinguishes a handler that implements the new contract
 * from one that silently implements the old.
 */
describeEmbeddedPostgres("provisioning agent.create — codexHome as a secret", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-provisioning-codex-home-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("provisioning-codex-home");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
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

  function handlers() {
    return provisioningHandlers(db, provisioningStore(db));
  }

  async function seedCompany(name = "Bring Your AI to Life") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedSecret(companyId: string, key: string, name: string, value: string) {
    return secretService(db).create(companyId, {
      name,
      provider: "local_encrypted",
      key,
      value,
    });
  }

  const CODEX_HOME_PATH = "/sysops/llm/openrouter/deepseek-v4-flash-0731";

  function agentPayload(companyId: string, overrides: Record<string, unknown> = {}) {
    return {
      companyId,
      name: "OpenRouter Deepseek Agent",
      adapterType: "codex_local",
      model: "deepseek/deepseek-v4-flash-0731",
      codexHome: "openrouter_codexhome_deepseek",
      secretKey: "openrouter_api_key_deepseek",
      secretEnv: "OPENROUTER_API_KEY",
      canCreateAgents: true,
      ...overrides,
    };
  }

  async function readEnv(agentId: string): Promise<Record<string, unknown>> {
    const agent = await agentService(db).getById(agentId);
    const config = agent?.adapterConfig as Record<string, unknown> | null;
    return (config?.env ?? {}) as Record<string, unknown>;
  }

  it("binds CODEX_HOME to the named secret, not to the key string", async () => {
    const companyId = await seedCompany();
    const codexHome = await seedSecret(
      companyId,
      "openrouter_codexhome_deepseek",
      "OpenRouter-Deepseek-CodexHome",
      CODEX_HOME_PATH,
    );
    const credential = await seedSecret(
      companyId,
      "openrouter_api_key_deepseek",
      "OpenRouter-Deepseek-Key",
      "sk-or-v1-test",
    );

    const result = await handlers().run("agent.create", agentPayload(companyId));
    expect(result.created).toBe(true);
    expect(result.codexHomeSecretId).toBe(codexHome.id);

    const env = await readEnv(result.agentId as string);
    // The KEY must never reach the agent as a literal value: an agent whose
    // CODEX_HOME is the string "openrouter_codexhome_deepseek" is a relative
    // path, and Codex would create it under the run's cwd.
    expect(env.CODEX_HOME).toMatchObject({ type: "secret_ref", secretId: codexHome.id });
    expect(env.OPENROUTER_API_KEY).toMatchObject({ type: "secret_ref", secretId: credential.id });
  });

  it("parks — naming which key — until the codex-home secret lands", async () => {
    const companyId = await seedCompany();
    await seedSecret(companyId, "openrouter_api_key_deepseek", "OpenRouter-Deepseek-Key", "sk-or-v1-test");

    // The credential exists and the codex home does not, so the park message
    // has to name the half that is actually missing.
    await expect(handlers().run("agent.create", agentPayload(companyId))).rejects.toThrow(ParkJobError);
    await expect(handlers().run("agent.create", agentPayload(companyId))).rejects.toThrow(
      /openrouter_codexhome_deepseek \(codexHome\)/,
    );
    expect(await db.select().from(agents)).toHaveLength(0);

    // Once it lands, the same payload completes — this is what makes the
    // enqueue order between secret.set and agent.create irrelevant.
    const codexHome = await seedSecret(
      companyId,
      "openrouter_codexhome_deepseek",
      "OpenRouter-Deepseek-CodexHome",
      CODEX_HOME_PATH,
    );
    const result = await handlers().run("agent.create", agentPayload(companyId));
    expect(result.created).toBe(true);
    expect((await readEnv(result.agentId as string)).CODEX_HOME).toMatchObject({
      type: "secret_ref",
      secretId: codexHome.id,
    });
  });

  it("fails permanently on a path-shaped codexHome, and creates nothing", async () => {
    const companyId = await seedCompany();
    await seedSecret(companyId, "openrouter_api_key_deepseek", "OpenRouter-Deepseek-Key", "sk-or-v1-test");

    // A payload written against the retired contract. Accepting it as a literal
    // path is what would leave an instance half on each contract.
    const attempt = handlers().run("agent.create", agentPayload(companyId, { codexHome: CODEX_HOME_PATH }));
    await expect(attempt).rejects.toThrow(PermanentJobError);
    await expect(
      handlers().run("agent.create", agentPayload(companyId, { codexHome: CODEX_HOME_PATH })),
    ).rejects.toMatchObject({ code: "codex_home_not_a_secret_key" });
    expect(await db.select().from(agents)).toHaveLength(0);
  });

  it("re-points an agent provisioned under the old contract", async () => {
    const companyId = await seedCompany();
    const credential = await seedSecret(
      companyId,
      "openrouter_api_key_deepseek",
      "OpenRouter-Deepseek-Key",
      "sk-or-v1-test",
    );
    // An agent as it exists on an instance provisioned before the change: a
    // literal path, plus a variable a person added by hand.
    const stale = await agentService(db).create(companyId, {
      name: "OpenRouter Deepseek Agent",
      adapterType: "codex_local",
      adapterConfig: {
        model: "deepseek/deepseek-v4-flash-0731",
        env: {
          CODEX_HOME: { type: "plain", value: "/sysops/llm/openrouter/old-path" },
          OPERATOR_ADDED: { type: "plain", value: "keep me" },
          OPENROUTER_API_KEY: { type: "secret_ref", secretId: credential.id },
        },
      },
    });

    const codexHome = await seedSecret(
      companyId,
      "openrouter_codexhome_deepseek",
      "OpenRouter-Deepseek-CodexHome",
      CODEX_HOME_PATH,
    );

    const result = await handlers().run("agent.create", agentPayload(companyId));
    // Updated, not duplicated: identity is the name within the company.
    expect(result.created).toBe(false);
    expect(result.updated).toBe(true);
    expect(result.agentId).toBe(stale.id);
    expect(await db.select().from(agents)).toHaveLength(1);

    const env = await readEnv(stale.id);
    expect(env.CODEX_HOME).toMatchObject({ type: "secret_ref", secretId: codexHome.id });
    // A queue row that never knew about this variable must not erase it.
    expect(env.OPERATOR_ADDED).toMatchObject({ type: "plain", value: "keep me" });
  });

  it("is a no-op on replay once the agent already matches", async () => {
    const companyId = await seedCompany();
    await seedSecret(companyId, "openrouter_codexhome_deepseek", "OpenRouter-Deepseek-CodexHome", CODEX_HOME_PATH);
    await seedSecret(companyId, "openrouter_api_key_deepseek", "OpenRouter-Deepseek-Key", "sk-or-v1-test");

    const first = await handlers().run("agent.create", agentPayload(companyId));
    const second = await handlers().run("agent.create", agentPayload(companyId));

    // A replay that reported `updated: true` would churn a revision on every
    // pass, because a persisted binding is not byte-identical to a built one.
    expect(second).toMatchObject({ agentId: first.agentId, created: false, updated: false });
  });

  it("leaves CODEX_HOME alone when the payload names none", async () => {
    const companyId = await seedCompany();
    await seedSecret(companyId, "openrouter_api_key_deepseek", "OpenRouter-Deepseek-Key", "sk-or-v1-test");

    const created = await handlers().run(
      "agent.create",
      agentPayload(companyId, { codexHome: undefined, name: "Managed Home Agent" }),
    );
    // An omitted codexHome means the Paperclip-managed home, directly. It must
    // not bind the variable to "" and must not read an environment fallback.
    expect((await readEnv(created.agentId as string)).CODEX_HOME).toBeUndefined();
  });
});
