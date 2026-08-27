import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLoginPtyTransport,
  type LoginPtySession,
  type LoginPtyTransport,
} from "@paperclipai/adapter-utils/login-pty-transport";

// The host lane for the Claude `setup-token` login.
//
// Everything above this file already exists and is reused unchanged:
//
//   `runSetupTokenLogin`      (setup-token-runner.ts) drives the two-way login
//   `parseSetupTokenPrompt`   (setup-token-parse.ts)  finds the URL prompt
//   `parseSetupTokenCredential`                       binds the minted token
//   `createLoginPtyTransport` (adapter-utils)         adapts a PTY session into
//                                                     the runner's driver shape
//
// The only thing missing was a {@link LoginPtySession} backed by a host process
// rather than a sandbox, which is what this file adds. The sandbox lane opens its
// session inside a provider; nothing opened one on the host.
//
// Why `script(1)`: `claude setup-token` renders its prompt only on a terminal,
// and pipe stdio emits no prompt at all. `node-pty` would add a native build to
// the server; util-linux `script` is already on every supported host. `-e` is
// load-bearing — without it every run reports exit 0, so a failed login would
// look successful.
//
// Unlike the Codex host driver, stdin is a pipe rather than `ignore`. The Claude
// login is a **round trip**: it prints an authorization URL, the operator signs
// in and pastes a browser code back, and the runner writes that code to the
// child. A driver that cannot write cannot complete this login.
//
// `CLAUDE_CONFIG_DIR` is passed through the environment and never interpolated
// into the command string, so a session path cannot reach the shell `script`
// spawns.

/** The util-linux `script` binary. Overridable for tests. */
const DEFAULT_SCRIPT_COMMAND = "script";

/**
 * A wide terminal. The captured characterization notes that an ~80-column PTY
 * wraps both the authorization URL and the minted token across physical lines.
 * The parser de-wraps, so this is belt-and-braces rather than load-bearing — but
 * not splitting the token at the source removes a whole class of parse failure.
 */
const LOGIN_PTY_COLUMNS = "512";

export interface ClaudeHostLoginPtyOptions {
  /**
   * The `CLAUDE_CONFIG_DIR` the login runs against. Always a staging directory in
   * the vault flow: `claude setup-token` writes machine metadata into its config
   * directory, and a cancelled or failed login must never touch a vault that
   * agents are currently running against.
   */
  configDir: string;
  /** The base environment. Defaults to the server's own. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the `script` binary. Tests only; never taken from a request. */
  scriptCommand?: string;
  /** Overrides the `claude` binary the command names. Tests only. */
  claudeCommand?: string;
}

/** Creates a private staging config directory for one login. */
export async function createClaudeLoginStagingDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-"));
}

/** Removes a staging directory and everything in it. Never throws. */
export async function removeClaudeLoginStagingDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Opens one host pseudo-terminal session for `command`.
 *
 * The session forwards raw terminal bytes unchanged in both directions — it runs
 * no ANSI or OSC 8 handling, because the setup-token parser owns that and needs
 * every byte intact.
 */
export function openClaudeHostLoginPtySession(
  command: string,
  options: ClaudeHostLoginPtyOptions,
): LoginPtySession {
  const scriptCommand = options.scriptCommand ?? DEFAULT_SCRIPT_COMMAND;
  const baseEnv = options.env ?? process.env;
  // The caller's command may name a non-default claude binary. Substitution
  // happens here so the closed command constant stays the single source of the
  // command shape.
  const effective = options.claudeCommand
    ? command.replace(/^claude\b/, options.claudeCommand)
    : command;

  const child: ChildProcess = spawn(scriptCommand, ["-qec", effective, "/dev/null"], {
    env: {
      ...baseEnv,
      CLAUDE_CONFIG_DIR: options.configDir,
      // Claude needs a terminal type to render the prompt.
      TERM: baseEnv.TERM ?? "xterm-256color",
      COLUMNS: LOGIN_PTY_COLUMNS,
      // A stored credential in the caller's environment would let the login
      // short-circuit against the wrong identity. The staging directory is the
      // only credential source this run may see.
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const listeners: ((chunk: string) => void)[] = [];
  const forward = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const listener of listeners) listener(text);
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);

  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    child.on("error", () => resolve({ exitCode: null }));
    child.on("close", (exitCode) => resolve({ exitCode }));
  });

  return {
    onData(listener) {
      listeners.push(listener);
    },
    write(data) {
      // A closed stdin means the child already ended; dropping the write is
      // correct, and throwing here would surface as a login failure with a
      // misleading cause.
      if (child.stdin?.writable) child.stdin.write(data);
    },
    wait() {
      return exited;
    },
    kill() {
      // The characterization showed the child needs SIGKILL; a TERM can leave
      // the terminal session running.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
    async close() {
      this.kill();
      await exited.catch(() => undefined);
    },
  };
}

/**
 * Builds the runner-shaped transport for a host setup-token login.
 *
 * This is the whole host lane: {@link createLoginPtyTransport} adapts the session
 * into the `SetupTokenPtyDriver` shape `runSetupTokenLogin` expects, so the
 * runner — with its prompt parsing, code round-trip, timeout, cancellation, and
 * one-time credential delivery — drives the host unchanged, exactly as it drives
 * a sandbox.
 */
export function createClaudeHostSetupTokenTransport(
  options: ClaudeHostLoginPtyOptions,
): LoginPtyTransport {
  return createLoginPtyTransport(async (command) =>
    openClaudeHostLoginPtySession(command, options),
  );
}
