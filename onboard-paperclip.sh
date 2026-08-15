#!/usr/bin/env bash
# Prompt-free Paperclip onboarding.
#
# onboard has no per-value flags: --yes selects quickstart (no prompts) and every
# value comes from the environment (ONBOARD_ENV_KEYS in cli/src/commands/onboard.ts).
#
# Usage:
#   ./onboard-paperclip.sh                 # onboard this host
#   ./onboard-paperclip.sh --lock-signup   # close signup once the CEO has claimed
#
# Two-phase on purpose. In authenticated/private mode the server exposes
# POST /api/bootstrap/claim (server/src/routes/access.ts), which makes ANY
# signed-in browser user the first instance admin - no invite token needed,
# first come first served. With signup open, whoever reaches the port first can
# take the instance. But signup cannot simply be disabled up front either: there
# is no CLI command that creates a user, so the intended admin would have no way
# to sign up and claim. So: onboard with signup open, claim immediately, then
# run --lock-signup to shut the door. Claiming is what permanently closes the
# claim route (later attempts get already_claimed); --lock-signup stops further
# account creation.
set -euo pipefail

MODE="onboard"
FORCE_LOCK=false
while [ $# -gt 0 ]; do
  case "$1" in
    --lock-signup) MODE="lock-signup"; shift ;;
    --force) FORCE_LOCK=true; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------ cli -----
# Works both inside a checkout and on a host that only has the packaged CLI.
# Preference order: an explicit PAPERCLIP_CLI, then a real paperclipai on PATH
# (an installed bundle), then the workspace wrapper. PAPERCLIP_CLI may include
# arguments, e.g. PAPERCLIP_CLI="node /srv/paperclip-bundle/cli.js" or a path to
# a bundle's binary that is not on PATH.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${PAPERCLIP_CLI:-}" ]; then
  read -r -a PAPERCLIP_CMD <<< "$PAPERCLIP_CLI"
elif command -v paperclipai > /dev/null 2>&1; then
  PAPERCLIP_CMD=(paperclipai)
elif command -v pnpm > /dev/null 2>&1 && [ -f "$SCRIPT_DIR/pnpm-workspace.yaml" ]; then
  # --dir keeps this working when invoked from outside the checkout.
  PAPERCLIP_CMD=(pnpm --dir "$SCRIPT_DIR" paperclipai)
elif [ "$MODE" = "onboard" ]; then
  echo "No Paperclip CLI found." >&2
  echo "  Install the bundle so 'paperclipai' is on PATH, or set PAPERCLIP_CLI." >&2
  exit 1
else
  # --lock-signup only needs node and curl; the CLI name is just printed as a
  # restart hint, so a missing CLI must not block locking the instance down.
  PAPERCLIP_CMD=(paperclipai)
fi

# ---------------------------------------------------------------- paths -----
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_ROOT="$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID"
#CONFIG_PATH="$INSTANCE_ROOT/config.json"
# PAPERCLIP_CONFIG wins when set, so a caller can point this at another instance
# without editing the script; otherwise the host default applies.
CONFIG_PATH="${PAPERCLIP_CONFIG:-/install/config/paperclip/config.json}"
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

