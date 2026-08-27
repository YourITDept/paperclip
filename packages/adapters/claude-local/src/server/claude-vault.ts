import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { readClaudeTokenFromDir } from "./quota.js";

// The named Claude config store.
//
// Each entry is one operator-named directory holding one Claude account:
//
//   /sysops/llm/claude/<name>/
//   ├── .credentials.json   the credential (0600)
//   └── settings.json       optional per-account settings
//
// Paperclip provisions the directory and runs `claude setup-token` into it. An
// agent then uses it by setting `CLAUDE_CONFIG_DIR` to the full path.
//
// This is the Claude counterpart of the Codex vault (`codex-vault.ts`), and the
// operator-facing model is identical: provision a named directory, sign in, point
// agents at the path. The mechanics underneath are not identical, and the
// difference is worth stating because it drives everything else here.
//
// **Codex** device login writes an `auth.json` into the home itself; Paperclip
// copies that file into the vault.
//
// **Claude** `setup-token` writes nothing. It mints a long-lived OAuth token
// (`oat01…`, valid for a year) and prints it once on the terminal — the captured
// characterization in `__fixtures__/setup-token-success.md` is explicit that no
// `~/.claude/.credentials.json` is written and the token cannot be shown again.
// So Paperclip captures the token from the login stream and writes the
// credential file itself, in the shape Claude Code reads.
//
// That shape was verified against the real CLI (2.1.231) rather than assumed. A
// login-written credential holds a short-lived `sk-ant` access token with a
// refresh token, an expiry, and scopes. A setup-token is a different credential:
// a bearer that does not refresh. Writing one into the other's slot only works if
// Claude treats it as a bearer, so it was tested: a `.credentials.json` carrying
// only `claudeAiOauth.accessToken` + `expiresAt`, and the same token supplied via
// `CLAUDE_CODE_OAUTH_TOKEN`, produce the *identical* CLI error path. Claude reads
// the file and sends the token as a bearer exactly as it does the environment
// variable. Deliberately, therefore, this module writes **no `refreshToken`** —
// a setup-token has nothing to refresh with, and a fake one would send Claude
// down its refresh path and fail with a misleading "session expired".
//
// Security: a directory holds a full account credential. Every path is derived by
// joining a validated name onto a fixed root, so a caller-supplied name can never
// traverse out. Directories are 0700 and credentials 0600.

/**
 * The fixed default root for named Claude vaults. `PAPERCLIP_CLAUDE_VAULT_ROOT`
 * overrides it (tests and non-standard hosts); it is never taken from a request.
 */
export const DEFAULT_CLAUDE_VAULT_ROOT = "/sysops/llm/claude";

/** The environment key that relocates the vault root. */
export const CLAUDE_VAULT_ROOT_ENV_KEY = "PAPERCLIP_CLAUDE_VAULT_ROOT";

/** A private directory (owner rwx only). */
const VAULT_DIR_MODE = 0o700;
/** A private file (owner rw only). */
const VAULT_FILE_MODE = 0o600;

/** The bounded credential size. A real credentials file is well under a kilobyte. */
export const MAX_VAULT_CREDENTIAL_BYTES = 64 * 1024;

/** The fixed, non-secret error an unusable credential returns. */
export const CLAUDE_VAULT_CREDENTIAL_REJECTED = "CLAUDE_VAULT_CREDENTIAL_REJECTED";

/** The fixed, non-secret error an invalid name returns. */
export const CLAUDE_VAULT_NAME_INVALID = "CLAUDE_VAULT_INVALID_NAME";

const CREDENTIALS_FILE_NAME = ".credentials.json";
const SETTINGS_FILE_NAME = "settings.json";

/**
 * A setup-token is valid for one year. The credential file carries an absolute
 * expiry because Claude reads one; this is the horizon Paperclip stamps when it
 * writes the token, matching what the login screen states.
 */
export const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The exact shape of a vault name. Identical to the Codex vault rule on purpose —
 * the two stores sit side by side under `/sysops/llm`, and an operator should not
 * have to remember two naming rules. Lowercase alphanumerics, underscore, and
 * hyphen, starting alphanumeric, 2-40 characters. The anchors reject an absolute
 * path, a traversal, a separator, whitespace, a control character, and a shell
 * metacharacter, because none of those match the class.
 */
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export function isValidVaultName(name: unknown): name is string {
  return typeof name === "string" && VAULT_NAME_RE.test(name);
}

export function assertValidVaultName(name: unknown): asserts name is string {
  if (!isValidVaultName(name)) throw new Error(CLAUDE_VAULT_NAME_INVALID);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveVaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(nonEmpty(env[CLAUDE_VAULT_ROOT_ENV_KEY]) ?? DEFAULT_CLAUDE_VAULT_ROOT);
}

