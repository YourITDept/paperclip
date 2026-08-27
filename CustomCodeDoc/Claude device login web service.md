# Claude logins — named credential vaults

**Status:** Implemented on `W4-20260827c`; not yet exercised against a real
Anthropic account.
**Owner:** cwa@youritdept.com
**Created:** 2026-08-27
**Companion to:** [`Codex device login web service.md`](CustomCodeDoc/Codex%20device%20login%20web%20service.md) —
same operator model, different login mechanics. Read §2 before assuming the two
are interchangeable.

> Sibling of the Codex vault feature: provision a named directory, sign in, sign
> out, delete. `/sysops/llm/claude/<name>` instead of `/sysops/llm/codex/<name>`,
> and `CLAUDE_CONFIG_DIR` instead of `CODEX_HOME`.

---

## 1. What this is

An instance admin provisions `/sysops/llm/claude/<name>/`, runs a Claude login
into it from Settings, and an agent uses that account by setting
**`CLAUDE_CONFIG_DIR`** to the directory's full path in its adapter config.

Several agents may share one directory. They then read the same credential file,
so a token rotation is consistent for all of them. They also share the rest of the
directory (`settings.json`, `projects/`, and Claude's own state); give each agent
its own directory when that matters.

That is the whole mechanism, and it is deliberately the same shape an operator
already learned from the Codex page.

---

## 2. Where Claude differs from Codex — read this first

The operator-facing model is identical. The mechanics are not, in two ways that
drive every design decision below.

### 2.1 The login is a round trip

| | Codex | Claude |
| --- | --- | --- |
| Command | `codex login --device-auth` | `claude setup-token` |
| Paperclip shows | URL **and** a one-time code | URL only |
| The operator | approves in the browser | signs in, is handed a code, **pastes it back** |
| Completion | the login finishes on its own | Paperclip must write the code to the waiting process |

So the Claude session has a state the Codex one does not — `waiting_for_code` —
and an extra call, `POST …/login-sessions/:id/code`, that no Codex route needs.
The UI has a matching extra step with a code field.

### 2.2 `setup-token` persists nothing

This is the important one. **Codex** device login writes an `auth.json` into the
home; Paperclip copies that file into the vault. **Claude** `setup-token` writes
no credential at all. The captured characterization in
`packages/adapters/claude-local/src/server/__fixtures__/setup-token-success.md` is
explicit:

> `claude setup-token` does **not** persist the token. After a successful run:
> `~/.claude.json` gained no `oauthAccount` and no token-bearing field […] No
> `~/.claude/.credentials.json` was written.
> Therefore the runner must capture the credential from the terminal stream at the
> moment it is printed; there is no on-disk artifact to read afterward.

So Paperclip captures the token off the login stream and **writes the credential
file itself**.

---

## 3. The credential file — verified, not assumed

Writing the file means knowing exactly what Claude Code reads. That was settled
empirically against the real CLI (2.1.231) rather than inferred.

A credential written by an interactive `claude login` holds a short-lived OAuth
pair — schema only, no values:

```
claudeAiOauth:
  accessToken            str  prefix 'sk-ant'
  refreshToken           str  prefix 'sk-ant'
  expiresAt              int  (hours out)
  refreshTokenExpiresAt  int
  scopes                 [5 items]
  subscriptionType       str
  rateLimitTier          str
```

A setup-token is a **different credential**: `sk-ant-oat01-…`, valid for a year,
with nothing to refresh. Putting one in the other's slot only works if Claude
treats it as a bearer, so that was tested directly with synthetic tokens:

| Test | Result |
| --- | --- |
| **A** — `oat01`-shaped token in `.credentials.json` (`accessToken` + `expiresAt`, **no** `refreshToken`) | `401 Invalid bearer token` |
| **C** — the same token via `CLAUDE_CODE_OAUTH_TOKEN` | `401 Invalid bearer token` — **identical** |
| **B** — `sk-ant` + `refreshToken` | `OAuth session expired and could not be refreshed` — a different path |

A and C are the same error, so Claude parses the file and sends the token as a
bearer exactly as it does the environment variable. (The 401 is only because the
tokens were fake.) That is what makes full parity possible: **an agent sets only
`CLAUDE_CONFIG_DIR`.**

**Therefore no `refreshToken` is written.** B is the reason: a credential carrying
a refresh token sends Claude down its refresh path, which fails with a misleading
"session expired" instead of a plain auth error. `buildSetupTokenCredential` emits
`accessToken`, a one-year `expiresAt`, `scopes`, and `subscriptionType` — and
nothing else. There is a test pinning the absence of `refreshToken`.

---

## 4. What was reused rather than rebuilt

The login machinery already existed in `packages/adapters/claude-local`. It is
used unchanged:

| Piece | Where | Role |
| --- | --- | --- |
| `runSetupTokenLogin` | `setup-token-runner.ts` | drives the login, the code round trip, timeout, cancellation, one-time credential delivery |
| `parseSetupTokenPrompt` | `setup-token-parse.ts` | finds and validates the authorization URL |
| `parseSetupTokenCredential` | `setup-token-parse.ts` | binds the token from the success screen, de-wrapping terminal line breaks |
| `createLoginPtyTransport` | `adapter-utils/login-pty-transport.ts` | adapts a PTY session into the runner's `SetupTokenPtyDriver` shape |
| `readClaudeTokenFromDir` | `quota.ts` | **what a Claude credential is** — see below |

Only one piece was missing: a `LoginPtySession` backed by a **host** process. The
sandbox lane opens its session inside a provider; nothing opened one on the host.
`claude-host-login-pty.ts` adds exactly that and nothing more.

**`readClaudeTokenFromDir` was extracted from `quota.ts`** (splitting the existing
`readClaudeToken`, which now delegates to it) so the vault asks claude-local what a
credential looks like instead of re-deriving it. One definition of the file names
and the `claudeAiOauth.accessToken` field means a vault reporting a usable
credential and a run finding one can never disagree.

The Codex host driver was **not** reusable: it hardcodes `CODEX_HOME` and sets
stdin to `ignore`. A driver that cannot write cannot complete a login that
requires a code to be sent back.

---

## 5. Endpoints

| Method | Path | |
|---|---|---|
| `GET` | `/api/instance/claude-vaults` | listing, with `boundAgentCount` |
| `POST` | `/api/instance/claude-vaults` | create an empty vault |
| `POST` | `/api/instance/claude-vaults/:name/login-sessions` | start a login |
| `GET` | `/api/instance/claude-vaults/login-sessions/:sessionId` | poll for the URL and outcome |
| `POST` | `/api/instance/claude-vaults/login-sessions/:sessionId/code` | **Claude-only** — submit the browser code |
| `POST` | `/api/instance/claude-vaults/login-sessions/:sessionId/cancel` | cancel |
| `DELETE` | `/api/instance/claude-vaults/:name/credential` | sign out |
| `DELETE` | `/api/instance/claude-vaults/:name` | delete |

UI route: `/instance/settings/claude-logins`, aliased at
`/company/settings/instance/claude-logins`.

---

## 6. Authorization, staging, and audit

Same contract as the Codex vault:

| Concern | How |
| --- | --- |
| Who may provision | Instance admin only. A vault is a host path outside every company's isolation boundary, so company-scoped permission is the wrong gate. `local_implicit` counts as admin. |
| Who may drive a session | Only the admin who started it. A non-owner read, code submission, or cancel returns **404**, not 403, so another admin's session is not disclosed. |
| What is recorded | `claude.vault.created`, `claude.vault.login.started`, `claude.vault.login.succeeded`, `claude.vault.login.failed`, `claude.vault.credential.removed`, `claude.vault.deleted` — fanned out to every company. |
| What is never recorded | The token, the authorization URL, and the browser code. A success record carries the auth mode and a masked token suffix. |

**Staging.** The login runs with `CLAUDE_CONFIG_DIR` pointed at a **private temp
directory**, never the vault. `setup-token` writes machine metadata into its config
directory, and a cancelled or failed login must not touch a vault agents are
running against. Only a token the runner bound from the success record reaches
`promoteVaultCredential`, so the vault only ever receives bytes that already
passed validation. The staging directory is removed on every path. There is a test
asserting a failed re-login leaves an existing credential byte-identical.

The host session also blanks `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` in
the child environment, so a credential in the server's own environment cannot let
the login short-circuit against the wrong identity.

---

## 7. Sign out vs delete

Identical semantics to the Codex vault:

| | Sign out | Delete |
|---|---|---|
| Removes | `.credentials.json` only | the whole directory |
| Keeps | directory, `settings.json`, path, project state | nothing |
| Reversible | yes | no |
| An agent whose `CLAUDE_CONFIG_DIR` is this path | still resolves; fails to authenticate | **stops resolving entirely** |

Sign-out is idempotent on an existing vault that holds no credential (`200`), and
a `404` when there is no vault at all — those are different answers. Both removals
are refused with `409` while a login for that vault is in flight, and both take the
same directory lock the promotion takes.

The listing reports `boundAgentCount` by matching each vault directory against
`agents.adapter_config -> 'env' ->> 'CLAUDE_CONFIG_DIR'`, and both confirmations
name it. Advisory: it degrades to 0 when the agents table cannot be read, so read
a 0 as "no warning to show", not as proof nothing is bound.

---

## 8. Files

| File | Change |
|---|---|
| `claude-local/src/server/claude-vault.ts` | **New.** Paths, validation, summary, provisioning, promotion, removal, deletion. |
| `claude-local/src/server/claude-host-login-pty.ts` | **New.** The host PTY session and the runner-shaped transport. |
| `claude-local/src/server/quota.ts` | Extracted `readClaudeTokenFromDir`; `readClaudeToken` delegates to it. |
| `claude-local/src/server/index.ts` | Barrel exports. |
| `server/src/services/claude-vault-login-service.ts` | **New.** Session lifecycle, the code round trip, staging-then-promote, audit. |
| `server/src/routes/claude-vaults.ts` | **New.** Eight instance-admin routes. |
| `server/src/app.ts`, `routes/index.ts` | Mount and export. |
| `ui/src/api/claudeVaults.ts` | **New.** Typed client. |
| `ui/src/pages/InstanceClaudeVaults.tsx` | **New.** The settings page, with the code step. |
| `ui/src/App.tsx`, `lib/queryKeys.ts`, `components/CompanySettingsSidebar.tsx`, `components/access/CompanySettingsNav.tsx` | Route, keys, nav. |

---

## 9. Test results

**41 passing** across two new files, plus the nav test updated for the new tab:

| File | Tests | Covers |
|---|---|---|
| `claude-vault.test.ts` | 23 | Names and containment (`../escape`, `""`, `.`, `..`, `/`), the credential shape including the deliberate absence of `refreshToken`, provisioning, `setup_token` vs `oauth` detection, listing, sign-out, delete, sibling isolation |
| `claude-vault-login-service.test.ts` | 18 | The full round trip against a fake `claude`, two accounts kept distinct, failure leaving the vault untouched, a failed re-login leaving the credential byte-identical, owner scoping, code replay refusal, cancellation, sign-out/delete, the in-flight-login refusal |

The service tests drive the **real** service against a fake `claude` binary that
reproduces the captured screens and **blocks on stdin** after printing the prompt —
so a test that never submits a code cannot reach the token. Everything below the
fake is the production path: the host PTY, the shared transport, the runner, the
parser, and the atomic promotion.

**A trap worth recording.** The first fakes used a 16-character token tail and
every success test failed with a plain "login did not complete". The parser's
`FULL_TOKEN_RE` requires `sk-ant-oat01-` plus a **20+ character** tail, to reject a
bare prefix and short noisy candidates. A short fake binds nothing and reports an
ordinary failure — it does not say the token was malformed. If a login fails at
the last step with everything else looking right, check the token shape first.

---

## 10. Still open

- **Never run against a real Anthropic account.** Every layer is exercised, and
  the credential shape was verified against the real CLI with synthetic tokens,
  but no genuine `claude setup-token` has been completed through this page. That
  is the one thing left before trusting it.
- **`subscriptionType` is written as `"unknown"`.** `setup-token` does not report a
  tier, and the credential file wants the field. The UI hides it when it reads
  `unknown`. A real login could fill it in from `claude auth status`.
- **No UI test.** Neither vault page has one.
- **Re-login does not warn.** `boundAgentCount` is computed for the destructive
  actions; signing in again over a live account is still silent, exactly as on the
  Codex page.
- **Nothing revokes the token upstream.** Sign-out deletes the local credential; it
  does not tell Anthropic to invalidate the token. Revoke it in the Claude
  dashboard if that matters.
- **One year, then a cliff.** A setup-token does not refresh. When it expires the
  vault simply stops authenticating; nothing warns beforehand. The listing shows
  the expiry date, which is the only signal today.
