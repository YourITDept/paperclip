import { existsSync, readFileSync } from "node:fs";
import { resolveManagedCodexHomeOverride } from "@paperclipai/adapter-utils/server-utils";
import { resolvePaperclipConfigPath, resolvePaperclipEnvPath } from "./paths.js";
import type { BindMode, DeploymentExposure, DeploymentMode } from "@paperclipai/shared";

import { parse as parseEnvFileContents } from "dotenv";

type UiMode = "none" | "static" | "vite-dev";

type ExternalPostgresInfo = {
  mode: "external-postgres";
  connectionString: string;
};

type EmbeddedPostgresInfo = {
  mode: "embedded-postgres";
  dataDir: string;
  port: number;
};

type StartupBannerOptions = {
  bind: BindMode;
  host: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  requestedPort: number;
  listenPort: number;
  uiMode: UiMode;
  db: ExternalPostgresInfo | EmbeddedPostgresInfo;
  migrationSummary: string;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
};

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function color(text: string, c: keyof typeof ansi): string {
  return `${ansi[c]}${text}${ansi.reset}`;
}

function row(label: string, value: string): string {
  return `${color(label.padEnd(16), "dim")} ${value}`;
}

function redactConnectionString(raw: string): string {
  try {
    const u = new URL(raw);
    const user = u.username || "user";
    const auth = `${user}:***@`;
    return `${u.protocol}//${auth}${u.host}${u.pathname}`;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

function resolveAgentJwtSecretStatus(
  envFilePath: string,
): {
  status: "pass" | "warn";
  message: string;
} {
  const envValue = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (envValue) {
    return {
      status: "pass",
      message: "set",
    };
  }

  if (existsSync(envFilePath)) {
    const parsed = parseEnvFileContents(readFileSync(envFilePath, "utf-8"));
    const fileValue = typeof parsed.PAPERCLIP_AGENT_JWT_SECRET === "string" ? parsed.PAPERCLIP_AGENT_JWT_SECRET.trim() : "";
    if (fileValue) {
      return {
        status: "warn",
        message: `found in ${envFilePath} but not loaded`,
      };
    }
  }

  return {
    status: "warn",
    message: "missing (run `npx paperclipai onboard`)",
  };
}

/**
 * Head and tail of a provider API key, matching how the OpenRouter dashboard
 * renders its own key rows (`sk-or-v1-797...c02`) so a banner line can be
 * compared against the dashboard without revealing usable key material. Keys too
 * short for the window to stay a small fraction of the whole are reported as
 * present with none of their characters shown.
 */
const API_KEY_HEAD_CHARS = 12;
const API_KEY_TAIL_CHARS = 3;
const API_KEY_MIN_MASKABLE_CHARS = 32;

export function maskApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length < API_KEY_MIN_MASKABLE_CHARS) return "set";
  return `${key.slice(0, API_KEY_HEAD_CHARS)}...${key.slice(-API_KEY_TAIL_CHARS)}`;
}

/**
 * `PAPERCLIP_CODEX_HOME` set in the server's own environment is the
 * instance-wide default Codex home every `codex_local` agent inherits, so
 * whether it took is a startup fact worth stating rather than something to infer
 * from a failed run. A configured-but-absent path is called out: the directory
 * gets created and seeded on first use, which means a typo silently yields an
 * empty home with no provider config instead of the prepared one.
 */
export function resolveCodexHomeBannerValue(): string {
  const override = resolveManagedCodexHomeOverride(undefined, process.env);
  if (!override) {
    return `${color("not set", "yellow")} ${color("(agents use the per-company managed home)", "dim")}`;
  }
  if (!existsSync(override)) {
    return `${override} ${color("(missing — created and seeded on first run)", "yellow")}`;
  }
  return color(override, "green");
}

export function resolveOpenRouterKeyBannerValue(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return color("not set", "yellow");
  return color(maskApiKey(key), "green");
}

