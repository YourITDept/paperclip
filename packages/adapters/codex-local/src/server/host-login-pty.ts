import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxLoginDriver } from "./device-login-runner.js";

// The host login pseudo-terminal (PTY) driver.
//
// `codex login --device-auth` renders its prompt ONLY on a terminal; with piped
// stdio it emits nothing to parse (see device-login-runner.ts). The sandbox lane
// gets its PTY from the provider. This driver is the host equivalent, so a login
// can run on the Paperclip host with no sandbox provider at all.
//
// It allocates the PTY with util-linux `script`, which every supported host
// already ships, rather than a native pty binding that would add a build
// toolchain to the server. `-q` suppresses the banner, `-e` propagates the
// child's exit status (without it every run looks successful), and `-c` names the
// command.
//
// Command safety: the command string is chosen by the caller from a closed set —
// it never comes from a request. `CODEX_HOME` is passed through the ENVIRONMENT
// and never interpolated into the command string, so a session path can never
// reach the shell that `script` spawns.
//
// Secret handling: the driver streams terminal bytes to its callback and keeps
// none of them. It writes no output to any durable log.

/** The PTY allocator. util-linux `script` is present on every supported host. */
const DEFAULT_SCRIPT_COMMAND = "script";

/**
 * The bounded credential size. A real `auth.json` is a few kilobytes; the read
 * rejects anything larger before returning bytes. Matches the sandbox read bound.
 */
export const MAX_HOST_AUTH_BYTES = 64 * 1024;

/**
 * The environment key that names the `codex` executable for a login. The server
 * often runs with a minimal PATH that does not include the shell's npm bin
 * directory, so a login would fail with an opaque spawn error. Setting this to an
 * absolute path removes the PATH dependency entirely.
 */
export const CODEX_LOGIN_BIN_ENV_KEY = "PAPERCLIP_CODEX_LOGIN_BIN";

/**
 * Resolves the `codex` executable for a login, or null when it cannot be found.
 *
 * An explicit override is checked for executability directly. A bare name is
 * searched along PATH the way the shell would. Callers use this as a preflight so
 * a missing binary produces a clear message instead of a generic login failure.
 */
export async function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configured = env[CODEX_LOGIN_BIN_ENV_KEY]?.trim();
  const candidate = configured && configured.length > 0 ? configured : "codex";
  const isExecutable = async (file: string) =>
    access(file, fsConstants.X_OK).then(() => true).catch(() => false);

  if (candidate.includes(path.sep)) {
    return (await isExecutable(candidate)) ? path.resolve(candidate) : null;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const file = path.join(dir, candidate);
    if (await isExecutable(file)) return file;
  }
  return null;
}

/** The fixed, non-secret error every failed credential read returns. */
export const HOST_LOGIN_AUTH_READ_ERROR =
  "device login failed: the host credential read errored.";

export interface HostLoginDriverOptions {
  /** `CODEX_HOME` for the login process. Codex writes `auth.json` here. */
  sessionHome: string;
  /** The `codex` executable. Defaults to `codex` on `PATH`. */
  codexCommand?: string;
  /** The `script` executable. Defaults to `script` on `PATH`. */
  scriptCommand?: string;
  /** The host environment the login inherits. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Creates a private staging home for one login. Codex writes its credential
 * here, and the caller promotes the validated bytes into the vault afterwards.
 * Staging keeps a failed or partial login from ever touching a vault that agents
 * are currently running against.
 */
export async function createLoginStagingHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "paperclip-codex-login-"));
}

/** Removes a staging home and everything in it. Never throws. */
export async function removeLoginStagingHome(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Reads the credential with a descriptor-bound read.
 *
 * A pathname check followed by a separate read is a time-of-check-to-time-of-use
 * (TOCTOU) window: the file can be swapped between the two steps. This opens the
 * file once with `O_NOFOLLOW`, runs `fstat` on that same descriptor, and reads
 * only from that descriptor — so the bytes returned are provably the bytes that
 * passed the check.
 *
 * The checks require a regular file, ownership by the current user, exact mode
 * 0600, and a bounded size. Every failure returns one fixed, non-secret error
 * that names no path and carries no bytes.
 */
async function readCredentialBoundToDescriptor(filePath: string): Promise<Buffer> {
  let handle;
  try {
    // O_NOFOLLOW makes the open itself fail when the final component is a
    // symlink, so a swapped-in link is rejected rather than followed.
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(HOST_LOGIN_AUTH_READ_ERROR);
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== os.userInfo().uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > MAX_HOST_AUTH_BYTES ||
      stat.size === 0
    ) {
      throw new Error(HOST_LOGIN_AUTH_READ_ERROR);
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error(HOST_LOGIN_AUTH_READ_ERROR);
    return buffer;
  } catch {
    throw new Error(HOST_LOGIN_AUTH_READ_ERROR);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Creates a {@link SandboxLoginDriver} that runs the login on a host PTY. It
 * satisfies the same interface the sandbox lane uses, so `runDeviceLogin` drives
 * either lane unchanged — the prompt parsing, timeout, cancellation, and
 * one-time prompt handling are all shared.
 */
export function createHostLoginDriver(options: HostLoginDriverOptions): SandboxLoginDriver {
  const scriptCommand = options.scriptCommand ?? DEFAULT_SCRIPT_COMMAND;
  const baseEnv = options.env ?? process.env;
  let child: ChildProcess | null = null;

  return {
    start(command, onData) {
      return new Promise((resolve, reject) => {
        // The caller's command may name a non-default codex binary. Substitution
        // happens here rather than in the caller so the closed command constant
        // stays the single source of the command shape.
        const effective = options.codexCommand
          ? command.replace(/^codex\b/, options.codexCommand)
          : command;
        const spawned = spawn(scriptCommand, ["-qec", effective, "/dev/null"], {
          env: {
            ...baseEnv,
            CODEX_HOME: options.sessionHome,
            // Codex needs a terminal type to render the prompt.
            TERM: baseEnv.TERM ?? "xterm-256color",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child = spawned;

        const forward = (chunk: Buffer) => onData(chunk.toString("utf8"));
        spawned.stdout?.on("data", forward);
        spawned.stderr?.on("data", forward);

        spawned.on("error", (error) => {
          child = null;
          reject(error);
        });
        spawned.on("close", (exitCode) => {
          child = null;
          resolve({ exitCode });
        });
      });
    },

    readFile(filePath) {
      return readCredentialBoundToDescriptor(filePath);
    },

    async dispose() {
      const running = child;
      child = null;
      if (!running || running.exitCode !== null || running.signalCode !== null) return;
      running.kill("SIGTERM");
    },
  };
}
