import { api } from "./client";

/**
 * One named directory holding one Codex account's durable credential. An agent
 * uses it by setting `env.CODEX_HOME` to the directory's full path. Several
 * agents may share one: they read the same `auth.json`, so Codex's single-use
 * refresh-token rotation stays consistent across all of them.
 *
 * The summary is non-secret: it carries a masked account suffix, never a token
 * and never a full account id.
 */
export interface CodexVaultSummary {
  name: string;
  dir: string;
  hasCredential: boolean;
  authMode: string | null;
  accountSuffix: string | null;
  lastRefresh: string | null;
  /**
   * How many agents name this directory as their `CODEX_HOME`. This is the blast
   * radius of deleting the login, and it is advisory — it degrades to 0 if the
   * agents table cannot be read, so treat a 0 as "no warning to show" rather
   * than a guarantee that nothing is bound.
   */
  boundAgentCount: number;
}

export interface CodexVaultListResponse {
  root: string;
  vaults: CodexVaultSummary[];
}

export type CodexVaultLoginState = "starting" | "waiting" | "success" | "failed";

/**
 * A device-login session. `url` and `code` are the one-time prompt and are
 * returned only to the admin who started the session; they are cleared as soon
 * as the login reaches a terminal state.
 */
export interface CodexVaultLoginSession {
  sessionId: string;
  vaultName: string;
  state: CodexVaultLoginState;
  url: string | null;
  code: string | null;
  expiresAt: number | null;
  error: string | null;
}

export const codexVaultsApi = {
  list: () => api.get<CodexVaultListResponse>("/instance/codex-vaults"),
  create: (name: string) => api.post<CodexVaultSummary>("/instance/codex-vaults", { name }),
  startLogin: (name: string) =>
    api.post<CodexVaultLoginSession>(
      `/instance/codex-vaults/${encodeURIComponent(name)}/login-sessions`,
      {},
    ),
  readSession: (sessionId: string) =>
    api.get<CodexVaultLoginSession>(
      `/instance/codex-vaults/login-sessions/${encodeURIComponent(sessionId)}`,
    ),
  cancelSession: (sessionId: string) =>
    api.post<CodexVaultLoginSession>(
      `/instance/codex-vaults/login-sessions/${encodeURIComponent(sessionId)}/cancel`,
      {},
    ),
  /**
   * Removes the credential and keeps the login. Reversible: the directory, its
   * `config.toml`, and its path survive, so an agent pointed at it keeps
   * resolving and signing in again restores it.
   */
  signOut: (name: string) =>
    api.delete<CodexVaultSummary>(
      `/instance/codex-vaults/${encodeURIComponent(name)}/credential`,
    ),
  /** Deletes the directory outright. Irreversible; breaks agents bound to it. */
  remove: (name: string) =>
    api.delete<{ name: string; deleted: boolean }>(
      `/instance/codex-vaults/${encodeURIComponent(name)}`,
    ),
};
