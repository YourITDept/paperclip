import type { AgentDetail } from "@paperclipai/shared";

const INSTRUCTION_CONFIG_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
  "promptTemplate",
  "bootstrapPromptTemplate",
] as const;

// Runtime-config keys the create API rejects outright.
//
// `modelProfiles` was retired upstream (#12683) and `createAgentSchema` now
// fails the whole request when it is present. An agent predating that change
// still carries the key until its row is migrated, and a duplicate copies
// `runtimeConfig` wholesale — so without this the copy is refused with a bare
// "Validation error" naming a field the operator never set.
//
// Dropping the key is right on its own terms: a duplicate should not reintroduce
// configuration the product has removed.
const RETIRED_RUNTIME_CONFIG_KEYS = ["modelProfiles"] as const;

export type DuplicateInstructionsBundle = {
  entryFile: string;
  files: Record<string, string>;
};

type DuplicateAgentSource = Pick<
  AgentDetail,
  | "id"
  | "name"
  | "role"
  | "title"
  | "icon"
  | "reportsTo"
  | "capabilities"
  | "adapterType"
  | "adapterConfig"
  | "runtimeConfig"
  | "defaultEnvironmentId"
  | "budgetMonthlyCents"
  | "permissions"
  | "metadata"
>;

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function duplicateAgentName(name: string): string {
  const trimmed = name.trim();
  return `${trimmed || "Agent"} Copy`;
}

export function buildDuplicateAgentPayload(
  agent: DuplicateAgentSource,
  instructionsBundle?: DuplicateInstructionsBundle | null,
): Record<string, unknown> {
  const adapterConfig = cloneRecord(agent.adapterConfig);
  for (const key of INSTRUCTION_CONFIG_KEYS) {
    delete adapterConfig[key];
  }

  const runtimeConfig = cloneRecord(agent.runtimeConfig);
  for (const key of RETIRED_RUNTIME_CONFIG_KEYS) {
    delete runtimeConfig[key];
  }

  const payload: Record<string, unknown> = {
    name: duplicateAgentName(agent.name),
    role: agent.role,
    adapterType: agent.adapterType,
    adapterConfig,
    runtimeConfig,
    // Names the agent being copied so the server can restore the
    // `adapterConfig.env` values that reached this client redacted — a
    // credential vault directory, typically. `adapterConfig` above still carries
    // `***REDACTED***` for each of them; the client cannot do better, because it
    // has never held the real value. See `restoreDuplicateSourceEnv`.
    duplicateFromAgentId: agent.id,
    defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
    budgetMonthlyCents: agent.budgetMonthlyCents ?? 0,
    permissions: {
      canCreateAgents: Boolean(agent.permissions?.canCreateAgents),
      canCreateSkills: agent.permissions?.canCreateSkills !== false,
    },
  };

  if (agent.title) payload.title = agent.title;
  if (agent.icon) payload.icon = agent.icon;
  if (agent.reportsTo) payload.reportsTo = agent.reportsTo;
  if (agent.capabilities) payload.capabilities = agent.capabilities;
  if (agent.metadata) payload.metadata = cloneRecord(agent.metadata);

  if (instructionsBundle && Object.keys(instructionsBundle.files).length > 0) {
    payload.instructionsBundle = instructionsBundle;
  }

  return payload;
}
