# Create agent from a login vault

**Status:** Implemented on `W4-20260827d`; not committed at time of writing —
review the working tree before trusting this doc.
**Owner:** cwa@youritdept.com
**Created:** 2026-08-28
**Companion to:** [`Claude device login web service.md`](CustomCodeDoc/Claude%20device%20login%20web%20service.md)
and [`Codex device login web service.md`](CustomCodeDoc/Codex%20device%20login%20web%20service.md).
Those two describe how a credential vault is provisioned. This one describes the
step that came after it and used to be manual.

> One button on each login settings page: **Create agent**. It opens the New
> Agent form with the runtime already selected and the vault's directory already
> written into the environment variable that runtime reads.

---

## 1. The gap this closes

Both vault docs end at the same sentence, and both pages used to say it out loud:

> "Copy this directory's path into an agent's `CLAUDE_CONFIG_DIR`."

That is three manual steps stitched together by the operator's clipboard and
memory — go to Agents, pick the matching runtime out of a dropdown, scroll to
Environment variables, add a row, type the exact variable name, paste the path.
Every one of them is a place to get it wrong, and getting the variable name
wrong fails at run time with an authentication error rather than at save time
with a validation message.

The pages already knew all three facts. They just had no way to say them.

| The operator had to know | The page already knew |
|---|---|
| Which runtime a Claude login is for | It is the Claude page: `claude_local` |
| Which variable that runtime reads | `CLAUDE_CONFIG_DIR` (`CODEX_HOME` on the Codex page) |
| The directory's full path | `vault.dir`, already rendered in the row |

So the button carries those three across, and the operator supplies the one
thing only they know: the agent's name.

---

## 2. What it does not do

**It does not create an agent.** It navigates. The agent is created by the New
Agent page in the ordinary way, with the ordinary review, ordinary trust preset,
and ordinary Create button. Nothing on the settings page writes anything.

That is deliberate. A one-click "make me an agent" would have to invent a name, a
role, a reporting line, and a trust level on the operator's behalf, and would
create a live agent from a settings page whose job is credentials. Prefilling a
form is the whole of the useful part; deciding who the agent is, is not
mechanical.

**It does not prefill the name or title.** The name field keeps its autofocus, so
the cursor lands on the one field the preset cannot fill.

---

## 3. The mechanism

### 3.1 The preset lives in the query string

The New Agent page already accepted `?adapterType=<type>` — the new-agent dialog
has used it for a while to preselect a runtime before the form opens. This widens
that into a small named contract rather than inventing a second one:

```
/agents/new?adapterType=claude_local&env=CLAUDE_CONFIG_DIR%3D%2Fsysops%2Fllm%2Fclaude%2Fclaude_device
```

- `adapterType` — unchanged, one value, the runtime to preselect.
- `env` — **repeats**, once per variable, each `NAME=value`. Only the first `=`
  splits, so a value may contain `=`.

Router state was the alternative and was rejected: a query string survives a
reload, can be pasted into a bug report, and is visible to the operator, which
matters for the next point.

### 3.2 The query string is treated as untrusted

A URL is operator-visible and hand-editable, so everything it carries is a
*draft* that must survive a human reading it. `parseNewAgentEnvPreset` therefore
enforces, in `ui/src/lib/new-agent-preset.ts`:

| Rule | Why |
|---|---|
| Name matches `^[A-Za-z_][A-Za-z0-9_]*$` | What an adapter `env` map can actually hold |
| Name may not start with `PAPERCLIP_` | The runtime injects those; a link must not claim to set one |
| Value ≤ 1024 characters | A path or an id, not a payload |
| At most 10 variables | A crafted link cannot flood the form |
| **Plain text only** — never a secret reference | A secret belongs in a company secret, bound in the form, not in a URL |

Invalid entries are **dropped, not rejected**: one bad pair still leaves the
operator on a usable form rather than on an error page. And every surviving entry
is rendered as an editable row in the Environment variables field before anything
is created — the operator confirms the preset by pressing Create, exactly as if
they had typed it.

### 3.3 Where the preset is applied

`applyNewAgentPreset` in `NewAgent.tsx` composes with the adapter defaults rather
than replacing them: `createValuesForAdapterType` runs first (so `codex_local`
still gets its sandbox default, `gemini_local` still gets its model, and so on),
and the prefilled variables merge on top. A preset never has to restate a default.