/**
 * Resolves the absolute directory for a named vault. The name is validated, then
 * joined onto the root, then the result is re-checked to be a direct child of the
 * root. The second check is belt-and-braces: the name pattern already excludes
 * every separator, so no accepted name can escape.
 */
export function resolveVaultDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  assertValidVaultName(name);
  const root = resolveVaultRoot(env);
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== root || dir === root) {
    throw new Error(CLAUDE_VAULT_NAME_INVALID);
  }
  return dir;
}

/** The absolute credential path inside a named vault. */
export function resolveVaultCredentialPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveVaultDir(name, env), CREDENTIALS_FILE_NAME);
}

/** The absolute settings path inside a named vault. */
export function resolveVaultSettingsPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveVaultDir(name, env), SETTINGS_FILE_NAME);
}

/**
 * Seeded on creation. Claude reads `settings.json` out of `CLAUDE_CONFIG_DIR`;
 * an empty object is a valid file that an operator can edit, and seeding it means
 * a fresh vault is a complete config directory rather than one bare credential.
 */
const DEFAULT_SETTINGS_JSON = `{}\n`;

/**
 * Creates the vault directory if absent and tightens it to 0700. `mkdir` honours
 * its mode only when it creates the directory, so an existing loose directory is
 * tightened explicitly. Seeds `settings.json` when absent; never touches an
 * existing one, and never touches the credential.
 */