export function printStartupBanner(opts: StartupBannerOptions): void {
  const baseHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
  const baseUrl = `http://${baseHost}:${opts.listenPort}`;
  const apiUrl = `${baseUrl}/api`;
  const uiUrl = opts.uiMode === "none" ? "disabled" : baseUrl;
  const configPath = resolvePaperclipConfigPath();
  const envFilePath = resolvePaperclipEnvPath();
  const agentJwtSecret = resolveAgentJwtSecretStatus(envFilePath);

  const dbMode =
    opts.db.mode === "embedded-postgres"
      ? color("embedded-postgres", "green")
      : color("external-postgres", "yellow");
  const uiMode =
    opts.uiMode === "vite-dev"
      ? color("vite-dev-middleware", "cyan")
      : opts.uiMode === "static"
        ? color("static-ui", "magenta")
        : color("headless-api", "yellow");

  const portValue =
    opts.requestedPort === opts.listenPort
      ? `${opts.listenPort}`
      : `${opts.listenPort} ${color(`(requested ${opts.requestedPort})`, "dim")}`;

  const dbDetails =
    opts.db.mode === "embedded-postgres"
      ? `${opts.db.dataDir} ${color(`(pg:${opts.db.port})`, "dim")}`
      : redactConnectionString(opts.db.connectionString);

  const heartbeat = opts.heartbeatSchedulerEnabled
    ? `enabled ${color(`(${opts.heartbeatSchedulerIntervalMs}ms)`, "dim")}`
    : color("disabled", "yellow");
  const dbBackup = opts.databaseBackupEnabled
    ? `enabled ${color(`(every ${opts.databaseBackupIntervalMinutes}m, keep ${opts.databaseBackupRetentionDays}d)`, "dim")}`
    : color("disabled", "yellow");

  const art = [
    color("██████╗  █████╗ ██████╗ ███████╗██████╗  ██████╗██╗     ██╗██████╗ ", "cyan"),
    color("██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝██║     ██║██╔══██╗", "cyan"),
    color("██████╔╝███████║██████╔╝█████╗  ██████╔╝██║     ██║     ██║██████╔╝", "cyan"),
    color("██╔═══╝ ██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗██║     ██║     ██║██╔═══╝ ", "cyan"),
    color("██║     ██║  ██║██║     ███████╗██║  ██║╚██████╗███████╗██║██║     ", "cyan"),
    color("╚═╝     ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝╚═╝     ", "cyan"),
  ];

  const lines = [
    "",
    ...art,
    color("  ───────────────────────────────────────────────────────", "blue"),
    row("Mode", `${dbMode}  |  ${uiMode}`),
    row("Deploy", `${opts.deploymentMode} (${opts.deploymentExposure})`),
    row("Bind", `${opts.bind} ${color(`(${opts.host})`, "dim")}`),
    row("Auth", opts.authReady ? color("ready", "green") : color("not-ready", "yellow")),
    row("Server", portValue),
    row("API", `${apiUrl} ${color(`(health: ${apiUrl}/health)`, "dim")}`),
    row("UI", uiUrl),
    row("Database", dbDetails),
    row("Migrations", opts.migrationSummary),
    row(
      "Agent JWT",
      agentJwtSecret.status === "pass"
        ? color(agentJwtSecret.message, "green")
        : color(agentJwtSecret.message, "yellow"),
    ),
    row("Codex Home", resolveCodexHomeBannerValue()),
    row("OpenRouter", resolveOpenRouterKeyBannerValue()),
    row("Heartbeat", heartbeat),
    row("DB Backup", dbBackup),
    row("Backup Dir", opts.databaseBackupDir),
    row("Config", configPath),
    agentJwtSecret.status === "warn"
      ? color("  ───────────────────────────────────────────────────────", "yellow")
      : null,
    color("  ───────────────────────────────────────────────────────", "blue"),
    "",
  ];

  console.log(lines.filter((line): line is string => line !== null).join("\n"));
}