It is applied in the `useState` **initializer**, not in an effect. The
environment-variables editor snapshots its rows on mount and only adopts later
external changes while the local draft is clean; seeding through an effect would
have worked today and broken quietly the first time that heuristic changed.
The existing effect is kept for the case where the query string changes while the
page is already mounted.

---

## 4. Where the button appears

Two places on each of the two pages, from one shared component:

1. **Every vault row**, next to Sign in / Sign out / Delete. It is offered whether
   or not the credential is in place — wiring an agent to a directory that is
   about to be signed into is a normal order of work, and the agent only needs
   the path.
2. **The post-login success panel**, labelled "Create an agent with this login".
   This is where the operator actually is at the moment the thought occurs. The
   panel needs `vault.dir`, which the login session does not carry, so it looks
   the vault up in the list by name; in the brief window before the list refetches
   the button is simply absent and the row button below still works.

Both success panels' copy changed from "Copy this directory's path into an
agent's `X`" to "Create an agent on this login, or copy the directory's path into
an existing agent's `X`" — the old instruction is still true and still needed for
an agent that already exists.

---

## 5. Files

| File | Change |
|---|---|
| `ui/src/lib/new-agent-preset.ts` | **New.** Build and parse the preset query string; all validation lives here |
| `ui/src/lib/new-agent-preset.test.ts` | **New.** 13 tests: round trip, splitting, and every rejection rule |
| `ui/src/components/CreateAgentFromLoginButton.tsx` | **New.** The shared button. Navigates only |
| `ui/src/pages/NewAgent.tsx` | Reads the `env` preset; `applyNewAgentPreset` seeds state in the initializer, **gated on adapter availability since 2026-09-01 — see §8** |
| `ui/src/pages/NewAgent.test.tsx` | Mock priming extracted to `primeApiMocks()`; router mock now driven by `routerSearch`; 2 preset tests added |
| `ui/src/pages/InstanceClaudeVaults.tsx` | Button in the row and in the success panel; `LoginPanel` takes `vaultDir` |
| `ui/src/pages/InstanceCodexVaults.tsx` | Same, for `CODEX_HOME` |

No server change. No API change. No database change. Nothing was added to the
adapter registry — `claude_local` and `codex_local` are named as constants on the
page that already exists for each.

---

## 6. Test results

```
ui/src/lib/new-agent-preset.test.ts   13 passed
ui/src/pages/NewAgent.test.tsx         5 passed   (3 pre-existing + 2 new)
ui/ tsc -b                             clean
```

The two page tests are the ones that matter, because they run the **real** adapter
registry. The preset therefore has to survive the whole path — query string →
create values → the real `buildCodexLocalConfig` → the `adapterConfig.env` map in
the hire request — and the test asserts on the request payload, not on component
state:

```ts
expect(payload.adapterType).toBe("codex_local");
expect(env.CODEX_HOME).toEqual({ type: "plain", value: "/sysops/llm/codex/codex_device" });
```

The second test points a crafted `PAPERCLIP_API_URL` preset at the page and
asserts it never reaches the form.

---

## 7. Still open

- **Neither vault page has a UI test.** That was already true (see §10 of the
  Claude vault doc) and is still true: the button is covered from the New Agent
  side, not from the settings side.
- **Not exercised against a real account.** Same caveat the vault docs carry. The
  wiring is verified; a real signed-in Claude or Codex agent created this way has
  not been run.
- **The preset cannot bind a secret.** Deliberate, per §3.2. If a future caller
  needs to prefill a secret reference, it needs a different channel than a URL —
  do not widen this one.
- **No warning when several agents share a directory.** Creating a second agent on
  the same vault is legitimate and common, and the vault list already shows the
  bound-agent count; the button says nothing about it. The shared-directory
  caveats in the vault docs (shared `settings.json`, shared Claude project state)
  still apply and are still only documented, not enforced.
- **The name is still typed by hand.** By design (§2), but if a naming convention
  emerges — `claude_device` → an agent called something predictable — that is the
  obvious next thing to prefill.

---

## 8. The availability gate — why this preset diverges from upstream

**Added 2026-09-01 (Session 15)**, on the upstream merge that brought
`1955b0e2d` *"Gate Paperclip Runner setup behind an experimental flag"*.

