import type { EnvBinding } from "@paperclipai/shared";

// A preset for the New Agent page, carried in its query string.
//
// The page already accepted `?adapterType=<type>` so the new-agent dialog could
// pick the runtime before the form opened. This module widens that into a small
// shared contract — adapter type plus prefilled environment variables — so any
// page that already knows how an agent should be wired can hand the form a
// half-filled draft instead of asking the operator to retype it.
//
// The first caller is the Claude/Codex login settings page: it knows the vault's
// directory, and it knows which variable the matching runtime reads
// (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), so it can send both.
//
// Shape: `?adapterType=claude_local&env=CLAUDE_CONFIG_DIR%3D%2Fsysops%2Fllm%2F…`
// `env` repeats, once per variable, each `NAME=value`. Only the first `=` splits,
// so a value may contain `=`.
//
// A query string is operator-visible and survives a reload, so it is treated as
// untrusted input: everything it carries is a *draft* the operator reads in the
// form and confirms by pressing Create. The validation below keeps a hand-edited
// or pasted link from seeding junk — it never stands in for the form's own
// validation, and it deliberately never accepts a secret reference, only plain
// text. Anything secret belongs in a company secret, bound in the form.

export const NEW_AGENT_ADAPTER_TYPE_PARAM = "adapterType";
export const NEW_AGENT_ENV_PARAM = "env";

/** POSIX-shell variable naming, which is what every adapter's `env` map expects. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Injected by the runtime; a preset must never claim to set one. */
const RESERVED_ENV_PREFIX = "PAPERCLIP_";
/** Enough for any real preset, small enough that a crafted link cannot flood the form. */
const MAX_ENV_ENTRIES = 10;
/** A path or an id, not a payload. */
const MAX_ENV_VALUE_LENGTH = 1024;

export interface NewAgentPreset {
  /** Adapter/runtime to preselect, e.g. `claude_local`. */
  adapterType?: string;
  /** Plain environment variables to prefill, keyed by variable name. */
  env?: Record<string, string>;
}

/**
 * Build the New Agent path for a preset. The result is company-relative; pass it
 * to `useNavigate` from `@/lib/router`, which applies the active company prefix.
 */
export function buildNewAgentPresetPath(preset: NewAgentPreset): string {
  const params = new URLSearchParams();
  if (preset.adapterType) {
    params.set(NEW_AGENT_ADAPTER_TYPE_PARAM, preset.adapterType);
  }
  for (const [name, value] of Object.entries(preset.env ?? {})) {
    params.append(NEW_AGENT_ENV_PARAM, `${name}=${value}`);
  }
  const search = params.toString();
  return search ? `/agents/new?${search}` : "/agents/new";
}

/**
 * Read the prefilled environment variables out of a New Agent query string.
 *
 * Invalid entries are dropped rather than rejected: a preset is a convenience,
 * and one bad pair should still leave the operator on a usable form. Returns an
 * empty object when there is nothing to prefill.
 */
export function parseNewAgentEnvPreset(params: URLSearchParams): Record<string, EnvBinding> {
  const bindings: Record<string, EnvBinding> = {};
  for (const entry of params.getAll(NEW_AGENT_ENV_PARAM)) {
    if (Object.keys(bindings).length >= MAX_ENV_ENTRIES) break;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1);
    if (!ENV_NAME_RE.test(name)) continue;
    if (name.startsWith(RESERVED_ENV_PREFIX)) continue;
    if (value.length > MAX_ENV_VALUE_LENGTH) continue;
    bindings[name] = { type: "plain", value };
  }
  return bindings;
}
