import { api } from "./client";

/**
 * One named directory holding one Claude account's credential. An agent uses it
 * by setting `env.CLAUDE_CONFIG_DIR` to the directory's full path.
 *
 * The summary is non-secret: it carries a masked token suffix, never a token.
 */
export interface ClaudeVaultSummary {
  name: string;
  dir: string;
  hasCredential: boolean;
  /** "setup_token" for a Paperclip-minted token, "oauth" for a login-written pair. */
  authMode: string | null;
  tokenSuffix: string | null;
  expiresAt: string | null;
  subscriptionType: string | null;
  /**
   * How many agents name this directory as their `CLAUDE_CONFIG_DIR`. Advisory —
   * it degrades to 0 if the agents table cannot be read, so treat a 0 as "no
   * warning to show" rather than proof nothing is bound.
   */
  boundAgentCount: number;
}

export interface ClaudeVaultListResponse {
  root: string;
  vaults: ClaudeVaultSummary[];
}

/**
 * `waiting_for_code` is the state that has no Codex equivalent: the authorization
 * URL is on screen and the server is holding the login open for the code the
 * operator gets from the browser.
 */
export type ClaudeVaultLoginState = "starting" | "waiting_for_code" | "success" | "failed";

export interface ClaudeVaultLoginSession {
  sessionId: string;
  vaultName: string;
  state: ClaudeVaultLoginState;
  url: string | null;
  codeSubmitted: boolean;
  error: string | null;
}

export const claudeVaultsApi = {
  list: (companyId: string) => api.get<ClaudeVaultListResponse>(`/instance/claude-vaults?companyId=${encodeURIComponent(companyId)}`),
  create: (companyId: string, name: string) =>
    api.post<ClaudeVaultSummary>("/instance/claude-vaults", { companyId, name }),
  startLogin: (companyId: string, name: string) =>
    api.post<ClaudeVaultLoginSession>(
      `/instance/claude-vaults/${encodeURIComponent(name)}/login-sessions`,
      { companyId },
    ),
  readSession: (companyId: string, sessionId: string) =>
    api.get<ClaudeVaultLoginSession>(
      `/instance/claude-vaults/login-sessions/${encodeURIComponent(sessionId)}?companyId=${encodeURIComponent(companyId)}`,
    ),
  /** Hands the browser code back to the waiting login. Claude-specific. */
  submitCode: (companyId: string, sessionId: string, code: string) =>
    api.post<ClaudeVaultLoginSession>(
      `/instance/claude-vaults/login-sessions/${encodeURIComponent(sessionId)}/code`,
      { companyId, code },
    ),
  cancelSession: (companyId: string, sessionId: string) =>
    api.post<ClaudeVaultLoginSession>(
      `/instance/claude-vaults/login-sessions/${encodeURIComponent(sessionId)}/cancel`,
      { companyId },
    ),
  /**
   * Removes the credential and keeps the login. Reversible: the directory, its
   * `settings.json`, and its path survive, so an agent pointed at it keeps
   * resolving and signing in again restores it.
   */
  signOut: (companyId: string, name: string) =>
    api.delete<ClaudeVaultSummary>(
      `/instance/claude-vaults/${encodeURIComponent(name)}/credential?companyId=${encodeURIComponent(companyId)}`,
    ),
  /** Deletes the directory outright. Irreversible; breaks agents bound to it. */
  remove: (companyId: string, name: string) =>
    api.delete<{ name: string; deleted: boolean }>(
      `/instance/claude-vaults/${encodeURIComponent(name)}?companyId=${encodeURIComponent(companyId)}`,
    ),
};