This is the first time an upstream change and this feature disagreed about the
**same behaviour** rather than merely landing near each other in a file. It is
written up at length because "why can't the fork just match upstream here?" is
the obvious question, and the answer is not obvious.

### 8.1 The two designs

Both sides turn `?adapterType=…` into form state. They do it at different
moments, and each is right for its own reasons:

| | Upstream | This fork |
| --- | --- | --- |
| Where the preset is applied | in a `useEffect`, after mount | in the `useState` **initializer**, during mount |
| Why there | the effect can wait for the adapter registry to arrive | the environment-variables editor snapshots its rows on mount (§3.3) |
| What it gated on | `adapterRegistryLoaded` + `disabledTypes` | `isValidAdapterType` only |

The fork put the work in the initializer **deliberately** — §3.3 records that
seeding through an effect works today but leans on the env-var editor's "adopt
external changes while the local draft is clean" heuristic staying as it is.
That reasoning is still sound, and it is precisely why the fork could not simply
adopt upstream's effect-only approach and delete its own.

### 8.2 What broke

`1955b0e2d` added the availability gate to the effect, and two tests with it.
The fork's initializer runs **before** that effect and never consulted the gate,
so a URL naming a disabled experimental runtime populated the form on mount.
Upstream's own new test caught it:

```
AssertionError: expected 'New Agent…Adapter typePaperclip Runner…'
not to contain 'Paperclip Runner'
 ❯ src/pages/NewAgent.test.tsx  "ignores a native-runner URL preset
   while the experimental adapter is disabled"
```

**This was not a merge artefact.** That region of both files merged cleanly.
Two independently correct designs met and disagreed — the case §5.3 of
[`Review and Test Changes.md`](CustomCodeDoc/Review%20and%20Test%20Changes.md)
says to stop and raise rather than resolve unilaterally. It was raised, and the
operator chose to honour upstream's gate.

### 8.3 The resolution

The initializer now reads the gate too, which requires the two registry hooks to
be called **above** the create-values state:

```tsx
const disabledTypes = useDisabledAdaptersSync();
const adapterRegistryLoaded = useAdapterRegistryLoaded();

const [configValues, setConfigValues] = useState<CreateConfigValues>(() =>
  presetAdapterType && (!adapterRegistryLoaded || disabledTypes.has(presetAdapterType))
    ? defaultCreateValues
    : applyNewAgentPreset(presetAdapterType, presetEnvBindings),
);
```

**The cold-cache cost, stated honestly.** `useAdapterRegistryLoaded` is backed by
a react-query fetch of `adaptersApi.list()` with a five-minute `staleTime`. On a
cold load `adapters` is `undefined`, so the initializer **declines to seed** and
the preset arrives through the guarded effect instead — the very path §3.3
preferred to avoid. On a warm cache, which is the normal flow (the operator
clicks **Create agent** on a vault settings page that has already rendered
adapter menus), the initializer still seeds synchronously as designed.

That trade was made knowingly. Admitting a runtime the deployer has disabled is
a worse failure than seeding through a path that is fragile-but-working, and
declining to seed leaves the adapter defaults alone — the behaviour that existed
before this feature. The direction of harm matches the reasoning upstream itself
wrote into `useAdapterRegistryLoaded`: *"Silently changing a saved answer is the
error worth refusing to make."*

### 8.4 What to check after the next merge

`ui/src/pages/NewAgent.tsx` is now a §4.1 collision point. Two things can undo
this, and they fail very differently:

1. **The hook order.** If `useDisabledAdaptersSync` / `useAdapterRegistryLoaded`
   drift back below the `useState`, the initializer references them before they
   are declared. That is a **type error** — it fails loudly, so it is safe.
2. **The gate expression itself.** If an upstream refactor rewrites the
   initializer without the gate, nothing fails to compile and nothing crashes.
   Only upstream's own test goes red:
   `"ignores a native-runner URL preset while the experimental adapter is disabled"`.
   **That test is the canary. Do not delete it as "upstream's test" —** the fork
   now depends on it to protect a fork-specific interaction.

Verify with:

```bash
corepack pnpm exec vitest run ui/src/pages/NewAgent.test.tsx \
  ui/src/lib/new-agent-preset.test.ts ui/src/pages/InviteLanding.test.tsx
```

39 passing across the three files; `NewAgent.test.tsx` contributes 7 — the
fork's 2 preset tests and upstream's 2 gate tests among them.
