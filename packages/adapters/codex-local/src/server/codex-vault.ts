import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";

// The named Codex home store.
//
// Each entry is one operator-named directory holding one Codex account:
//
//   /sysops/llm/codex/<name>/
//   ├── auth.json     the credential (0600)
//   └── config.toml   provider / trust configuration
//
// Paperclip provisions the directory and runs a device login into it. An agent
// then uses it by setting `CODEX_HOME` to the full path in its adapter config.
//
// That is the whole mechanism. `CODEX_HOME` is an existing, self-managed
// override: Paperclip resolves it on both the CLI and ACP engines, performs no
// seeding, and its credential-readiness gate treats it as ready without
// inspection. Nothing here participates in run-time resolution.
//
// Several agents may share one directory. They then share one `auth.json` —
// the same file, not copies — so the single-use refresh-token rotation Codex
// performs is visible to all of them immediately. They also share the rest of
// the directory (sqlite state, `sessions/`, and the `skills/` Paperclip injects
// at run time); give each agent its own directory when that matters.
//
// Security: a directory holds a full account credential. Every path is derived
// by joining a validated name onto a fixed root, so a caller-supplied name can
// never traverse out. Directories are 0700 and credentials 0600.

/**
 * The fixed default root for named vaults. `PAPERCLIP_CODEX_VAULT_ROOT`
 * overrides it (tests and non-standard hosts); it is never taken from a request.
 */
export const DEFAULT_CODEX_VAULT_ROOT = "/sysops/llm/codex";

/** The environment key that relocates the vault root. */
export const CODEX_VAULT_ROOT_ENV_KEY = "PAPERCLIP_CODEX_VAULT_ROOT";

/** A private directory (owner rwx only), matching the managed-home mode. */
const VAULT_DIR_MODE = 0o700;
/** A private file (owner rw only), matching the promoted-credential mode. */
const VAULT_FILE_MODE = 0o600;

/** The bounded credential size. A real auth.json is a few kilobytes. */
export const MAX_VAULT_AUTH_BYTES = 64 * 1024;

/** The fixed, non-secret error an unusable credential returns. */
export const CODEX_VAULT_CREDENTIAL_REJECTED = "CODEX_VAULT_CREDENTIAL_REJECTED";

const AUTH_FILE_NAME = "auth.json";
const CONFIG_FILE_NAME = "config.toml";

/**
 * The exact shape of a vault name. Lowercase alphanumerics, underscore, and
 * hyphen, starting alphanumeric, 2-40 characters. The anchors reject an absolute
 * path, a traversal, a separator, whitespace, a control character, and a shell
 * metacharacter, because none of those match the class.
 */
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/** The fixed, non-secret error an invalid vault name returns. */
export const CODEX_VAULT_NAME_INVALID = "CODEX_VAULT_INVALID_NAME";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Reports whether a value is a well-formed vault name. */
export function isValidVaultName(name: unknown): name is string {
  return typeof name === "string" && VAULT_NAME_RE.test(name);
}

/**
 * Throws the fixed non-secret error for a malformed vault name. The message
 * carries no candidate bytes, so a hostile name never reaches a log through it.
 */
export function assertValidVaultName(name: unknown): asserts name is string {
  if (!isValidVaultName(name)) throw new Error(CODEX_VAULT_NAME_INVALID);
}

/** Resolves the vault root for the environment. */
export function resolveVaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(nonEmpty(env[CODEX_VAULT_ROOT_ENV_KEY]) ?? DEFAULT_CODEX_VAULT_ROOT);
}

/**
 * Resolves the absolute directory for a named vault. The name is validated, then
 * joined onto the root, then the result is re-checked to be a direct child of
 * the root. The second check is belt-and-braces: the name pattern already
 * excludes every separator, so no accepted name can escape.
 */
export function resolveVaultDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  assertValidVaultName(name);
  const root = resolveVaultRoot(env);
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== root || dir === root) {
    throw new Error(CODEX_VAULT_NAME_INVALID);
  }
  return dir;
}

/** The absolute credential path inside a named vault. */
export function resolveVaultAuthPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveVaultDir(name, env), AUTH_FILE_NAME);
}

/** The absolute config path inside a named vault. */
export function resolveVaultConfigPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveVaultDir(name, env), CONFIG_FILE_NAME);
}

const DEFAULT_CONFIG_TOML = `# Paperclip-provisioned Codex home.
# Point an agent here by setting CODEX_HOME to this directory.
# Add model providers, trusted projects, and MCP servers below.
`;

/**
 * Creates the vault directory if absent and tightens it to 0700. `mkdir` honours
 * its mode only when it creates the directory, so an existing loose directory is
 * tightened explicitly. Seeds `config.toml` when absent; never touches an
 * existing one, and never touches `auth.json`.
 */