# ------------------------------------------------------- lock signup mode ---
# Sets auth.disableSignUp=true, closing account creation once the instance has
# an admin. Refuses to run while the instance is still unclaimed: with no admin
# and no signup there is no way back in short of editing the config by hand.
if [ "$MODE" = "lock-signup" ]; then
  [ -f "$CONFIG_PATH" ] || {
    echo "No config at $CONFIG_PATH - run this script without --lock-signup first." >&2
    exit 1
  }

  # bootstrapStatus is "ready" once an instance_admin exists (server/src/routes/health.ts).
  health_json="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  claim_status="unreachable"
  if [ -n "$health_json" ]; then
    claim_status="$(printf '%s' "$health_json" | node -e '
      let raw = "";
      process.stdin.on("data", (d) => { raw += d; });
      process.stdin.on("end", () => {
        try { process.stdout.write(JSON.parse(raw).bootstrapStatus ?? "unknown"); }
        catch { process.stdout.write("unknown"); }
      });
    ' 2>/dev/null || echo "unknown")"
  fi

  if [ "$claim_status" != "ready" ] && [ "$FORCE_LOCK" = false ]; then
    case "$claim_status" in
      bootstrap_pending)
        echo "Refusing to disable signup: this instance has no admin yet." >&2
        echo "  Sign in at http://$(hostname -f):$PORT and claim it first." >&2
        ;;
      *)
        echo "Refusing to disable signup: could not confirm the instance is claimed" >&2
        echo "  (server on port $PORT did not answer /api/health: $claim_status)." >&2
        echo "  Start the server and retry, so the claim state can be verified." >&2
        ;;
    esac
    echo "  Override with --force if you are certain an admin already exists." >&2
    exit 1
  fi

  node -e '
    const fs = require("fs");
    const [p] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.auth = { ...cfg.auth, disableSignUp: true };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "$CONFIG_PATH"
  echo "Signup disabled in $CONFIG_PATH (auth.disableSignUp=true)."

  # PAPERCLIP_AUTH_DISABLE_SIGN_UP overrides the file outright
  # (server/src/config.ts), so a stale entry would silently undo the edit.
  if grep -q '^PAPERCLIP_AUTH_DISABLE_SIGN_UP=' "$ENV_PATH" 2>/dev/null; then
    echo "WARNING: $ENV_PATH sets PAPERCLIP_AUTH_DISABLE_SIGN_UP, which overrides the" >&2
    echo "         config file. Remove it or set it to true, or this change has no effect." >&2
  fi

  echo "Restart the server for it to take effect:"
  echo "  PAPERCLIP_CONFIG=\"$CONFIG_PATH\" ${PAPERCLIP_CMD[*]} run"
  exit 0
fi

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
echo "Using CLI: ${PAPERCLIP_CMD[*]}"
# "${PAPERCLIP_CMD[@]}" onboard --config "$CONFIG_PATH" --yes --bind lan --install-service
"${PAPERCLIP_CMD[@]}" onboard --config "$CONFIG_PATH" --yes --bind lan

# --------------------------------------------- log dir (no env var exists) ---
# Quickstart hardcodes logging.logDir to <instanceRoot>/logs, so patch it in.
node -e '
  const fs = require("fs");
  const [p, dir] = process.argv.slice(1);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.logging = { ...cfg.logging, mode: "file", logDir: dir };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "$CONFIG_PATH" "$LOG_DIR"

# "${PAPERCLIP_CMD[@]}" service restart --instance "$PAPERCLIP_INSTANCE_ID" || true
"${PAPERCLIP_CMD[@]}" doctor --config "$CONFIG_PATH" --yes
echo "Onboarded: config=$CONFIG_PATH logs=$LOG_DIR backups=$PAPERCLIP_DB_BACKUP_DIR"
echo
echo "IMPORTANT - the instance is unclaimed and signup is open. Until you claim it,"
echo "anyone who can reach port $PORT can sign up and become the instance admin."
echo "Do this now, in order:"
echo "  1. Start the server:  PAPERCLIP_CONFIG=\"$CONFIG_PATH\" ${PAPERCLIP_CMD[*]} run"
echo "  2. Open http://$(hostname -f):$PORT and sign up as the admin account"
echo "  3. Claim the instance when prompted"
echo "  4. Close signup:      $0 --lock-signup"

# ------------------------------------------------------------ starting it ---
# onboard --yes already started the server above. To start it again later, the
# config path must be passed explicitly or the CLI will look in ~/.paperclip:
#
#   paperclipai run --config "$CONFIG_PATH" --instance "$PAPERCLIP_INSTANCE_ID"
#
# or equivalently: PAPERCLIP_CONFIG="$CONFIG_PATH" paperclipai run
