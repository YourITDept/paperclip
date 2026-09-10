import type { EnvBinding } from "@paperclipai/shared";
import { secretsApi } from "../api/secrets";

// FORK-CARRIED (CustomCodeDoc §4 change set 5).
//
// A credential-vault directory reaches an agent as an ORGANIZATION SECRET bound
// by reference, never as a plain environment value.
//
// Why, concretely. `redactAgentEnvBinding` (server/src/redaction.ts:946) turns
// every plain binding into `{ type: "plain", value: "***REDACTED***" }` on read,
// while a `secret_ref` survives untouched — it carries an id, not a value, so
// there is nothing to redact. Anything that reads an agent and writes it back —
// duplicating it, editing another field on the same form — therefore persists
// the literal marker over a plain vault path, and the agent then points at a
// directory called `***REDACTED***`. Change set 10 exists to repair exactly that
// round trip for the create path; binding by reference means the round trip is
// never lossy in the first place.
//
// This is the model the provisioning worker already uses and the one upstream's
// own device-login flow uses (`CODEX_HOME_<handle>`, routes/agents.ts:836). It
// is also why the secret is created HERE rather than when the vault is
// provisioned: vaults are instance-scoped (`/instance/codex-vaults`) and secrets
// are per-company, so the company is not known until an agent is being created
// in one.

/** `/sysops/llm/codex/team` → `team`; keeps the name readable and stable. */
function vaultHandle(directory: string): string {
  const segment = directory.replace(/\/+$/, "").split("/").pop() ?? "";
  const cleaned = segment.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "vault";
}

/** `CODEX_HOME` + `/sysops/llm/codex/team` → `CODEX_HOME_team`. */
export function homeDirectorySecretName(envKey: string, directory: string): string {
  return `${envKey}_${vaultHandle(directory)}`;
}

/**
 * Bind `directory` as an organization secret and return the reference.
 *
 * Create-or-reuse by name, so every agent pointed at the same vault shares one
 * secret: rotating the path in one place moves all of them, which is the whole
 * point of "usable by the organization". A repeat call is idempotent.
 *
 * A name collision whose value has drifted is NOT silently reused — that would
 * point an agent at someone else's directory. The caller sees the mismatch and
 * decides.
 */
export async function ensureOrganizationDirectorySecret(
  companyId: string,
  envKey: string,
  directory: string,
): Promise<EnvBinding> {
  const name = homeDirectorySecretName(envKey, directory);
  const existing = (await secretsApi.list(companyId)).find((secret) => secret.name === name);
  if (existing) {
    return { type: "secret_ref", secretId: existing.id, version: "latest" };
  }
  const created = await secretsApi.create(companyId, {
    name,
    key: name,
    value: directory,
    description: `${envKey} for the ${vaultHandle(directory)} credential vault.`,
  });
  return { type: "secret_ref", secretId: created.id, version: "latest" };
}

/**
 * Convert a whole plain env preset into organization secret references.
 *
 * Entries that are already references are passed through.
 *
 * THROWS on failure — deliberately. The first version caught the error and
 * returned the plain binding, reasoning that a visible, editable path beats an
 * agent with no vault directory. That reasoning was wrong in the way that
 * matters: a silent fallback is byte-for-byte identical to the change not being
 * deployed at all, so the operator saw the original bug, could not tell whether
 * the build was stale, and lost a testing round to it (2026-09-10). A caller
 * that wants to degrade to plain must now do so knowingly, and say so.
 */
export async function bindEnvPresetToOrganizationSecrets(
  companyId: string,
  preset: Record<string, EnvBinding>,
): Promise<Record<string, EnvBinding>> {
  const entries = await Promise.all(
    Object.entries(preset).map(async ([envKey, binding]) => {
      if (typeof binding === "string" || binding.type !== "plain") return [envKey, binding] as const;
      return [envKey, await ensureOrganizationDirectorySecret(companyId, envKey, binding.value)] as const;
    }),
  );
  return Object.fromEntries(entries);
}
