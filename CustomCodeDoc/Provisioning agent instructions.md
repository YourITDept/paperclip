# Provisioning — agent instructions in the `agent.create` payload

**Added:** 2026-09-11
**Status:** `AWAITING REVIEW` — uncommitted on `W8-20260909e` @ `ec65a3a4e`
**Part of:** change set 11, the Outseta provisioning worker
([`Outseta provisioning worker.md`](CustomCodeDoc/Outseta%20provisioning%20worker.md))
**Code:** [`server/src/provisioning/handlers.ts`](server/src/provisioning/handlers.ts) —
`readInstructions`, `combineInstructions`, `seedDefaultInstructions`, `agentCreate`
**Tests:** [`server/src/__tests__/provisioning-agent-instructions.test.ts`](server/src/__tests__/provisioning-agent-instructions.test.ts)

---

## 1. What it does

An `agent.create` job can now carry the agent's instructions: the markdown files
the agent reads before it does anything (its role, rules and context). Before
this, every provisioned agent got the same built-in default and nothing else.

**Without `instructions`, nothing changes.** The agent gets the built-in default
bundle, through the same code, with the same log line, as before this field
existed. The three original tests for that path pass unmodified.

## 2. For the provisioning side — the payload contract

Add an optional `instructions` field to the `agent.create` payload. Everything
else in the payload is unchanged.

### 2.1 The three forms

**a) Leave it out** — the default bundle, as today.

```json
{
  "job_type": "agent.create",
  "payload": {
    "name": "OpenRouter Codex Agent",
    "companyPrefix": "PERS",
    "adapterType": "codex_local",
    "model": "openai/gpt-5.6-luna"
  }
}
```

**b) A string** — shorthand for "append this text to `AGENTS.md`".

```json
{
  "job_type": "agent.create",
  "payload": {
    "name": "OpenRouter Codex Agent",
    "companyPrefix": "PERS",
    "adapterType": "codex_local",
    "instructions": "## Your role\nYou keep the books for Personal. Ask before spending money.\n"
  }
}
```

**c) An object** — one or more files, appended (default) or replacing.

```json
{
  "job_type": "agent.create",
  "payload": {
    "name": "OpenRouter Codex Agent",
    "companyPrefix": "PERS",
    "adapterType": "codex_local",
    "instructions": {
      "mode": "append",
      "files": {
        "AGENTS.md": "## Your role\nYou keep the books for Personal.\n",
        "SOUL.md": "Be concise. Ask before spending money.\n"
      }
    }
  }
}
```

```json
{
  "job_type": "agent.create",
  "payload": {
    "name": "Research Agent",
    "companyPrefix": "PROJ",
    "adapterType": "claude_local",
    "instructions": {
      "mode": "replace",
      "entryFile": "instructions.md",
      "files": {
        "instructions.md": "# Research Agent\nEverything this agent needs to know.\n"
      }
    }
  }
}
```

### 2.2 Fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `instructions` | string or object | absent | Absent: default bundle. String: append to `AGENTS.md`. |
| `instructions.mode` | `"append"` or `"replace"` | `"append"` | How `files` combine with the default bundle. |
| `instructions.files` | object: `{ "<relative path>": "<markdown>" }` | — (required, at least one) | The files to write. Content is written exactly as sent, never trimmed. |
| `instructions.entryFile` | relative path | `"AGENTS.md"` | The file the agent reads first. **May only change with `mode: "replace"`**, and must be one of `files`. |

### 2.3 `append` versus `replace`

**`append` (the default) keeps the built-in instructions and adds yours.** For
each file you send:

- if the default bundle has a file of the same name, your text is added **after**
  it, separated by a blank line;
- otherwise the file is added as-is.

The entry file stays `AGENTS.md`.

**Use `append` unless you have a reason not to.** Provisioned agents get the
`default` bundle: one `AGENTS.md` whose content is the **Execution Contract**,
the rules for finishing work, reporting a result and handling work product.
Replacing it removes those rules from the agent. That is the same gap the
2026-09-09 fix closed, when provisioned agents were created with no instructions.

**`replace` uses only your files.** Nothing from the default bundle is written.
You must include the entry file, and it must not be empty.

### 2.4 Rules for file paths

A path must be **relative, inside the agent's instructions folder**:

| Accepted | Refused |
| --- | --- |
| `AGENTS.md`, `SOUL.md`, `docs/policies.md` | `../escape.md`, `/etc/passwd`, `~/x.md`, `C:\x.md`, `a//b.md`, `./a.md`, `""` |

Backslashes are treated as `/`. The same file given twice under two spellings is
refused.

### 2.5 When `instructions` is refused

