---
name: codex-home-changes
description: What the PAPERCLIP_CODEX_HOME ("Codex Home") change set is, why it exists, exactly what was modified, what is verified, and the ranked list of known gaps that explain why it does not yet behave as intended. Read this before touching any codex-local CODEX_HOME resolution code.
metadata:
  status: in-progress / not-working-as-intended
  owner: Chris (cwa@youritdept.com)
  written: 2026-08-20
  base-commit: 35a3a08d "Check in for now"
---

# Codex Home change set — handoff instructions

> To use this as a real, auto-discovered skill, copy this file to
> `skills/codex-home-changes/SKILL.md`. It lives at the repo root because that
> is where the working notes for this branch live.

## 0. TL;DR for a fresh agent

We added a **second, Paperclip-managed** way to point the `codex_local` adapter at a
Codex home: a new adapter-config env var **`PAPERCLIP_CODEX_HOME`**.

- `CODEX_HOME` (pre-existing) = "**I own this home, hands off**". Paperclip never
  seeds it, never injects skills into it, never writes `auth.json` into it.
- `PAPERCLIP_CODEX_HOME` (new) = "**relocate the managed home**". Paperclip still
  owns it: auth seeding, skill injection, `PAPERCLIP_CODEX_PROVIDERS` merge, sandbox
  staging all still happen — just at a path we chose instead of the default
  `<instanceRoot>/companies/<companyId>/codex-home`.

The **source changes are complete and unit-tested** (52/52 pass in
`packages/adapters/codex-local/src/server/codex-home.test.ts`), but **end-to-end
behavior is wrong** — the override does not consistently take effect at runtime.
Section 5 is the ranked list of why. Start there.

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
**once at environment scope** as an instance-wide default, instead of per-agent,
because environment-scope env is merged as the base layer for every run
(`server/src/services/heartbeat.ts:1109-1113`).

### Precedence, as designed

```
1. config.env.CODEX_HOME            -> self-managed, wins over everything, never seeded
2. config.env.PAPERCLIP_CODEX_HOME  -> managed, relocated, fully seeded
3. resolveManagedCodexHomeDir()     -> managed, default derived path
```

Blank/whitespace values fall through to the next level. This precedence is asserted
by three tests (see section 3).

### Env-layer precedence that feeds the above

From `server/src/services/heartbeat.ts` `resolveExecutionRunAdapterConfig()`:

```
environment.env  (base)   <- put PAPERCLIP_CODEX_HOME here for an instance-wide default
  agent adapterConfig.env (overrides environment)
    project.env           (overrides agent)
      routine.env         (overrides everything)
```

Only `PAPERCLIP_API_KEY` is stripped from env bindings
(`FORBIDDEN_ENV_BINDING_KEYS`, heartbeat.ts:861), so `PAPERCLIP_CODEX_HOME` passes
through cleanly. That is **not** the bug — do not go looking there.

## 2. Where the work lives (branches, builds, artifacts)

Three branches matter. **Read this before you branch or build anything.**

| Branch | Tip | Contains |
|---|---|---|
| `W2-v2026.817.0a` | `88a1cb49` | Baseline. No Codex Home work. |
| `W3-CodexChanges` | `35a3a08d` | **All source changes. Branch from here.** |
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
- `dist/` is gitignored (`.gitignore:5`). A fresh clone in another directory has
  **no build output**. The server runs compiled JS — if you edit `src/` and do not
  rebuild, you are testing the old code. In this working copy the dist *is* current
  (built 21:51–21:52, sources last touched 21:42) and does contain
  `managedCodexHomeOverride`; in a fresh clone it will not exist at all.
- Workspace packages are symlinked: `server/node_modules/@paperclipai/adapter-codex-local`
  and `cli/node_modules/...` both point at `packages/adapters/codex-local`. So a
  rebuild of that package is picked up without reinstalling.

## 3. Exactly what changed (all in `35a3a08d`)

Six files, +114 / -6.

### 3.1 `packages/adapters/codex-local/src/server/codex-home.ts`

- Added optional `managedCodexHomeOverride` to `CodexCredentialReadinessInput`
  (around line 798).
- `evaluateCodexCredentialReadiness()` (around line 843) now resolves:
  `configuredCodexHome ?? managedCodexHomeOverride ?? resolveManagedCodexHomeDir(...)`.
- The override is `path.resolve()`d and blank-trimmed.
- **Deliberate semantic:** `effectiveHomeIsManaged` stays `true` when only the
  override is set, so the home is still seeded and still credential-gated. See
  section 5.6 — this is also where an inconsistency lives.

### 3.2 `packages/adapters/codex-local/src/server/execute.ts` (the Codex CLI lane)

