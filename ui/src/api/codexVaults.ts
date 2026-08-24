import { api } from "./client";

/**
 * A Codex credential vault: one named directory holding one Codex identity's
 * durable credential. Agents bind to a vault through `env.PAPERCLIP_CODEX_VAULT`,
 * and the adapter symlinks its `auth.json` into each agent's own managed home —
 * so several agents share one rotating credential instead of holding copies that
 * would invalidate each other.
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
};
