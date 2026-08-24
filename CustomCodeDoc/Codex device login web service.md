

---

## 9. Paperclip integration — named credential vaults

Phase 1 is **implemented and tested**. It makes the multi-agent case work; the
Settings UI (phase 2) sits on top of it.

### The model

A **vault** is one operator-named directory holding the durable credential for
exactly one Codex identity:

```
/sysops/llm/codex/<name>/
├── auth.json     the credential (0600)
└── config.toml   policy copied into every agent home bound to this vault
```

A vault is a credential **source**, not a run home. An agent bound to a vault
keeps its own managed home for runtime state; only `auth.json` is shared, and it
is shared by **symlink**.

### Why symlink, not copy — the constraint that drives everything

From [codex-home.ts:293](packages/adapters/codex-local/src/server/codex-home.ts#L293):

> Codex refresh tokens rotate and are single-use, so a stale copy fails with
> `refresh_token_reused` on the next run (#5028).

So there can be exactly **one writable `auth.json` per identity**. If three agents
each held a copy, whichever ran first would rotate the token and break the other
two. The symlink means a rotation written through any agent's home lands on the
vault file and is instantly visible to every other agent. This is the whole
reason the feature is shaped this way, and it is the behaviour the integration
test pins down.

### Resolution precedence

`resolveSharedCodexHomeDir` now resolves the credential source in this order:

1. **`PAPERCLIP_CODEX_VAULT`** — a validated name under the vault root
2. **`CODEX_HOME`** — the instance-global shared home
3. **`~/.codex`**

A malformed name degrades to (2) and logs the fallback, rather than failing the
run. The name is threaded through a *derived* environment inside `execute`, never
by mutating `process.env`, so one run can never change what a concurrent run
resolves.

### Name validation

`^[a-z0-9][a-z0-9_-]{1,39}$`, then joined onto the root, then re-checked to be a
direct child of it. The pattern already excludes every separator, traversal,
whitespace, control character, and shell metacharacter; the containment re-check
is belt-and-braces. The root itself comes from a constant or
`PAPERCLIP_CODEX_VAULT_ROOT`, never from a request.

### Files changed

| File | Change |
|---|---|
| `codex-vault.ts` | **New.** Name validation, path derivation, `ensureVaultDir`, `readVaultSummary`, `listVaults`. |
| `codex-home.ts` | `resolveSharedCodexHomeDir` prefers a named vault (+1 import). |
| `execute.ts` | Resolves the run's vault, builds `credentialEnv`, threads it into the cache vend and all three seeding calls, logs which vault a run used. |
| `server/index.ts` | Barrel exports. |
| `src/index.ts` | Documents `env.PAPERCLIP_CODEX_VAULT` in the agent configuration doc. |
| `codex-vault.test.ts` | **New.** 19 unit tests. |
| `codex-vault-seed.test.ts` | **New.** 5 integration tests for the multi-agent case. |

Five files touched, two new source files, two new test files. No schema change was
needed — `config.env` is free-form, so `PAPERCLIP_CODEX_VAULT` required no
validator or migration work.

### Test results

`codex-vault.test.ts` — 19 passed. Name validation against 18 hostile inputs
(traversal, separators, `$(id)`, backticks, newline, tab, uppercase, over-length),
root resolution, 0700/0600 modes, tightening an existing 775 directory, never
overwriting `config.toml` or touching `auth.json`, usable/unusable credential
detection, account-id masking, listing and sorting, and the full
`resolveSharedCodexHomeDir` precedence chain.

`codex-vault-seed.test.ts` — 5 passed. The behaviour that matters:

| Test | Proves |
|---|---|
| symlinks rather than copies | Both agent homes resolve to the same real vault file |
| rotation propagates | A write through agent A's home is visible to B and C at once |
| vaults stay isolated | Rotating one identity does not touch another |
| re-seeding is idempotent | A second run keeps the link and the rotated credential |
| `config.toml` is copied | A run scribbling on its own config cannot edit vault policy |

Full adapter suite: **699 passed, 4 failed** — all four failures pre-existing and
unrelated (three are stale compiled `dist/` tests missing fixtures; one is
`src/server/acp.test.ts > keeps the host staged Codex home…`). Confirmed
pre-existing by stashing the changes and re-running: it fails identically on a
clean tree.

---

## 10. Phase 2 — the login lives inside Paperclip

The standalone service is no longer the way in. Provisioning now happens in
Paperclip itself, under instance-admin auth, with an audit trail.

### The flow

1. An instance admin opens **Settings → Codex logins**, types a name, clicks
   **Create and sign in**.
2. The server creates the vault directory (0700) and starts
   `codex login --device-auth` on a host pseudo-terminal, with `CODEX_HOME` set to
   a **private staging directory** — not the vault.
3. The parsed URL and one-time code are held in memory and returned only to the
   admin who started the session. The page shows them with a copy button and a
   countdown.
4. The admin approves on their own device. Codex writes `auth.json` into staging.
5. The server reads it with a descriptor-bound read, validates it, and promotes it
   into the vault atomically.
6. The staging directory is removed on every path, including failures.

### Why stage first

A failed, cancelled, or expired login must never touch a vault that agents are
currently running against. Staging means the vault only ever receives bytes that
have already passed validation — proven by the test that fails a re-login into a
populated vault and asserts the existing credential is byte-identical afterwards.

Promotion is a private-temp-then-rename under the vault's directory lock, so a
running agent following its symlink sees either the whole old credential or the
whole new one, never a partial file.

### Authorization and audit

| Concern | How |
|---|---|
| Who may provision | Instance admin only. A vault is a host path outside every company's isolation boundary, so company-scoped permission is the wrong gate. `local_implicit` counts as admin, matching the other instance routes. |
| Who may see a code | Only the admin who started that session. Another admin reading it gets a **404**, not a 403, so the existence of someone else's session is not disclosed. |
| What is recorded | `codex.vault.created`, `codex.vault.login.started`, `codex.vault.login.succeeded`, `codex.vault.login.failed` — fanned out to every company the way instance-settings changes already are. |
| What is never recorded | Tokens, the full account id, the login URL, and the one-time code. A success record carries the auth mode and a masked account suffix, which is enough to tell two accounts apart in an audit trail. |

### Why `script(1)` for the PTY

`codex login --device-auth` renders its prompt only on a terminal. `node-pty`
would add a native build to the server; util-linux `script` is already on every
supported host. `-e` matters specifically — without it every run reports exit 0
and a failed login would look successful. There is a test pinning that.

`CODEX_HOME` is passed through the environment and never interpolated into the
command string, so a session path cannot reach the shell `script` spawns.

### Files added and changed

| File | Change |
|---|---|
| `host-login-pty.ts` | **New.** Host PTY driver satisfying the existing `SandboxLoginDriver` interface, plus staging-home helpers and a descriptor-bound credential read. |
| `codex-vault.ts` | Added `promoteVaultCredential` — atomic, locked, validated. |
| `codex-vault-login-service.ts` | **New.** Session lifecycle, single-flight per vault, owner-scoped prompt, audit fan-out. |
| `routes/codex-vaults.ts` | **New.** Five instance-admin routes. |
| `app.ts`, `routes/index.ts` | Mount and export. |
| `ui/api/codexVaults.ts` | **New.** Typed client. |
| `ui/pages/InstanceCodexVaults.tsx` | **New.** The settings page. |
| `ui/App.tsx`, `ui/lib/queryKeys.ts` | Route, import, query keys. |

Reusing `SandboxLoginDriver` is what kept this small: `runDeviceLogin` — with its
prompt parsing, timeout, cancellation, and one-time prompt handling — drives the
host lane unchanged. No core login code was forked.

### Endpoints

| Method | Path |
|---|---|
| `GET` | `/api/instance/codex-vaults` |
| `POST` | `/api/instance/codex-vaults` |
| `POST` | `/api/instance/codex-vaults/:name/login-sessions` |
| `GET` | `/api/instance/codex-vaults/login-sessions/:sessionId` |
| `POST` | `/api/instance/codex-vaults/login-sessions/:sessionId/cancel` |

UI route: `/instance/settings/codex-logins`, aliased at
`/company/settings/instance/codex-logins`.

### Test results

**46 tests, all passing**, across four files:

| File | Tests | Covers |
|---|---|---|
| `codex-vault.test.ts` | 19 | Names, modes, summaries, listing, resolution precedence |
| `codex-vault-seed.test.ts` | 5 | Multi-agent symlink sharing and rotation |
| `host-login-pty.test.ts` | 13 | PTY allocation, exit propagation, prompt parse, descriptor-bound read, promotion |
| `codex-vault-login-service.test.ts` | 9 | Multi-account provisioning, session lifecycle, authorization |

The service tests run the **real** service against a fake `codex` binary that
reproduces the captured prompt — the PTY, parser, credential read, and promotion
below it are all production code. Notable cases:

- Two vaults provisioned with two different accounts stay distinct on disk
- Re-logging into one vault as a different account leaves the other untouched
- A second concurrent login for the same vault is refused, while a login for a
  *different* vault proceeds — parallel provisioning is the point
- A failed re-login leaves the existing credential byte-identical
- The one-time prompt is dropped once the session is terminal, so it cannot be replayed
- A non-owner read and a non-owner cancel both return null
- The PTY test asserts `[ -t 1 ]` is true inside the login — the property the whole
  `script(1)` approach exists to provide
- The credential read rejects a symlink, a world-readable file, an empty file, and
  an oversize file

### Deliberate scoping decisions

- **Session state is in memory, not the database.** The audit trail is durable;
  the in-flight session is not. A server restart mid-login loses the session, and
  the admin starts again. Persisting it would need a migration for a 15-minute
  object.
- **No bubblewrap confinement yet.** The sandbox lane exists so `codex login`
  never touches the host; the host lane gives that up. `bwrap` is present at
  `/usr/bin/bwrap` and Paperclip already uses it for `filesystemScope`, so jailing
  the login PTY is the natural hardening step. Not done here.
- **No agent-reference registry.** Nothing yet records which agents point at which
  vault, so nothing warns before a re-login changes the account under a running
  agent.
- **No duplicate-account detection.** Two vaults can hold the same account. The
  masked suffix makes it visible in the list but nothing enforces it.
- **The page has not been rendered.** No browser on this host — it typechecks and
  follows the design guide, but it has not been looked at.
