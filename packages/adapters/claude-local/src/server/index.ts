export { claudeSessionCwdMatchesExecutionTarget, execute, runClaudeLogin } from "./execute.js";
export * from "./acp.js";
export { getConfigSchema } from "./config-schema.js";
export { listClaudeSkills, syncClaudeSkills } from "./skills.js";
export { listClaudeModels, refreshClaudeModels, resetClaudeModelsCacheForTests } from "./models.js";
export { testEnvironment } from "./test.js";
export {
  claudeCommandSupportsEffortFlag,
  resetClaudeCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeProviderQuotaError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
export {
  getQuotaWindows,
  readClaudeAuthStatus,
  readClaudeToken,
  readClaudeTokenFromDir,
  fetchClaudeQuota,
  fetchClaudeCliQuota,
  captureClaudeCliUsageText,
  parseClaudeCliUsageText,
  toPercent,
  fetchWithTimeout,
  claudeConfigDir,
} from "./quota.js";
// The Claude `setup-token` login parser. It reads the interactive login output
// and returns the authorization URL and the browser-code prompt, or the minted
// OAuth token from the success record. Both functions fail closed and keep every
// input byte out of each log and each thrown error.
export {
  parseSetupTokenPrompt,
  parseSetupTokenCredential,
  SETUP_TOKEN_PROMPT,
  SETUP_TOKEN_AUTH_URLS,
  SETUP_TOKEN_REDIRECT_URI,
  SETUP_TOKEN_URL_QUERY_KEYS,
  SETUP_TOKEN_PREFIX,
  SETUP_TOKEN_BEFORE_ANCHOR,
  SETUP_TOKEN_AFTER_ANCHOR,
} from "./setup-token-parse.js";
export type { SetupTokenPrompt } from "./setup-token-parse.js";
// The Claude `setup-token` login runner. A server-side factory binds it to a
// sandbox pseudo-terminal driver to drive the two-way login round-trip and to
// deliver the minted token one time in memory.
export {
  runSetupTokenLogin,
  CLAUDE_SETUP_TOKEN_COMMAND,
  CODE_SUBMISSION_TERMINATOR,
  CLAUDE_SETUP_TOKEN_MAX_BUFFER_CHARS,
} from "./setup-token-runner.js";
// The named Claude config store ("Claude logins"). Each entry is one directory
// holding one Claude account's credential; an agent uses it by setting
// CLAUDE_CONFIG_DIR to the directory's full path.
export {
  CLAUDE_VAULT_CREDENTIAL_REJECTED,
  CLAUDE_VAULT_NAME_INVALID,
  CLAUDE_VAULT_ROOT_ENV_KEY,
  DEFAULT_CLAUDE_VAULT_ROOT,
  MAX_VAULT_CREDENTIAL_BYTES,
  SETUP_TOKEN_LIFETIME_MS,
  assertValidVaultName,
  buildSetupTokenCredential,
  deleteVault,
  ensureVaultDir,
  isValidVaultName,
  listVaults,
  promoteVaultCredential,
  readVaultSummary,
  removeVaultCredential,
  resolveVaultCredentialPath,
  resolveVaultDir,
  resolveVaultRoot,
  resolveVaultSettingsPath,
  vaultExists,
  type ClaudeVaultSummary,
} from "./claude-vault.js";
// The host lane for the setup-token login. The runner and the PTY transport are
// reused unchanged; this only opens the session on the host instead of a sandbox.
export {
  createClaudeHostSetupTokenTransport,
  createClaudeLoginStagingDir,
  openClaudeHostLoginPtySession,
  removeClaudeLoginStagingDir,
  type ClaudeHostLoginPtyOptions,
} from "./claude-host-login-pty.js";
export type {
  SetupTokenPtyDriver,
  SetupTokenPromptSink,
  SetupTokenCodeProvider,
  SetupTokenCredentialSink,
  SetupTokenOutcome,
  SetupTokenLoginResult,
  RunSetupTokenLoginOptions,
} from "./setup-token-runner.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return acpxSessionCodec.deserialize(raw);
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const promptBundleKey =
      readNonEmptyString(record.promptBundleKey) ??
      readNonEmptyString(record.prompt_bundle_key);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return acpxSessionCodec.serialize(params);
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const promptBundleKey =
      readNonEmptyString(params.promptBundleKey) ??
      readNonEmptyString(params.prompt_bundle_key);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(promptBundleKey ? { promptBundleKey } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      acpxSessionCodec.getDisplayId?.(params) ??
      null
    );
  },
};
