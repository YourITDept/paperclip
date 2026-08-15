#!/usr/bin/env bash
# Prompt-free Paperclip onboarding.
#
# onboard has no per-value flags: --yes selects quickstart (no prompts) and every
# value comes from the environment (ONBOARD_ENV_KEYS in cli/src/commands/onboard.ts).
set -euo pipefail

# ---------------------------------------------------------------- paths -----
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_ROOT="$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID"
#CONFIG_PATH="$INSTANCE_ROOT/config.json"
CONFIG_PATH="/install/config/paperclip/config.json"
#ENV_PATH="$INSTANCE_ROOT/.env"
# The CLI resolves the env file as dirname(configPath)/.env, so it must stay a
# sibling of the config - derive it rather than repeating the path.
ENV_PATH="$(dirname "$CONFIG_PATH")/.env"

# Belt-and-braces: every command resolves this config, even without -c.
export PAPERCLIP_CONFIG="$CONFIG_PATH"

# ----------------------------------------------------------------- logs -----
# logging.logDir has no onboard env var. This value is written into the instance
# .env as PAPERCLIP_LOG_DIR (which the server logger honors at startup) and is
# also patched into config.json after onboarding, so both paths agree.
LOG_BASE_DIR="${LOG_BASE_DIR:-/sysops/logs}"
LOG_DIR="${LOG_DIR:-$LOG_BASE_DIR/paperclip}"

# ------------------------------------------------------------- database -----
# Set DATABASE_URL for external postgres; leave unset for embedded postgres.
export DATABASE_URL="${POSTGRES_URL:-postgres://paperclip:secret@127.0.0.1:5432/paperclip}"

# -------------------------------------------------------------- backups -----
export PAPERCLIP_DB_BACKUP_ENABLED=true
export PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=720
export PAPERCLIP_DB_BACKUP_RETENTION_DAYS=30
export PAPERCLIP_DB_BACKUP_DIR="/sysops/db_backups/paperclip"

# --------------------------------------------------------------- server -----
# --bind lan forces deploymentMode=authenticated, exposure=private, host=0.0.0.0.
# These three still come from the environment:
export PORT=3100
export SERVE_UI=true
#export PAPERCLIP_ALLOWED_HOSTNAMES="$(hostname -s),$(hostname -f)"
export PAPERCLIP_ALLOWED_HOSTNAMES="${PAPERCLIP_ALLOWED_HOSTNAMES:-$(hostname -s),$(hostname -f),127.0.0.1}"

# ------------------------------------------------ storage + secrets ---------
export PAPERCLIP_STORAGE_PROVIDER=local_disk
export PAPERCLIP_STORAGE_LOCAL_DIR="$INSTANCE_ROOT/data/storage"
export PAPERCLIP_SECRETS_PROVIDER=local_encrypted
export PAPERCLIP_SECRETS_STRICT_MODE=false

# --bind lan forces deploymentMode=authenticated, which requires the auth secret
# in the PROCESS environment - not merely in the .env file. The check reads
# process.env with no file fallback (cli/src/checks/deployment-auth-check.ts).
#
# onboard does generate this secret itself, but too late to satisfy that check:
# because this script pre-creates the .env below, the CLI's loader memoizes the
# path (loadedEnvFiles in cli/src/config/env.ts) while the file still lacks the
# key, writes the secret to the file without touching process.env, and never
# re-reads it. Exporting it up front makes onboard, doctor and the server agree.
# The server takes this in place of BETTER_AUTH_SECRET (server/src/auth/better-auth.ts).
#
# An existing secret is reused, so re-onboarding does not rotate it and
# invalidate sessions or agent tokens issued by a previous install.
if [ -z "${PAPERCLIP_AGENT_JWT_SECRET:-}" ] && [ -f "$ENV_PATH" ]; then
  PAPERCLIP_AGENT_JWT_SECRET="$(sed -n 's/^PAPERCLIP_AGENT_JWT_SECRET=//p' "$ENV_PATH" | tail -1)"
fi
if [ -z "${PAPERCLIP_AGENT_JWT_SECRET:-}" ]; then
  if command -v openssl > /dev/null 2>&1; then
    PAPERCLIP_AGENT_JWT_SECRET="$(openssl rand -hex 32)"
  else
    PAPERCLIP_AGENT_JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  fi
fi
export PAPERCLIP_AGENT_JWT_SECRET