export async function ensureVaultDir(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = resolveVaultDir(name, env);
  await fs.mkdir(dir, { recursive: true, mode: VAULT_DIR_MODE });
  await fs.chmod(dir, VAULT_DIR_MODE);
  try {
    await fs.writeFile(path.join(dir, CONFIG_FILE_NAME), DEFAULT_CONFIG_TOML, {
      flag: "wx",
      mode: VAULT_FILE_MODE,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return dir;
}

/** The non-secret description of one vault. It carries no token bytes. */
export interface CodexVaultSummary {
  name: string;
  dir: string;
  /** True when the vault holds a credential Codex would accept. */
  hasCredential: boolean;
  /** "chatgpt" for a device login, "api_key" for a key, null when absent. */
  authMode: string | null;
  /**
   * The trailing segment of the identity, for display and duplicate spotting.
   * Never the whole account id.
   */
  accountSuffix: string | null;
  /** The `last_refresh` stamp Codex writes, when present. */
  lastRefresh: string | null;
}

/**
 * The usable-credential predicate. It mirrors `hasUsableAuthPayload` in
 * codex-home.ts: usable means a non-empty `OPENAI_API_KEY`, or an `account_id`
 * paired with at least one token. Keeping the two in agreement matters — a vault
 * that reports usable here but not there would pass provisioning and then fail
 * every run.
 */
function hasUsableAuthPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const parsed = payload as Record<string, unknown>;
  const apiKey = parsed.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) return true;
  const tokens = parsed.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) return false;
  const parsedTokens = tokens as Record<string, unknown>;
  const accountId = parsedTokens.account_id;
  if (typeof accountId !== "string" || accountId.trim().length === 0) return false;
  return ["id_token", "access_token", "refresh_token"].some((key) => {
    const value = parsedTokens[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Describes one vault without returning any secret. A missing, unreadable, or
 * unusable credential yields `hasCredential: false` rather than an error, so the
 * caller can list a half-provisioned vault instead of failing the whole listing.
 */
export async function readVaultSummary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexVaultSummary> {
  const dir = resolveVaultDir(name, env);
  const empty: CodexVaultSummary = {
    name,
    dir,
    hasCredential: false,
    authMode: null,
    accountSuffix: null,
    lastRefresh: null,
  };
  const raw = await fs.readFile(path.join(dir, AUTH_FILE_NAME), "utf8").catch(() => null);
  if (raw === null) return empty;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!hasUsableAuthPayload(payload)) return empty;
  const parsed = payload as Record<string, unknown>;
  const tokens = (parsed.tokens ?? {}) as Record<string, unknown>;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
  return {
    name,
    dir,
    hasCredential: true,
    authMode: typeof parsed.auth_mode === "string" ? parsed.auth_mode : "api_key",
    accountSuffix: accountId ? accountId.slice(-12) : null,
    lastRefresh: typeof parsed.last_refresh === "string" ? parsed.last_refresh : null,
  };
}

/**
 * Lists every well-formed vault under the root, sorted by name. A missing root
 * lists empty. A directory entry whose name is not a valid vault name is
 * skipped, so unrelated content under the root is ignored rather than surfaced.
 */
export async function listVaults(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexVaultSummary[]> {
  const root = resolveVaultRoot(env);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const names = entries
    .filter((entry) => entry.isDirectory() && isValidVaultName(entry.name))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map((name) => readVaultSummary(name, env)));
}

/**
 * Promotes validated credential bytes into a vault, atomically.
 *
 * The write is a private-temp-then-rename under the vault's directory lock, so a
 * reader either sees the whole old credential or the whole new one — never a
 * half-written file. That matters because agents follow symlinks onto this exact
 * path while they run.
 *
 * The replace is unconditional, unlike the background seed path which keeps a
 * newer destination. An operator running a device login has explicitly asked to
 * re-authenticate this identity, and the credential they just produced is the
 * one they want; silently keeping an older file would make a deliberate re-login
 * look like it succeeded while changing nothing.
 *
 * The caller must validate the bytes before calling. This function checks only
 * that they parse and are usable, as a last line of defence.
 */
export async function promoteVaultCredential(
  name: string,
  authBytes: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (authBytes.length === 0 || authBytes.length > MAX_VAULT_AUTH_BYTES) {
    throw new Error(CODEX_VAULT_CREDENTIAL_REJECTED);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(authBytes.toString("utf8"));
  } catch {
    throw new Error(CODEX_VAULT_CREDENTIAL_REJECTED);
  }
  if (!hasUsableAuthPayload(payload)) throw new Error(CODEX_VAULT_CREDENTIAL_REJECTED);

  const dir = await ensureVaultDir(name, env);
  const destination = path.join(dir, AUTH_FILE_NAME);
  return withDirectoryMergeLock(dir, async () => {
    const temp = path.join(dir, `.auth-${process.pid}-${randomUUID()}.tmp`);
    // `wx` plus an explicit mode creates the temp private and fails if the path
    // already exists, so the writer never writes through a pre-existing symlink.
    const handle = await fs.open(temp, "wx", VAULT_FILE_MODE);
    try {
      await handle.writeFile(authBytes);
      await handle.close();
      await fs.rename(temp, destination);
      return destination;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  });
}