export async function ensureVaultDir(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = resolveVaultDir(name, env);
  await fs.mkdir(dir, { recursive: true, mode: VAULT_DIR_MODE });
  await fs.chmod(dir, VAULT_DIR_MODE);
  try {
    await fs.writeFile(path.join(dir, SETTINGS_FILE_NAME), DEFAULT_SETTINGS_JSON, {
      flag: "wx",
      mode: VAULT_FILE_MODE,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return dir;
}

/** The non-secret description of one vault. It carries no token bytes. */
export interface ClaudeVaultSummary {
  name: string;
  dir: string;
  /** True when the vault holds a credential Claude would send. */
  hasCredential: boolean;
  /** "setup_token" for a Paperclip-minted token, "oauth" for a login-written pair. */
  authMode: string | null;
  /**
   * The trailing characters of the token, for display and duplicate spotting.
   * Never enough to reconstruct the credential.
   */
  tokenSuffix: string | null;
  /** The absolute expiry Claude reads, as an ISO stamp, when present. */
  expiresAt: string | null;
  /** The subscription tier recorded on the credential, when present. */
  subscriptionType: string | null;
}

/**
 * Describes one vault without returning any secret. A missing, unreadable, or
 * unusable credential yields `hasCredential: false` rather than an error, so the
 * caller can list a half-provisioned vault instead of failing the whole listing.
 */
export async function readVaultSummary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeVaultSummary> {
  const dir = resolveVaultDir(name, env);
  const empty: ClaudeVaultSummary = {
    name,
    dir,
    hasCredential: false,
    authMode: null,
    tokenSuffix: null,
    expiresAt: null,
    subscriptionType: null,
  };
  // Ask claude-local what a Claude credential is, rather than re-deriving it.
  // `readClaudeTokenFromDir` is the same reader the quota path uses, so a vault
  // reporting a usable credential and a run finding one can never disagree.
  const token = await readClaudeTokenFromDir(dir);
  if (token === null) return empty;
  // Re-read for the non-secret display fields. The reader above answers "is
  // there a usable token"; the file carries the expiry and tier alongside it.
  const raw = await fs.readFile(path.join(dir, CREDENTIALS_FILE_NAME), "utf8").catch(() => null);
  let oauth: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const block = parsed.claudeAiOauth;
      if (block !== null && typeof block === "object" && !Array.isArray(block)) {
        oauth = block as Record<string, unknown>;
      }
    } catch {
      // A usable token came back above, so a parse failure here only costs the
      // display fields; the vault still reports a credential.
    }
  }
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
  // A refresh token is the tell: a login-written credential has one, a
  // Paperclip-written setup-token deliberately does not.
  const authMode = nonEmpty(oauth.refreshToken) ? "oauth" : "setup_token";
  return {
    name,
    dir,
    hasCredential: true,
    authMode,
    tokenSuffix: token.slice(-8),
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    subscriptionType: nonEmpty(oauth.subscriptionType),
  };
}

/**
 * Lists every well-formed vault under the root, sorted by name. A missing root
 * lists empty. A directory entry whose name is not a valid vault name is skipped,
 * so unrelated content under the root is ignored rather than surfaced.
 */
export async function listVaults(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeVaultSummary[]> {
  const root = resolveVaultRoot(env);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const names = entries
    .filter((entry) => entry.isDirectory() && isValidVaultName(entry.name))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map((name) => readVaultSummary(name, env)));
}

/** The token shape `claude setup-token` mints. Checked before anything is written. */
const SETUP_TOKEN_RE = /^[A-Za-z0-9_-]{20,512}$/;

/**
 * Builds the credential file contents for a minted setup-token.
 *
 * Exported so the shape is testable on its own, and so the one place that decides
 * what Claude will read is not buried inside a write. No `refreshToken` is
 * emitted — see the note at the top of this file.
 */
export function buildSetupTokenCredential(token: string, now = Date.now()): string {
  return `${JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: token,
        expiresAt: now + SETUP_TOKEN_LIFETIME_MS,
        scopes: ["user:inference"],
        subscriptionType: "unknown",
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Promotes a minted setup-token into a vault, atomically.
 *
 * The write is a private-temp-then-rename under the vault's directory lock, so a
 * reader either sees the whole old credential or the whole new one — never a
 * half-written file. That matters because agents read this exact path while they
 * run.
 *
 * The replace is unconditional. An operator running a login has explicitly asked
 * to re-authenticate this identity, and the token they just minted is the one
 * they want.
 */
export async function promoteVaultCredential(
  name: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<string> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!SETUP_TOKEN_RE.test(trimmed)) throw new Error(CLAUDE_VAULT_CREDENTIAL_REJECTED);
  const contents = buildSetupTokenCredential(trimmed, now);
  if (Buffer.byteLength(contents, "utf8") > MAX_VAULT_CREDENTIAL_BYTES) {
    throw new Error(CLAUDE_VAULT_CREDENTIAL_REJECTED);
  }

  const dir = await ensureVaultDir(name, env);
  const destination = path.join(dir, CREDENTIALS_FILE_NAME);
  return withDirectoryMergeLock(dir, async () => {
    const temp = path.join(dir, `.credentials-${process.pid}-${randomUUID()}.tmp`);
    // `wx` plus an explicit mode creates the temp private and fails if the path
    // already exists, so the writer never writes through a pre-existing symlink.
    const handle = await fs.open(temp, "wx", VAULT_FILE_MODE);
    try {
      await handle.writeFile(contents);
      await handle.close();
      await fs.rename(temp, destination);
      return destination;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  });
}

/** True when a vault directory exists. Distinguishes "no vault" from "no credential". */
export async function vaultExists(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const dir = resolveVaultDir(name, env);
  return fs
    .stat(dir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

/**
 * Removes a vault's credential, leaving the directory and its `settings.json` in
 * place. The reversible half of "remove the authorization": the vault keeps its
 * name, path, and settings, so an agent already pointed at it keeps resolving,
 * and a later login re-populates it.
 *
 * Returns `true` when a credential was removed, `false` when there was none.
 */
export async function removeVaultCredential(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const dir = resolveVaultDir(name, env);
  // The lock resolves the directory's realpath, which throws ENOENT when there is
  // no directory. Probe first so a missing vault is an ordinary `false` rather
  // than a crash.
  if (!(await vaultExists(name, env))) return false;
  return withDirectoryMergeLock(dir, async () => {
    try {
      // `unlink`, not `rm`: the credential may be a symlink, and unlink removes
      // the link without following it.
      await fs.unlink(path.join(dir, CREDENTIALS_FILE_NAME));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}

/**
 * Deletes a whole vault directory — credential, settings, Claude project state,
 * and anything else inside it.
 *
 * The irreversible half. `resolveVaultDir` has already proved the path is a
 * direct child of the vault root and that the name matches the strict pattern, so
 * the recursive remove can only ever land inside the root; the explicit re-check
 * below states that invariant at the point where it matters, because this is the
 * one call in the module that destroys data.
 *
 * Callers are responsible for warning about agents bound to this path. Nothing
 * here can know: an agent references a vault by an opaque `CLAUDE_CONFIG_DIR`
 * string in its adapter config, which this package cannot read.
 */
export async function deleteVault(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const dir = resolveVaultDir(name, env);
  const root = resolveVaultRoot(env);
  if (path.dirname(dir) !== root || dir === root) {
    throw new Error(CLAUDE_VAULT_NAME_INVALID);
  }
  if (!(await vaultExists(name, env))) return false;
  // Take the directory lock so a concurrent promotion finishes first rather than
  // writing a credential into a directory being removed underneath it.
  await withDirectoryMergeLock(dir, async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return true;
}