# ---------------------------------------------------------------- guard -----
# onboard preserves an existing config and applies none of the above.
if [ -f "$CONFIG_PATH" ]; then
  echo "config already exists at $CONFIG_PATH - onboard would be a no-op."
  echo "Remove or move it first to re-onboard with these values."
  exit 0
fi

# ---------------------------------------------------- persist the values ----
# Seed the instance .env so `run`, `doctor`, `service` and future commands see
# the same values. The CLI loads it with override:false, so exported vars win,
# and ensureAgentJwtSecret() merges into this file without clobbering it.
ensure_dir() {
  local dir="$1" label="$2"
  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "Cannot create $label at $dir." >&2
    echo "  Fix: sudo install -d -o \"$(id -un)\" -g \"$(id -gn)\" \"$dir\"" >&2
    exit 1
  fi
  if [ ! -w "$dir" ]; then
    echo "$label $dir exists but is not writable by $(id -un)." >&2
    exit 1
  fi
}

mkdir -p "$INSTANCE_ROOT"
# Needed before the .env write below - onboard creates it too, but only later.
ensure_dir "$(dirname "$CONFIG_PATH")" "config directory"
#ensure_dir "$LOG_DIR" "log directory"
#ensure_dir "$PAPERCLIP_DB_BACKUP_DIR" "backup directory"
cat > "$ENV_PATH" <<EOF
# Generated by onboard-paperclip.sh
DATABASE_URL=$DATABASE_URL
PAPERCLIP_DB_BACKUP_ENABLED=$PAPERCLIP_DB_BACKUP_ENABLED
PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=$PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES
PAPERCLIP_DB_BACKUP_RETENTION_DAYS=$PAPERCLIP_DB_BACKUP_RETENTION_DAYS
PAPERCLIP_DB_BACKUP_DIR=$PAPERCLIP_DB_BACKUP_DIR
PAPERCLIP_LOG_DIR=$LOG_DIR
PORT=$PORT
SERVE_UI=$SERVE_UI
PAPERCLIP_ALLOWED_HOSTNAMES=$PAPERCLIP_ALLOWED_HOSTNAMES
PAPERCLIP_STORAGE_PROVIDER=$PAPERCLIP_STORAGE_PROVIDER
PAPERCLIP_STORAGE_LOCAL_DIR=$PAPERCLIP_STORAGE_LOCAL_DIR
PAPERCLIP_SECRETS_PROVIDER=$PAPERCLIP_SECRETS_PROVIDER
PAPERCLIP_SECRETS_STRICT_MODE=$PAPERCLIP_SECRETS_STRICT_MODE
PAPERCLIP_AGENT_JWT_SECRET=$PAPERCLIP_AGENT_JWT_SECRET
EOF
chmod 600 "$ENV_PATH"

# -------------------------------------------------------------- onboard -----
# --yes        : no prompts (required; --bind alone still prompts)
# --bind lan   : authenticated/private on 0.0.0.0
# --install-service : hands the process to the service manager so onboard exits.
#   Drop it and onboard will start the server in the FOREGROUND and block -
#   there is no --no-run flag.
# --config pins the config (and therefore the sibling .env) to $INSTANCE_ROOT.
# Without it the CLI searches cwd upward for .paperclip/config.json and would
# silently use that instead - this script runs from a repo checkout.
# pnpm paperclipai onboard --config "$CONFIG_PATH" --yes --bind lan --install-service
pnpm paperclipai onboard --config "$CONFIG_PATH" --yes --bind lan

# --------------------------------------------- log dir (no env var exists) ---
# Quickstart hardcodes logging.logDir to <instanceRoot>/logs, so patch it in.
node -e '
  const fs = require("fs");
  const [p, dir] = process.argv.slice(1);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.logging = { ...cfg.logging, mode: "file", logDir: dir };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "$CONFIG_PATH" "$LOG_DIR"

# pnpm paperclipai service restart --instance "$PAPERCLIP_INSTANCE_ID" || true
pnpm paperclipai doctor --config "$CONFIG_PATH" --yes
echo "Onboarded: config=$CONFIG_PATH logs=$LOG_DIR backups=$PAPERCLIP_DB_BACKUP_DIR"

# ------------------------------------------------------------ starting it ---
# onboard --yes already started the server above. To start it again later, the
# config path must be passed explicitly or the CLI will look in ~/.paperclip:
#
#   pnpm paperclipai run --config "$CONFIG_PATH" --instance "$PAPERCLIP_INSTANCE_ID"
#
# or equivalently: PAPERCLIP_CONFIG="$CONFIG_PATH" pnpm paperclipai run