- Reads `envConfig.PAPERCLIP_CODEX_HOME` into `managedCodexHomeOverride` (~line 636-646).
- Seeding branch (~line 685-700): when there is no `CODEX_HOME` **and** an override
  exists, call `seedManagedCodexHome(override, ...)` directly instead of
  `prepareManagedCodexHome(...)`. Necessary because `prepareManagedCodexHome()`
  derives its own target from `resolveManagedCodexHomeDir()` and cannot be told a
  path (codex-home.ts:696-704).
- `defaultCodexHome` (~line 705) is now `managedCodexHomeOverride ?? resolveManagedCodexHomeDir(...)`.
- Threads `managedCodexHomeOverride` into `assertCodexCredentialsLaunchable()`
  (signature extended ~line 378-395, call site ~line 720).

### 3.3 `packages/adapter-utils/src/acpx-engine/execute.ts` (the ACP lane)

- Same override read in `prepareCodexSkillRuntime()` (~line 1031-1044), feeding
  `managedCodexHome`, which is passed as the explicit `targetHome` to that lane's
  own `prepareManagedCodexHome({ targetHome, ... })`. **This lane is correct** —
  its `prepareManagedCodexHome` takes a target parameter, unlike the adapter's.

### 3.4 `packages/adapters/codex-local/src/server/acp.ts`

- `testCodexAcpEnvironment()` reads the override at both readiness call sites
  (~lines 576 and 622) and passes it to `evaluateCodexCredentialReadiness`.

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

## 4. Verified state

```
npx vitest run packages/adapters/codex-local/src/server/codex-home.test.ts
# Test Files 1 passed (1) / Tests 52 passed (52)
```

That is the extent of the verification. **No end-to-end run has been confirmed
working.** Unit tests cover the *resolution function* in isolation; they do not
cover whether the override survives the full config → dispatch → adapter → spawn
path, which is exactly where the reported problem is.

## 5. Why it is not doing what we think — ranked suspects

Each of these is a real, code-confirmed gap. Work top-down.

### 5.1 The Environment Test panel reads the HOST home, not the managed one — HIGH

`packages/adapters/codex-local/src/server/test.ts:300-307`:

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

Fix: thread the override into this lane the same way acp.ts does.

### 5.2 The remote/sandbox Test probe seeds the DEFAULT managed home — HIGH

`packages/adapters/codex-local/src/server/test.ts:97`:

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
credentials." Related: `device-login-export.ts:125`'s
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

### 5.7 No observability — LOW severity, HIGH annoyance

Nothing logs "override in effect" or "override ignored because CODEX_HOME is set."
Every failure above is silent. The seeding log line
(`[paperclip] Using ... Codex home "<target>" (seeded from "<source>")`,
codex-home.ts ~line 686) is the only signal, and it only fires on the seed path.

## 6. How to diagnose a run

1. Confirm which lane is running: adapter config `engine` is `auto` | `cli` | `acp`
   (`packages/adapters/codex-local/src/server/config-schema.ts:13-24`). The ACP lane
   (3.3) is believed correct; the CLI lane (3.2) is where the gaps cluster. **Pin
   `engine` explicitly while debugging** — `auto` will move under you.
2. Dump the agent's resolved adapter config and check whether `CODEX_HOME` is
   present. If it is, section 5.3 is your answer.
3. Grep the run log for the seeding line and read the quoted target path — that is
   the home Paperclip actually seeded.
4. Inspect the override directory on disk: it should contain `auth.json` (symlink
   to the host home, or a regular file for API-key/promoted auth), `config.toml`,
   `config.json`, `instructions.md`, and `skills/`. That set is
   `CODEX_SYNC_ALLOWLIST` (codex-home.ts:26-30). An empty or partial directory means
   seeding never ran against it.
5. Rebuild before believing any negative result: `dist/` is gitignored and the
   server runs compiled JS.

## 7. Definition of done

- [ ] Resolve the section 5.6 design fork (option (a) or (b)) and write the answer down.
- [ ] Test lanes (5.1, 5.2) report on the same home the run uses.
- [ ] Per-agent key isolation (5.3) no longer silently defeats the override.
- [ ] Startup reconciliation (5.4) and device-login promotion (5.5) target the effective home.
- [ ] One log line naming the effective home and its provenance (`CODEX_HOME` / `PAPERCLIP_CODEX_HOME` / default) on every run (5.7).
- [ ] An end-to-end run on a relocated home: agent starts, has credentials, skills are injected, work completes.
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
   current implementation is per-run env, so it can be either — but the default
   managed path is company-scoped, and the override erases that scoping unless the
   value itself encodes it.