A malformed `instructions` fails the job **permanently**. The job ends with
status `failed` and is not retried, because a retry would read the same payload.
**The agent is not created.** Every check runs before the create.

| `error_code` | When |
| --- | --- |
| `invalid_instructions` | empty string; not a string or object; unknown `mode`; `files` missing, empty or not an object; a refused path; non-string file content; a path given twice; `entryFile` changed with `append`; `replace` without a non-empty entry file |
| `instructions_not_supported` | the `adapterType` takes no instruction files (see below) |

`error_message` names the exact problem, for example
`instructions file "../escape.md" must be a relative path inside the bundle`.

Which adapters take instruction files, per `supportsInstructionsBundle` in
[`server/src/adapters/registry.ts`](server/src/adapters/registry.ts) (2026-09-11):

| Takes instructions | Refuses `instructions` |
| --- | --- |
| `claude_local`, `codex_local`, `cursor`, `cursor_cloud`, `gemini_local`, `grok_local`, `kimi_local`, `opencode_local`, `pi_local`, `paperclip_runner` | `acpx_local`, `openclaw_gateway`, `hermes_gateway`, `http`, `process` |

This instance currently enables only `claude_local` and `codex_local`
(`PAPERCLIP_ADAPTERS`), and both take instructions.

### 2.6 An agent that already exists

**Instructions are written on create only.** `agent.create` matches an existing
agent by name within the company. When one exists, the job updates its
environment and model as it always has, and **does not touch its instructions**.
Otherwise a later queue row could overwrite instructions someone edited by hand.
The server logs:

```
provisioning: agent already exists; payload instructions apply on create only and were not written
```

The job still succeeds. To change an existing agent's instructions, use the
agent's Instructions page or the agent instructions API.

A malformed `instructions` still fails the job for an existing agent: validation
runs before the create-or-update decision, so a bad payload fails the same way
on either path.

### 2.7 Practical notes for whoever builds the payload

- **No secrets in instructions.** Job payloads are kept after processing as an
  audit trail, so the text stays in `provisioning.provisioning_jobs.payload`.
- **Escape newlines as JSON `\n`.** Content is written byte for byte, so trailing
  newlines are yours to include.
- **Ordering does not matter for instructions.** They travel inside the
  `agent.create` row itself, so there is nothing to sequence.
- **Idempotency:** a replayed `agent.create` for the same name does not rewrite
  instructions (§2.6), so changing the instruction text alone does not update an
  agent that was already provisioned.

## 3. Log lines

| When | Message |
| --- | --- |
| No `instructions` (unchanged) | `provisioning: seeded default agent instructions` |
| `instructions` applied | `provisioning: seeded agent instructions from the payload` (with `mode`, `entryFile`, `files`) |
| Agent already existed | `provisioning: agent already exists; payload instructions apply on create only and were not written` |
| Writing the files failed | `provisioning: failed to seed default agent instructions; agent has an EMPTY bundle` |

The last one is the existing never-fatal path. The agent exists by the time files
are written, and failing the job there would retry into the update path, which
never writes instructions.

## 4. For the fork — what changed and how to check it

**Files:**

- `server/src/provisioning/handlers.ts`
  - `readInstructions` / `readInstructionsPath`: parse and validate the field.
  - `combineInstructions`: the append/replace rule.
  - `seedDefaultInstructions` takes an optional second argument. Without it, the
    behaviour is the previous one.
  - `agentCreate`: validates before the create-or-update decision, refuses
    unsupported adapters before creating, logs the ignored case, and passes the
    instructions through.
- `server/src/__tests__/provisioning-agent-instructions.test.ts`: 14 new tests.

**Why the path check is duplicated.** `agent-instructions.ts` has its own check
(`normalizeRelativeFilePath`), but it runs while the files are written, **after**
the agent exists. A failure there leaves an agent with an empty bundle. The copy
in `handlers.ts` is deliberately stricter and runs first.

**Verified 2026-09-11:**

| Check | Result |
| --- | --- |
| `provisioning-agent-instructions.test.ts` | 17/17 (3 original, unmodified + 14 new) |
| All provisioning suites (codex-home, instructions, skills, task, membership-remove) | 48/48 |
| Server `tsc --noEmit` | clean |
| `verify-fork.sh` "cs11 provisioning" baseline | raised 30 → 44 |

**Not `LIVE-VERIFIED`.** No `agent.create` carrying `instructions` has been
applied on a running instance yet.

**What an upstream merge could break:** `materializeManagedBundle`'s signature
(`files`, `entryFile`, `replaceExisting`), and `loadDefaultAgentInstructionsBundle` /
`resolveDefaultAgentInstructionsBundleRole`. All three are already on the
change-set-11 dependency list in the worker document. The suite above goes red
if they change shape.
