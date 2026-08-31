---
name: codex-home-changes
description: What the PAPERCLIP_CODEX_HOME ("Codex Home") change set is, why it exists, exactly what was modified, what is verified, and the register of known gaps still open. Read this before touching any codex-local CODEX_HOME resolution code, and before concluding that the override "does not work" — section 2 and section 6 step 0 cover the two ways to test the wrong process entirely.
metadata:
  status: OpenRouter path working and in use; gaps 5.2-5.6 open
  owner: Chris (cwa@youritdept.com)
  written: 2026-08-20
  base-commit: 364ab497 "This seems to be working, so I'm going to test it through a release cycle."
---

# Codex Home change set — handoff instructions

> **RULE 0 — never commit, push, or check anything in.** The operator
> reviews every diff visually in the VS Code IDE and commits it themselves.
> Full statement at the top of
> [`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md).

> To use this as a real, auto-discovered skill, copy this file to
> `skills/codex-home-changes/SKILL.md`. It lives at the repo root because that
> is where the working notes for this branch live.

## 0. TL;DR for a fresh agent

We added a **second, Paperclip-managed** way to point the `codex_local` adapter at a
Codex home: a new env var **`PAPERCLIP_CODEX_HOME`**, read from the run's adapter
config and, failing that, from the server's own process environment.

- `CODEX_HOME` (pre-existing) = "**I own this home, hands off**". Paperclip never
  seeds it, never injects skills into it, never writes `auth.json` into it.
- `PAPERCLIP_CODEX_HOME` (new) = "**relocate the managed home**". Paperclip still
  owns it: auth seeding, skill injection, `PAPERCLIP_CODEX_PROVIDERS` merge, sandbox
  staging all still happen — just at a path we chose instead of the default
  `<instanceRoot>/companies/<companyId>/codex-home`.

**Status as of 2026-08-20:** the override now works for the case it was built for.
The blocker was **not** the override plumbing — it was the credential gate, which
recognised only OpenAI-shaped credentials and so rejected an OpenRouter home before
dispatch. See **5.0**, which is the fix and the reproduction. 5.1 and 5.7 are fixed
too; 5.2 through 5.6 are still open, and 5.6 is still a design decision, not a patch.
Read 5.0 first, then section 8.

The original one-line requirement, verbatim from `Codex_Home.md` on the
`W2-v2026.817.0a-CODEX` branch:

> "I want to be able to use a Codex Home and be able to work."

## 1. Why we are doing this

The `codex_local` adapter has exactly two states today, and neither one fits the
deployment we actually want:

| State | How you get it | Problem |
|---|---|---|
| Default managed home | leave `CODEX_HOME` unset | Path is derived (`<instanceRoot>/companies/<companyId>/codex-home`). You cannot put it on a different disk, a shared volume, or a pre-provisioned location. |
| External override | set `CODEX_HOME` | Path is yours, but Paperclip treats it as **self-managed** and stops doing everything useful: no auth seeding, no skill injection, no provider merge. You must hand-maintain `auth.json`. |

There was no way to say *"use this path, but keep managing it for me."* That is the
gap. `PAPERCLIP_CODEX_HOME` is that third state, and — critically — it is settable
**once** as an instance-wide default instead of per-agent. There are two places to
set it, and they are not equivalent:

- **On the server's process env**, where the engine starts (supervisor unit,
  systemd unit, `.env`). Simplest, survives every new agent and company, and needs
  no portal state at all. This is the one to reach for.
- **On a Paperclip Environment**, whose env is merged as the base layer for every
  run (`server/src/services/heartbeat.ts:1110-1113`). Use this when the default
  should differ per environment rather than per instance.

Adapter config wins over process env, so a per-agent value still overrides an
engine-level default.

### Precedence, as designed

```
1. config.env.CODEX_HOME             -> self-managed, wins over everything, never seeded
2. config.env.PAPERCLIP_CODEX_HOME   -> managed, relocated, fully seeded
3. process.env.PAPERCLIP_CODEX_HOME  -> managed, relocated, instance-wide default
4. resolveManagedCodexHomeDir()      -> managed, default derived path
```

Levels 2 and 3 are one function —
`resolveManagedCodexHomeOverride(envConfig, processEnv)` in
`packages/adapter-utils/src/server-utils.ts` — so every consumer resolves the
override identically. Blank/whitespace values fall through to the next level.

### Env-layer precedence that feeds the above

From `server/src/services/heartbeat.ts` `resolveExecutionRunAdapterConfig()`:

```
process.env      (below everything, engine-wide)  <- the simplest instance default
  environment.env  (base config layer)
    agent adapterConfig.env (overrides environment)
      project.env           (overrides agent)
        routine.env         (overrides everything)
```

Only `PAPERCLIP_API_KEY` is stripped from env bindings
(`FORBIDDEN_ENV_BINDING_KEYS`, heartbeat.ts:862), so `PAPERCLIP_CODEX_HOME` passes
through cleanly. That is **not** the bug — do not go looking there.

## 2. Where the work lives (branches, builds, artifacts)

Three branches matter. **Read this before you branch or build anything.**

| Branch | Tip | Contains |
|---|---|---|
| `W2-v2026.817.0a` | `88a1cb49` | Baseline. No Codex Home work. |
| `W3-CodexChanges` | `364ab497` | **All source changes. Branch from here.** `35a3a08d` is the original override plumbing; `364ab497` adds the 2026-08-20 fixes in section 3A. |
| `W2-v2026.817.0a-CODEX` | `d078fbfe` | `35a3a08d` **+ a local release-build snapshot committed by accident.** |

`d078fbfe` ("Working on a codex change") contains **zero source changes** — it is
300 files of `server/ui-dist/` build output, generated skill copies under
`packages/adapters/claude-local/skills/`, and rewritten `package.json` files where
`workspace:*` deps were replaced with pinned `0.0.0-local.35a3a08d` versions. Its
only hand-written file is the one-line `Codex_Home.md`.

**Warnings:**

- **Do not branch source work from `W2-v2026.817.0a-CODEX`.** The rewritten
  `package.json` files (`cli/package.json`, `packages/adapter-utils/package.json`,
  `packages/adapters/claude-local/package.json`, `ui/package.json`) are the
  *publish* form, not the *dev* form. `pnpm install` in a dev checkout will not
  resolve correctly.
- **The deployed instance does not run this checkout.** Supervisor
  (`/etc/supervisor/conf.d/supervisord.conf` -> `[program:paperclip]` ->
  `/home/engineroom/supervisord/paperclip-run.sh`) execs `$PAPERCLIP_CLI run`,
  which is the *installed* binary under `/install/paperclip/<version>`. The CLI's
  `importServerEntry()` (`cli/src/commands/run.ts`) derives `projectRoot` from its
  own module path, finds no `server/src/index.ts` there, and falls through to
  `import("@paperclipai/server")` — the release. **Rebuilding this repo can never
  reach that process.** Only reinstalling the release can. This cost a full
  debugging session on 2026-08-20: the running release was
  `0.0.0-local.c5ec8cfe`, which contains zero occurrences of
  `PAPERCLIP_CODEX_HOME`, so the feature appeared inert no matter what was set.
  Verify with:
  `grep -rl PAPERCLIP_CODEX_HOME /install/paperclip/*/node_modules/@paperclipai/`
- Running `paperclipai run` **from this repo** does pick up your edits — that path
  finds `server/src/index.ts` and loads TypeScript through tsx. Two gotchas: the
  supervisor-managed release must be stopped first or port 3100 is already taken,
  and `pnpm build` is irrelevant to it, because every workspace package exports
  `./src/*.ts` rather than `dist`. (`pnpm build` also OOM-kills on the `ui` Vite
  step on this 16 GB, swap-less box — use
  `pnpm -r --workspace-concurrency=1 build` when you do need a real build.)
- `/sysops/paperclip/AUTORUN.md` is the supervisor's autorun gate. Without it
  `paperclip-run.sh` exits 0 immediately and supervisor starts nothing.
- `dist/` is gitignored (`.gitignore:5`). It matters only for the release path and
  for ad-hoc `node` scripts that import built output.
- Workspace packages are symlinked: `server/node_modules/@paperclipai/adapter-codex-local`
  and `cli/node_modules/...` both point at `packages/adapters/codex-local`. So a
  rebuild of that package is picked up without reinstalling.

## 3. Exactly what changed (all in `35a3a08d`)

Six files, +114 / -6.

### 3.1 `packages/adapters/codex-local/src/server/codex-home.ts`

- Added optional `managedCodexHomeOverride` to `CodexCredentialReadinessInput`
  (now `CodexCredentialReadinessInput`, codex-home.ts:887).
- `evaluateCodexCredentialReadiness()` (now codex-home.ts:943) now resolves:
  `configuredCodexHome ?? managedCodexHomeOverride ?? resolveManagedCodexHomeDir(...)`.
- The override is `path.resolve()`d and blank-trimmed.
- **Deliberate semantic:** `effectiveHomeIsManaged` stays `true` when only the
  override is set, so the home is still seeded and still credential-gated. See
  section 5.6 — this is also where an inconsistency lives.

### 3.2 `packages/adapters/codex-local/src/server/execute.ts` (the Codex CLI lane)

- Reads `envConfig.PAPERCLIP_CODEX_HOME` into `managedCodexHomeOverride`. **Superseded by 3A.1** — this is now one call to the shared resolver (execute.ts:646).
- Seeding branch (execute.ts:700): when there is no `CODEX_HOME` **and** an override
  exists, call `seedManagedCodexHome(override, ...)` directly instead of
  `prepareManagedCodexHome(...)`. Necessary because `prepareManagedCodexHome()`
  derives its own target from `resolveManagedCodexHomeDir()` and cannot be told a
  path (codex-home.ts:784).
- `defaultCodexHome` is now `managedCodexHomeOverride ?? resolveManagedCodexHomeDir(...)`.
- Threads `managedCodexHomeOverride` into `assertCodexCredentialsLaunchable()`
  (signature at execute.ts:378, call site ~line 748).

### 3.3 `packages/adapter-utils/src/acpx-engine/execute.ts` (the ACP lane)

- Same override read in `prepareCodexSkillRuntime()` (acpx-engine/execute.ts:1036, now the shared resolver), feeding
  `managedCodexHome`, which is passed as the explicit `targetHome` to that lane's
  own `prepareManagedCodexHome({ targetHome, ... })`. **This lane is correct** —
  its `prepareManagedCodexHome` takes a target parameter, unlike the adapter's.

### 3.4 `packages/adapters/codex-local/src/server/acp.ts`

- `testCodexAcpEnvironment()` reads the override at both readiness call sites
  (both now the shared resolver) and passes it to `evaluateCodexCredentialReadiness`.

### 3.5 `server/src/services/heartbeat.ts`

- One line (1193): the pre-dispatch credential gate now passes
  `managedCodexHomeOverride: readNonEmptyString(resolvedEnv.PAPERCLIP_CODEX_HOME)`,
  so the gate inspects the same home the run will actually use. Without this, a
  correctly-provisioned override home would be blocked as "no Codex credentials".

### 3.6 `packages/adapters/codex-local/src/server/codex-home.test.ts`

Three new tests (+55):

1. Override resolves the effective home, and the result is still `managed: true`.
2. An explicit `CODEX_HOME` beats `PAPERCLIP_CODEX_HOME`.
3. A whitespace-only override falls back to the default managed home.

## 3A. What changed on 2026-08-20 (`364ab497` + the banner)

Section 3 above describes the original override plumbing only. This is everything
added on top of it. Section 5 carries the *why* for each; this is the map.

### 3A.1 `packages/adapter-utils/src/server-utils.ts`

New `resolveManagedCodexHomeOverride(envConfig, processEnv)` (~line 3548). Single
source of truth for levels 2 and 3 of the precedence ladder — adapter config first,
then the server's process env, both `path.resolve()`d and blank-trimmed. Lives in
`adapter-utils` because the ACP lane cannot import from `codex-local` (the
dependency runs the other way), and a second copy is exactly how the two lanes
drift. Used by all five read sites.

### 3A.2 `packages/adapters/codex-local/src/server/codex-home.ts`

- `CodexCredentialAuthMode` gained a third value, `"provider"`.
- `CodexCredentialReadinessInput` gained `configuredProviders`; the result gained
  `modelProvider`.
- `readCodexHomeCustomModelProvider(home)` — dependency-free scan of a home's
  `config.toml` for a root `model_provider` plus its matching
  `[model_providers.<id>]` table. A scanner, not a parser: TOML requires root keys
  before the first table header, so a line walk cannot be fooled by nested tables,
  and there is no TOML parser in this workspace to reach for.
- `readConfiguredCustomModelProvider(json)` — the same question asked of
  `PAPERCLIP_CODEX_PROVIDERS`, which is merged into `config.toml` at execute time,
  *after* the gate runs.
- `evaluateCodexCredentialReadiness()` (~line 943) consults both before falling
  through to the `auth.json` check.

### 3A.3 Read sites now using the shared resolver

| File | Symbol |
|---|---|
| `adapters/codex-local/src/server/execute.ts:646` | CLI lane |
| `adapter-utils/src/acpx-engine/execute.ts:1036` | ACP lane |
| `adapters/codex-local/src/server/acp.ts` (both readiness call sites) | ACP Test panel |
| `adapters/codex-local/src/server/test.ts:314` | Codex Test panel |
| `server/src/services/heartbeat.ts:1190` | pre-dispatch gate |

### 3A.4 Observability

- Both lanes log the effective home and its provenance on every run
  (`execute.ts` ~line 716, `acpx-engine/execute.ts` ~line 1095).
- `server/src/startup-banner.ts` prints `Codex Home` and `OpenRouter` rows — see
  5.7.

### 3A.5 Tests

| File | Count |
|---|---|
| `adapters/codex-local/src/server/codex-home.test.ts` | 65 (was 52) |
| `adapter-utils/src/server-utils.test.ts` | 98 |
| `server/src/startup-banner.test.ts` | 9 (new file) |

## 4. Verified state

```
npx vitest run packages/adapters/codex-local/src/server/codex-home.test.ts   # 65 passed (52 before 5.0)
npx vitest run packages/adapter-utils/src/server-utils.test.ts               # 98 passed
npx vitest run server/src/startup-banner.test.ts                             # 9 passed
npx vitest run server/src/services/heartbeat                                 # 13 passed
```

Beyond unit tests, confirmed by hand on 2026-08-20 against the real OpenRouter
home at `/home/octobot/codex-deepseek-v4-flash-0731`:

- `codex exec` completes a prompt on `deepseek/deepseek-v4-flash-0731`.
- `codex-acp` driven over stdio the way the ACP lane drives it (initialize ->
  session/new -> session/prompt) completes a prompt and returns
  `stopReason: end_turn`. This is the lane the portal selects by default.
- Seeding the home is non-destructive: `ensureCopiedFile` is copy-if-absent, so the
  OpenRouter `config.toml` survives seed + provider merge + cleanup byte-identical.
- The pre-dispatch gate, replayed with the real company id, reproduces the reported
  failure with nothing set and dispatches with the override set either way (5.0).
- All three `Codex Home` banner states and both `OpenRouter` states, against a live
  boot.

**Not yet verified:** a full agent heartbeat through the portal on a relocated
home. Every layer it passes through has been exercised, but not in one run.

**Pre-existing failures elsewhere** — these reproduce with the branch changes
stashed, so do not chase them: `acp.test.ts` "keeps the host staged Codex home"
(staged-dir count), and `dist/` copies of `device-login-parse.test.js` and
`sandbox-managed-runtime.test.js`, whose fixtures are not emitted into `dist/`.

## 5. Gap register

Originally a ranked list of suspects for why the override appeared inert. 5.0, 5.1
and 5.7 are now fixed and kept here as the record of what was wrong and why;
**5.2 through 5.6 are still open**, and 5.6 is a design decision rather than a
patch. Each is code-confirmed. Work top-down.

### 5.0 The credential gate rejects any non-OpenAI provider — WAS THE BLOCKER, FIXED

Reproduced and fixed on 2026-08-20 while testing an OpenRouter home at
`/home/octobot/codex-deepseek-v4-flash-0731`.

`evaluateCodexCredentialReadiness()` recognised exactly two credential shapes:
a usable `auth.json` (ChatGPT tokens or `OPENAI_API_KEY`) and a configured
`OPENAI_API_KEY`. An OpenRouter home has neither — it authenticates through
`[model_providers.openrouter.auth]`, a command that reads `$OPENROUTER_API_KEY`
from the run environment. So the home came back `managed: true, ready: false`,
and the pre-dispatch gate (heartbeat.ts:1190) threw `ConfigurationIncompleteFailure`
**before dispatch**.
The run never reached either lane, which is why the override looked inert and why
setting `CODEX_HOME` to the same path "worked" — that is the self-managed escape
hatch, which is always treated as ready.

Measured, before the fix:

```
PAPERCLIP_CODEX_HOME only  {"managed":true,"authMode":"subscription","ready":false,...}
CODEX_HOME instead         {"managed":false,"authMode":"subscription","ready":true,...}
```

This was never specific to `PAPERCLIP_CODEX_HOME`: it blocked the already-supported
`PAPERCLIP_CODEX_PROVIDERS` path too, and any managed home routed at a gateway or
OpenAI-compatible endpoint.

Fix: readiness gained a third `authMode`, `"provider"`. A managed home whose
`config.toml` selects a non-OpenAI `model_provider` **and** defines the matching
`[model_providers.<id>]` table is ready — the provider owns its own credential, so
there is nothing for Paperclip to provision. `PAPERCLIP_CODEX_PROVIDERS` is read
the same way, because that merge happens at execute time, after the gate. A
half-configured file (selector without a table) stays on the strict OpenAI path.
If the provider key really is absent, Codex now fails at its first request with
the provider's own error instead of being pre-empted by a misleading one.

Verified end to end: `codex exec` and `codex-acp` (ACP lane, driven over stdio
with `CODEX_HOME` pointed at the home and `OPENROUTER_API_KEY` inherited) both
complete a prompt against `deepseek/deepseek-v4-flash-0731` via OpenRouter, and
seeding the home is non-destructive — `ensureCopiedFile` is copy-if-absent, so the
OpenRouter `config.toml` survives, and with no `auth.json` in the shared source
home there is nothing to symlink over it.

**Operational note (superseded).** As originally written, `PAPERCLIP_CODEX_HOME`
was read *only* from the resolved adapter-config env, so exporting it in the shell
that starts Paperclip did nothing — a second, independent reason the override
looked inert. `364ab497` added the process-env fallback (3A.1), so both placements
now work; see the two options in section 1.

### 5.1 The Environment Test panel reads the HOST home, not the managed one — FIXED

Was, at `packages/adapters/codex-local/src/server/test.ts`:

```ts
const codexHome = isNonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : undefined;
const codexAuth = await readCodexAuthInfo(codexHome).catch(() => null);
```

With only `PAPERCLIP_CODEX_HOME` set, `codexHome` is `undefined` and
`readCodexAuthInfo` falls back to `codexHomeDir()` — the **host `~/.codex`**. The
Test panel's "Codex credentials" row therefore describes a home that has nothing to
do with the override. **If Chris is judging the change by the Test button, the Test
button is lying.** This is the single most likely explanation for "it doesn't seem
to be doing what we think it's doing."

Fixed 2026-08-20: `test.ts` now resolves the effective home with the same
precedence as execute, through the shared resolver (test.ts:314), and reports provider-owned auth as its own check (`codex_model_provider_auth`)
instead of warning about an `OPENAI_API_KEY` the run never reads. `acp.ts` gained
the matching `codex_acp_model_provider_auth` check.

### 5.2 The remote/sandbox Test probe seeds the DEFAULT managed home — HIGH

`packages/adapters/codex-local/src/server/test.ts:102`:

```ts
const managedHome = await prepareManagedCodexHome(process.env, async () => {}, input.companyId, { apiKey: null });
```

No override parameter. The probe uploads `auth.json`/`config.toml` from the default
company home while the real run uses the override — so Test and Run disagree on
sandbox targets.

### 5.3 Per-agent isolation silently sets `CODEX_HOME`, which outranks the override — HIGH

`server/src/routes/agents.ts:1809-1823` (`applyCodexLocalKeyIsolation`): when a
`codex_local` agent has its **own `OPENAI_API_KEY`** and no `CODEX_HOME`, the server
**writes** `CODEX_HOME = <instanceRoot>/companies/<c>/agents/<a>/codex-home` into
the persisted adapter config.

Consequence: for every such agent, `CODEX_HOME` is set, so by our own precedence
rule `PAPERCLIP_CODEX_HOME` is **ignored forever** — and there is no log line
saying so. If the agent under test has an `OPENAI_API_KEY` bound, this is the bug.

**Decision needed (see section 8):** should the isolation guard also skip when
`PAPERCLIP_CODEX_HOME` is present, or write the isolated path *under* the override
root instead?

### 5.4 Startup auth reconciliation ignores the override — MEDIUM

`server/src/services/codex-auth-reconciliation.ts:100`:

```ts
const configuredCodexHome = env ? readPlainEnvValue(env.CODEX_HOME) : null;
```

`reconcileCodexLocalManagedHomesOnStartup()` therefore repairs the default managed
home at boot and leaves the override home unseeded. First run after a restart can
find an empty override home.

### 5.5 Device-login promotion writes to the default company home — MEDIUM

`packages/adapters/codex-local/src/server/adapter-auth-promotion.ts:215`:

```ts
const companyHome = resolveManagedCodexHomeDir(env, companyId);
```

Sign in via device login and the promoted `auth.json` lands in the default home
while the run reads the override. Symptom: "I logged in and it still says no
credentials." Related: `device-login-export.ts:116`'s
`assertProofHomeIsSafeTarget()` guard doesn't know the override is a managed home,
so its refusal list has a hole.

### 5.6 `isManagedCodexHomePath()` and the readiness check disagree — MEDIUM

`codex-home.ts:127-141` defines "managed" as *physically under
`<instanceRoot>/companies/<companyId>/`*. An override pointed anywhere else (the
whole point of the feature — another disk, a shared volume) returns `false` there,
while `evaluateCodexCredentialReadiness()` now treats that same path as
`managed: true`. Every other consumer of `isManagedCodexHomePath` (seeding guards,
auth copyback, sandbox staging decisions) will classify the override as an external
self-managed home.

This is a **design fork that has to be resolved deliberately**, not patched
site-by-site. Two coherent options:

- **(a)** Make `isManagedCodexHomePath` override-aware — pass the override in and
  return `true` for it. Consistent, but touches every call site.
- **(b)** Constrain `PAPERCLIP_CODEX_HOME` to paths under the instance root and
  reject anything else at config-validation time. Much smaller blast radius, but
  it rules out the cross-disk use case, which may be the actual requirement.

**Do not start coding section 5 fixes until this is decided** — 5.4 and 5.5 both
depend on the answer.

### 5.7 No observability — FIXED

Fixed 2026-08-20: both lanes now log the effective home and its provenance on
every run — `[paperclip] Codex home "<path>" (from CODEX_HOME | PAPERCLIP_CODEX_HOME
| the default managed path)`, and explicitly `"; PAPERCLIP_CODEX_HOME is set but
outranked"` when an explicit `CODEX_HOME` wins. That last case is 5.3's silent
failure, now visible in the run log.

Original note: nothing logged "override in effect" or "override ignored because
CODEX_HOME is set." Every failure above was silent. The seeding log line
(`[paperclip] Using ... Codex home "<target>" (seeded from "<source>")`,
codex-home.ts:771) is the only signal, and it only fires on the seed path.

**Startup banner (added 2026-08-20).** The per-run log line answers "which home
did *that* run use". It does not answer "did the instance-wide default take at
all", which is the question you have before any run exists — and getting it wrong
is silent for exactly as long as it takes to dispatch something. So
`server/src/startup-banner.ts` now prints two rows:

```
Codex Home       /home/octobot/codex-deepseek-v4-flash-0731
OpenRouter       sk-or-v1-797...c02
```

- **Codex Home** reads `PAPERCLIP_CODEX_HOME` through the same
  `resolveManagedCodexHomeOverride()` the run path uses, so the banner cannot
  claim a default the adapter would not honour. Three states:
  - set and present -> the resolved absolute path, green
  - set and **absent** -> `<path> (missing — created and seeded on first run)`,
    yellow. This is the typo case, and it is worth calling out: seeding creates
    the directory, so a mistyped path yields an *empty* home with no provider
    config rather than an error, and the run then fails the credential gate for
    a provider that was never there.
  - unset -> `not set (agents use the per-company managed home)`, yellow
- **OpenRouter** masks `OPENROUTER_API_KEY` head-and-tail in the OpenRouter
  dashboard's own format (`sk-or-v1-797...c02`) so a banner line can be matched
  against a dashboard row without putting usable key material on a terminal that
  gets screenshotted into tickets. Keys under 32 characters print as bare `set` —
  the window would otherwise expose most of a short key. Unset prints `not set`.

Both helpers are unit-tested in `server/src/startup-banner.test.ts` (9 tests),
and all three Codex Home states plus both key states were confirmed against a
live boot.

## 6. How to diagnose a run

0. **Confirm the process you are testing is the code you edited.** This is not
   paranoia — it was the actual answer on 2026-08-20. See the supervisor/release
   warning in section 2. `/api/health` reports `commit`; compare it to `git log -1`.
1. **Read the startup banner.** `Codex Home` tells you whether an engine-level
   default is in effect, and whether the path exists. A `not set` there when you
   expected a default means the variable never reached the process — check *where*
   you set it before checking anything else.
2. Confirm which lane is running: adapter config `engine` is `auto` | `cli` | `acp`
   (`packages/adapters/codex-local/src/server/config-schema.ts:13-24`). The ACP lane
   (3.3) is the portal default. **Pin `engine` explicitly while debugging** —
   `auto` will move under you.
3. Read the per-run provenance line: `[paperclip] Codex home "<path>" (from ...)`.
   It names the effective home *and* its source. `"; PAPERCLIP_CODEX_HOME is set but
   outranked"` means section 5.3 — an explicit `CODEX_HOME`, usually written by the
   per-agent key-isolation guard.
4. If the error names a home you did not configure, read the path. A
   `.../companies/<id>/codex-home` means no override was seen at all;
   `.../companies/<id>/agents/<id>/codex-home` means 5.3.
5. Grep the run log for the seeding line and read the quoted target path — that is
   the home Paperclip actually seeded.
6. Inspect the override directory on disk: it should contain `auth.json` (symlink
   to the host home, or a regular file for API-key/promoted auth), `config.toml`,
   `config.json`, `instructions.md`, and `skills/`. That set is
   `CODEX_SYNC_ALLOWLIST` (codex-home.ts:24-28). An empty or partial directory means
   seeding never ran against it. **A non-OpenAI home legitimately has no
   `auth.json`** — that is the 5.0 case, not a fault.
7. A dangling `auth.json` symlink counts as *no* credentials
   (`codexHomeHasUsableAuth` uses `fs.access`, which follows links). The default
   company home on this box symlinks to `/home/octobot/.codex/auth.json`, which
   does not exist.

## 7. Definition of done

- [ ] Resolve the section 5.6 design fork (option (a) or (b)) and write the answer down.
- [x] Non-OpenAI providers pass the credential gate (5.0).
- [~] Test lanes: 5.1 fixed; 5.2 (sandbox probe seeds the default home) still open.
- [ ] Per-agent key isolation (5.3) no longer silently defeats the override.
- [ ] Startup reconciliation (5.4) and device-login promotion (5.5) target the effective home.
- [x] One log line naming the effective home and its provenance (`CODEX_HOME` / `PAPERCLIP_CODEX_HOME` / default) on every run (5.7).
- [x] Startup banner reports the effective `PAPERCLIP_CODEX_HOME` default and the
      masked `OPENROUTER_API_KEY`, so a misconfigured instance is visible at boot
      instead of at first dispatch (5.7).
- [ ] An end-to-end run on a relocated home *through a real agent heartbeat*: the
      lanes themselves are verified (5.0), but a full agent run is not.
- [ ] `docs/adapters/codex-local.md` updated — it documents the two-state model
      (see its "Managed `CODEX_HOME`" section, ~lines 48-91) and says nothing about
      the third state.
- [ ] Decide the fate of `Codex_Home.md` and the accidental build-artifact commit
      `d078fbfe` (see section 2).

## 8. Open questions for Chris

1. **Scope of `PAPERCLIP_CODEX_HOME`:** must it support a path *outside* the
   Paperclip instance root (another disk / shared volume), or is "a different
   directory inside the instance root" enough? This decides 5.6 (a) vs (b) and
   roughly triples or thirds the remaining work.
2. **Interaction with per-agent API-key isolation (5.3):** when an agent has its own
   `OPENAI_API_KEY` *and* an override is set, should the isolated per-agent home be
   created under the override root, or should the override win outright and agents
   share it?
3. **Is one shared override home per instance the goal, or one per company?** The
   default managed path is company-scoped and the override erases that scoping
   unless the value itself encodes it. The process-env fallback (3A.1) sharpens
   this: an engine-level default is *by construction* one home for every company on
   the instance. That is what you asked for, and it is fine while this box runs one
   real company — but it is the assumption to revisit before a second one exists,
   because two companies would then share Codex sessions, history, and any
   `auth.json` written into that home.
4. **Should the banner's `Codex Home` row also report the selected
   `model_provider`?** It currently reports the path and whether it exists, which
   answers "did the default take". It does not answer "is this home actually routed
   at OpenRouter" — that needs reading `config.toml`, which the banner does not do
   today. Cheap to add if the boot-time answer is worth it.
