// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildDuplicateAgentPayload, duplicateAgentName } from "./duplicate-agent-payload";
import type { AgentDetail } from "@paperclipai/shared";

const baseAgent: AgentDetail = {
  id: "agent-1",
  companyId: "company-1",
  name: "Senior Product Engineer",
  urlKey: "senior-product-engineer",
  role: "engineer",
  title: "Senior Product Engineer",
  icon: "code",
  status: "idle",
  reportsTo: "manager-1",
  capabilities: "Builds product features.",
  adapterType: "codex_local",
  adapterConfig: {
    model: "gpt-5.5",
    instructionsBundleMode: "managed",
    instructionsRootPath: "/tmp/original/instructions",
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: "/tmp/original/instructions/AGENTS.md",
    promptTemplate: "legacy prompt",
    bootstrapPromptTemplate: "legacy bootstrap",
  },
  runtimeConfig: {
    heartbeat: { enabled: true },
  },
  defaultEnvironmentId: "environment-1",
  budgetMonthlyCents: 500,
  spentMonthlyCents: 123,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true, canCreateSkills: true },
  lastHeartbeatAt: null,
  metadata: { source: "test" },
  createdAt: new Date("2026-05-10T00:00:00.000Z"),
  updatedAt: new Date("2026-05-10T00:00:00.000Z"),
  chainOfCommand: [],
  access: {
    canAssignTasks: true,
    taskAssignSource: "explicit_grant",
    membership: null,
    grants: [],
  },
};

describe("duplicate agent payload", () => {
  it("suffixes duplicate names", () => {
    expect(duplicateAgentName("Senior Product Engineer")).toBe("Senior Product Engineer Copy");
    expect(duplicateAgentName("   ")).toBe("Agent Copy");
  });

  it("copies agent fields while removing original instruction paths", () => {
    const payload = buildDuplicateAgentPayload(baseAgent, {
      entryFile: "AGENTS.md",
      files: {
        "AGENTS.md": "You are a copy.",
      },
    });

    expect(payload).toMatchObject({
      name: "Senior Product Engineer Copy",
      role: "engineer",
      title: "Senior Product Engineer",
      icon: "code",
      reportsTo: "manager-1",
      capabilities: "Builds product features.",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.5" },
      runtimeConfig: { heartbeat: { enabled: true } },
      defaultEnvironmentId: "environment-1",
      budgetMonthlyCents: 500,
      permissions: { canCreateAgents: true, canCreateSkills: true },
      metadata: { source: "test" },
      instructionsBundle: {
        entryFile: "AGENTS.md",
        files: { "AGENTS.md": "You are a copy." },
      },
    });
    expect(payload.adapterConfig).not.toHaveProperty("instructionsFilePath");
    expect(payload.adapterConfig).not.toHaveProperty("promptTemplate");
  });

  it("names the source agent so the server can restore redacted vault env", () => {
    // The vault directory reaches this client already redacted, so the payload
    // still carries the marker. `duplicateFromAgentId` is what lets the server
    // put the real value back; without it the copy persists `***REDACTED***`.
    const vaultAgent: AgentDetail = {
      ...baseAgent,
      adapterConfig: {
        ...baseAgent.adapterConfig,
        env: {
          CODEX_HOME: { type: "plain", value: "***REDACTED***" },
        },
      },
    };

    const payload = buildDuplicateAgentPayload(vaultAgent);

    expect(payload.duplicateFromAgentId).toBe("agent-1");
    expect(payload.adapterConfig).toMatchObject({
      env: { CODEX_HOME: { type: "plain", value: "***REDACTED***" } },
    });
  });

  it("drops retired runtimeConfig keys the create API rejects", () => {
    // An agent predating #12683 still carries `modelProfiles` until its row is
    // migrated. Copying it verbatim fails the whole create with a bare
    // "Validation error" naming a field the operator never set.
    const legacyAgent: AgentDetail = {
      ...baseAgent,
      runtimeConfig: {
        heartbeat: { enabled: true },
        modelProfiles: { cheap: { model: "gpt-5-mini" } },
      } as AgentDetail["runtimeConfig"],
    };

    const payload = buildDuplicateAgentPayload(legacyAgent);

    expect(payload.runtimeConfig).not.toHaveProperty("modelProfiles");
    expect(payload.runtimeConfig).toMatchObject({ heartbeat: { enabled: true } });
  });

  it("leaves the source agent's own config untouched", () => {
    const legacyAgent: AgentDetail = {
      ...baseAgent,
      runtimeConfig: {
        modelProfiles: { cheap: { model: "gpt-5-mini" } },
      } as AgentDetail["runtimeConfig"],
    };

    buildDuplicateAgentPayload(legacyAgent);

    expect(legacyAgent.runtimeConfig).toHaveProperty("modelProfiles");
  });
});
