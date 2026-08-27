

---

## 9. The final model — provision a directory, point CODEX_HOME at it

An earlier iteration added a `PAPERCLIP_CODEX_VAULT` variable that resolved a
named directory into Paperclip's *managed* home machinery and symlinked
`auth.json` out of it. **That has been reversed out.** What remains is simpler and
uses only mechanisms that already existed.

### How it works

1. An instance admin provisions `/sysops/llm/codex/<name>/` from Settings and
   runs a device login into it. The directory ends up holding `auth.json` and
   `config.toml`.
2. An agent uses that account by setting **`CODEX_HOME`** to the directory's full
   path in its adapter config.

That is the entire mechanism.

### Why this is better than the variable it replaced

`CODEX_HOME` is an existing self-managed override, and being *outside* the
Paperclip-managed tree is what makes it work cleanly:

- **Both engines already honour it.** The CLI lane reads it at
  [execute.ts:642](packages/adapters/codex-local/src/server/execute.ts#L642); the
  ACP lane reads it at
  [acpx-engine/execute.ts:1039](packages/adapter-utils/src/acpx-engine/execute.ts#L1039).
  The new variable was only wired into the CLI lane, so on a Node ≥ 24.11 host —
  where ACP is the preferred auto lane — it silently did nothing.
- **It passes the pre-dispatch gate.** `isManagedCodexHomePath` is true only under
  `<instanceRoot>/companies/<companyId>`
  ([codex-home.ts:157](packages/adapters/codex-local/src/server/codex-home.ts#L157)),
  so an external path returns `{ managed: false, ready: true }` without
  inspection. The new variable was invisible to that gate, so a vault-bound agent
  could be blocked as "configuration incomplete".
- **No seeding touches it.** Paperclip never rewrites the credential or config of
  a self-managed home.
- **Rotation is handled by construction.** Agents sharing a directory read the
  *same* `auth.json` — not copies, not even symlinks — so Codex's single-use
  refresh-token rotation (#5028) is consistent for all of them with no machinery
  at all.

Every open bug in the previous design — the ACP gap, the readiness gap, the
missing name/path validation, the silent "set both and one wins" trap — was an
artifact of the parallel mechanism. Deleting the mechanism deleted the bugs.

### The tradeoff

Agents sharing one directory share more than the credential: `state_5.sqlite`,
`sessions/`, `history.jsonl`, and the `skills/` Paperclip injects at run time
([execute.ts:843](packages/adapters/codex-local/src/server/execute.ts#L843)).
Codex uses WAL and ships a `thread-writer-locks/` directory, so concurrent access
is anticipated, but two agents wanting different skill sets will overwrite each
other's `skills/`. The fix stays within the same model: give each agent its own
directory and log into each separately.

### What was reverted

`codex-home.ts`, `execute.ts`, and the adapter configuration doc are back to their
pre-vault state. `codex-vault-seed.test.ts` (which tested the symlink sharing) and
the resolution tests in `codex-vault.test.ts` are deleted. `codex-vault.ts` keeps
only what the provisioning UI needs: name validation, directory creation,
credential summaries, listing, and atomic promotion.

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

| Method | Path | |
|---|---|---|
| `GET` | `/api/instance/codex-vaults` | listing, now with `boundAgentCount` |
| `POST` | `/api/instance/codex-vaults` | |
| `POST` | `/api/instance/codex-vaults/:name/login-sessions` | |
| `GET` | `/api/instance/codex-vaults/login-sessions/:sessionId` | |
| `POST` | `/api/instance/codex-vaults/login-sessions/:sessionId/cancel` | |
| `DELETE` | `/api/instance/codex-vaults/:name/credential` | sign out — see §11 |
| `DELETE` | `/api/instance/codex-vaults/:name` | delete — see §11 |

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
- **No agent-reference registry.** ~~Nothing yet records which agents point at which
  vault, so nothing warns before a re-login changes the account under a running
  agent.~~ **Partly addressed in §11** — the listing now reports a
  `boundAgentCount` per vault, derived by matching each vault directory against
  `adapterConfig.env.CODEX_HOME`, and the destructive confirmations name it.
  Still outstanding: nothing warns before a **re-login**, which is the case this
  note was originally about, and the count is advisory rather than a lock.
- **No duplicate-account detection.** Two vaults can hold the same account. The
  masked suffix makes it visible in the list but nothing enforces it.
- **The page has not been rendered.** No browser on this host — it typechecks and
  follows the design guide, but it has not been looked at.

---

## 11. Removing an authorization (2026-08-27)

Provisioning and re-signing-in existed; there was no way to undo either. An
operator could create a Codex login and sign it in again, but the credential and
the directory were permanent — the only way to revoke an account was to reach
onto the host and delete files by hand. This adds that as a button, in two
strengths.

### The two actions, and why both

They are genuinely different operations, and the difference is what an agent
bound to the vault experiences:

| | Sign out | Delete |
|---|---|---|
| Removes | `auth.json` only | the whole directory |
| Keeps | directory, `config.toml`, path, Codex session state | nothing |
| Reversible | yes — sign in again and it is restored | no |
| An agent whose `CODEX_HOME` is this path | still resolves; fails to authenticate until signed in again | **stops resolving entirely** |
| Audit action | `codex.vault.credential.removed` | `codex.vault.deleted` |

"Remove the authorization" is the first one. That is the action most operators
actually want — revoke the account, keep the configured home — and it is the one
that cannot lose a `config.toml` somebody hand-tuned with model providers. Delete
is offered too, because a login created by mistake should not have to live
forever, but it is the destructive-styled button and its dialog says so.

### The blast radius, stated before the operator commits

An agent uses a vault by naming its directory in `env.CODEX_HOME`, so nothing in
the vault itself knows it is in use. The listing therefore joins each vault
directory against `agents.adapter_config -> 'env' ->> 'CODEX_HOME'` and returns
`boundAgentCount`; the row shows it as a badge and both confirmations spell out
the consequence.

One query for all vaults rather than one per vault, and a database error degrades
every count to zero rather than failing the page — an operator who cannot list
their logins because the agents table is unavailable is worse off than one who
sees the logins without warnings. **The count is advisory: read a 0 as "no
warning to show", not as proof nothing is bound.** It also does not block: an
instance admin who wants the vault gone gets it, warned.

This follows the existing house pattern — the environments settings page already
names the agents that use an environment in its delete dialog.

### Safety properties

- **Path containment.** Both primitives resolve through `resolveVaultDir`, which
  validates the name and re-checks the result is a direct child of the root.
  `deleteVault` re-asserts it at the point of the recursive remove, because that
  is the one call in the module that destroys data. Tests cover `../escape`,
  `""`, `"."`, `".."` and `"/"`, and assert a sibling directory outside the root
  survives the attempt.
- **Locking.** Both take the same `withDirectoryMergeLock` that
  `promoteVaultCredential` takes, so a removal can never interleave with a
  promotion and leave a half state.
- **Refused during a login.** A sign-out or delete while a device login is in
  flight for that vault throws `VaultLoginConflictError` -> `409`, for the same
  reason a second concurrent login is refused: both race the same credential
  file. Once the session is terminal the removal proceeds normally.
- **Sign-out is idempotent** — removing a credential from a vault that has none
  is a `200`, because the caller's intent ("this vault must hold no credential")
  is satisfied either way and a 404 would only be a race with another admin. It
  is still audited, with `removed: false`; "tried to sign out an already-empty
  vault" is a question an audit trail should be able to answer.
- **Delete reports honestly** — a vault that never existed returns
  `deleted: false` from the service and `404` from the route.
- **`unlink`, not `rm`,** for the credential: it may be a symlink into a shared
  home, and unlink removes the link without following it.

### Files changed

| File | Change |
|---|---|
| `codex-vault.ts` | **New** `removeVaultCredential` and `deleteVault`. |
| `codex-local/src/server/index.ts` | Barrel re-exports for both. |
| `codex-vault-login-service.ts` | `removeCredential`, `remove`, `agentsUsing`, `listWithUsage`. |
| `routes/codex-vaults.ts` | Two `DELETE` routes; `GET` now returns usage counts. |
| `ui/api/codexVaults.ts` | `signOut`, `remove`, `boundAgentCount` on the summary. |
| `ui/pages/InstanceCodexVaults.tsx` | Sign out + delete buttons, bound-agent badge, shared confirmation dialog. |

### Test results

**52 passing** across the three vault suites (was 36):

| File | Tests | Added |
|---|---|---|
| `codex-vault.test.ts` | 23 | +9 — removal, idempotency, sign-in-after-removal, sibling isolation, extra-state removal, and five containment cases |
| `host-login-pty.test.ts` | 13 | — |
| `codex-vault-login-service.test.ts` | 16 | +7 — sign-out/re-login cycle, cross-vault isolation, delete, unknown vault, the in-flight-login refusal on both paths, invalid names, db-unavailable degradation |

### Still open

- **Re-login still does not warn.** `boundAgentCount` is computed for the
  destructive actions; the "Sign in again" button does not consult it, so
  changing the account under a running agent is still silent. That was the
  original point of the scoping note in §10 and it is only half retired.
- **No UI test.** This page has never had one; the buttons are covered only by
  the server-side suites and a typecheck.
- **Nothing revokes the credential upstream.** Sign-out deletes the local
  credential; it does not tell OpenAI to invalidate the token. An operator who
  needs the account truly revoked must also do it in the provider's dashboard.
