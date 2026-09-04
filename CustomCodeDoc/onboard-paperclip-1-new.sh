#!/usr/bin/env bash
# Paperclip onboarding, boot 1 — the provisioning-fed variant.
#
# This is `onboard-paperclip-1.sh` with every ownership step removed. It stands
# the instance up — config, .env, secrets, schema — and stops, having created no
# user, no company, no membership and no invite.
#
# WHY. Ownership now arrives from the database. The onboarding tooling writes
# rows into `provisioning.provisioning_jobs` before this host ever runs, and
# Paperclip's provisioning worker applies them: the company, the instance owner,
# the Outseta roster and their permission grants. Nothing here claims an admin
# or mints a CEO invite, because the queue already says who the owner is.
#
# THE TWO BOOTS:
#
#   Boot 1  this script          PAPERCLIP_PROVISIONING_WORKER_ENABLED off
#           Migrates the schema and settles the config. The queue is NOT read
#           and NOT touched. If anything fails here, nothing has been
#           provisioned and there is nothing to unpick.
#
#   Boot 2  the supervised start PAPERCLIP_PROVISIONING_WORKER_ENABLED=true
#           The worker's startup drain applies the queue — company, owner,
#           roster, grants — then keeps polling for ongoing member sync. The
#           flag stays on from here. This is where the instance gets claimed.
#
# BOOT 2 IS NOT AN EXTRA STEP. This script has always left the engine stopped
# for supervisord/systemd to start; that supervised start IS boot 2. Nobody runs
# anything twice.
#
# The flag is forced off only for the throwaway server this script starts
# internally, and for one concrete reason: that server is killed on a timer
# (SIGINT, then SIGTERM at 15s, then SIGKILL). A drain interrupted by SIGKILL
# leaves a job stuck in `running` until the reaper returns it 15 minutes later.
# The supervised server has no such timer, so it is the right place to drain.
#
# The flag is NOT written into the instance .env — entrypoint.sh owns it for the
# real runs, and the .env writer below preserves it if entrypoint.sh has set it.
#
# REMOVED relative to onboard-paperclip-1.sh, and where each went:
#
#   auth bootstrap-ceo   -> the queue's `user.upsert` with isInstanceAdmin
#   --claim-admin        -> the same
#   --set-owner          -> the queue's `membership.set` with role owner
#   --lock-signup        -> nothing left to lock: apply_config_patches already
#                           sets auth.disableSignUp, and the queue provisions
#                           users directly so closing signup costs nothing
#
# WHY bootstrap-ceo IS GENUINELY GONE, not merely skipped. "Claiming the
# instance" has exactly one meaning in the code. server/src/routes/health.ts:326
# counts instance_user_roles rows with role='instance_admin' and reports
# bootstrap_pending when that count is zero, ready when it is not. The invite
# URL, the claim screen and POST /api/bootstrap/claim are three ways to insert
# that one row.
#
# The queue inserts it directly: `user.upsert` with isInstanceAdmin:true calls
# accessService.promoteInstanceAdmin, which writes exactly that row. So the
# instance is claimed the moment the worker drains, with no invite to mint, copy
# or lose.
#
# That is strictly better than the invite path here, because it closes a race
# the old script had to warn about: claiming was first-come-first-served among
# anyone who could sign in, and with a trusted proxy in front that meant anyone
# the proxy authenticated could claim the instance before the intended owner
# reached it. The queue names the owner up front, so there is nothing to win.
#
# Everything else — CLI resolution, paths, DATABASE_URL, backups, storage, the
# secrets master-key handling, the run-then-stop dance, the config patches — is
# carried over unchanged, because it is what makes a working instance.
#
# RULE 0: this script never commits anything.
#
# ---------------------------------------------------------------- usage -----
#   ./onboard-paperclip-1-new.sh                # onboard this host
#   ./onboard-paperclip-1-new.sh --check-env    # what is set, what defaults, what is missing
#   ./onboard-paperclip-1-new.sh --status       # engine + queue state
#   ./onboard-paperclip-1-new.sh --check-engine # is the engine running? (--wait to poll)
#   ./onboard-paperclip-1-new.sh --queue        # what is waiting to be applied
#   ./onboard-paperclip-1-new.sh --apply-config # re-apply config patches
#
# Flags: --timeout <seconds>  --wait
#        --pnpm  run the CLI from this checkout via tsx instead of the release

set -euo pipefail

MODE="onboard"
WAIT_FOR_READY=false
WAIT_TIMEOUT=120
USE_PNPM=false

while [ $# -gt 0 ]; do
  case "$1" in
    --apply-config) MODE="apply-config"; shift ;;
    --status) MODE="status"; shift ;;
    --check-engine) MODE="check-engine"; shift ;;
    --check-env) MODE="check-env"; shift ;;
    --queue) MODE="queue"; shift ;;
    --wait) WAIT_FOR_READY=true; shift ;;
    --pnpm) USE_PNPM=true; shift ;;
    --timeout) WAIT_TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,54p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------ cli -----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_repo_root() {
  local d="${PAPERCLIP_REPO_ROOT:-$SCRIPT_DIR}"
  while [ "$d" != "/" ]; do
    [ -f "$d/pnpm-workspace.yaml" ] && { printf '%s' "$d"; return 0; }
    d="$(dirname "$d")"
  done
  return 1
}

# --silent is NOT optional: pnpm's banner goes to STDOUT and the JSON captures
# below pipe stdout straight into node.
if [ "$USE_PNPM" = true ]; then
  command -v pnpm > /dev/null 2>&1 || { echo "--pnpm needs pnpm on PATH." >&2; exit 1; }
  REPO_ROOT="$(find_repo_root)" || {
    echo "--pnpm: no pnpm-workspace.yaml above $SCRIPT_DIR." >&2
    echo "  Set PAPERCLIP_REPO_ROOT to the checkout root." >&2
    exit 1
  }
  PAPERCLIP_CMD=(pnpm --silent --dir "$REPO_ROOT" paperclipai)
elif [ -n "${PAPERCLIP_CLI:-}" ]; then
  read -r -a PAPERCLIP_CMD <<< "$PAPERCLIP_CLI"
elif command -v paperclipai > /dev/null 2>&1; then
  PAPERCLIP_CMD=(paperclipai)
elif command -v pnpm > /dev/null 2>&1 && REPO_ROOT="$(find_repo_root)"; then
  PAPERCLIP_CMD=(pnpm --silent --dir "$REPO_ROOT" paperclipai)
elif [ "$MODE" = "onboard" ]; then
  echo "No Paperclip CLI found." >&2
  echo "  Install the bundle so 'paperclipai' is on PATH, or set PAPERCLIP_CLI." >&2
  exit 1
else
  PAPERCLIP_CMD=(paperclipai)
fi

# ---------------------------------------------------------------- paths -----
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_ROOT="$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID"
CONFIG_PATH="${PAPERCLIP_CONFIG:-/sysops/config/paperclip/config.json}"
# The CLI resolves the env file as dirname(configPath)/.env, so it must stay a
# sibling of the config — derive it rather than repeating the path.
ENV_PATH="$(dirname "$CONFIG_PATH")/.env"
export PAPERCLIP_CONFIG="$CONFIG_PATH"

# ----------------------------------------------------------------- logs -----
LOG_BASE_DIR="${LOG_BASE_DIR:-/sysops/logs}"
LOG_DIR="${LOG_DIR:-$LOG_BASE_DIR/paperclip}"

# ------------------------------------------------------------- database -----
# POSTGRES_URL is what Environment-base.txt publishes; DATABASE_URL is the ONLY
# name Paperclip reads (server/src/config.ts:320). This mapping is the bridge.
# Without it the server silently falls back to embedded postgres and provisions
# into a database nobody is looking at.
export DATABASE_URL="${POSTGRES_URL:-postgres://paperclip:secret@127.0.0.1:5432/paperclip}"

# -------------------------------------------------------------- backups -----
export PAPERCLIP_DB_BACKUP_ENABLED=true
export PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=720
export PAPERCLIP_DB_BACKUP_RETENTION_DAYS=30
export PAPERCLIP_DB_BACKUP_DIR="/sysops/db_backups/paperclip"

# --------------------------------------------------------- provisioning -----
# Boot 1 must not provision. Forced off for THIS process regardless of the
# environment or the instance .env, so the onboarding run below cannot claim the
# queue. Deliberately NOT written into the instance .env: entrypoint.sh is the
# authority for the real runs.
export PAPERCLIP_PROVISIONING_WORKER_ENABLED=false

# --------------------------------------------------------------- server -----
export PORT="${PAPERCLIP_PORT:-3100}"
export PAPERCLIP_NO_BROWSER=1
export SERVE_UI=true
export PAPERCLIP_FQDN="${PAPERCLIP_FQDN:-$(hostname -f)}"
PAPERCLIP_BASE_URL="${PAPERCLIP_BASE_URL:-${PAPERCLIP_PUBLIC_URL:-http://$PAPERCLIP_FQDN:$PORT}}"
export PAPERCLIP_ALLOWED_HOSTNAMES="${PAPERCLIP_ALLOWED_HOSTNAMES:-$(hostname -s),$(hostname -f),127.0.0.1}"
case ",$PAPERCLIP_ALLOWED_HOSTNAMES," in
  *",$PAPERCLIP_FQDN,"*) ;;
  *) export PAPERCLIP_ALLOWED_HOSTNAMES="$PAPERCLIP_ALLOWED_HOSTNAMES,$PAPERCLIP_FQDN" ;;
esac

# ------------------------------------------------ storage + secrets ---------
export PAPERCLIP_STORAGE_PROVIDER=local_disk
export PAPERCLIP_STORAGE_LOCAL_DIR="$INSTANCE_ROOT/data/storage"
export PAPERCLIP_SECRETS_PROVIDER=local_encrypted
export PAPERCLIP_SECRETS_STRICT_MODE=false
export PAPERCLIP_SECRETS_MASTER_KEY_FILE="${PAPERCLIP_SECRETS_MASTER_KEY_FILE:-$(dirname "$CONFIG_PATH")/secrets/master.key}"

# --bind lan forces deploymentMode=authenticated, which requires the auth secret
# in the PROCESS environment, not merely in the .env file. The server takes this
# in place of BETTER_AUTH_SECRET (server/src/auth/better-auth.ts) and refuses to
# start without one. An existing secret is reused, so re-onboarding does not
# rotate it and invalidate sessions or agent tokens from a previous install.
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

# ------------------------------------------------- non-negotiable gates ------
# Two settings silently destroy what the queue provisions. Neither produces an
# error, so they are checked here rather than discovered later.
#
# PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN is fatal, not a warning.
# `resolveCloudTenantActor` (server/src/middleware/auth.ts) DELETES every
# instance_admin row on each authenticated request. One cloud-header request
# strips the admin the queue just granted and company creation stops working
# with nothing to explain it. Onboarding into that is worse than not onboarding.
#
# PAPERCLIP_PROXY_AUTH_AUTO_PROVISION must be false. With a forward-auth cookie
# shared across subdomains, every signed-in person presents a valid
# X-Forwarded-User on EVERY instance; the only thing keeping account A's user
# out of account B is the absence of a `user` row there, and auto-provision
# creates that row on sight.
check_gates() {
  local fatal=0
  if [ -n "${PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN:-}" ]; then
    echo "FATAL: PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN is set." >&2
    echo "       It deletes instance_admin rows on every authenticated request," >&2
    echo "       which would silently undo everything the provisioning queue grants." >&2
    echo "       Unset it and re-run." >&2
    fatal=1
  fi
  case "${PAPERCLIP_PROXY_AUTH_AUTO_PROVISION:-false}" in
    false|"") ;;
    *)
      echo "FATAL: PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=${PAPERCLIP_PROXY_AUTH_AUTO_PROVISION}." >&2
      echo "       This opens cross-tenant access: any Outseta-signed-in person gets a" >&2
      echo "       user row on sight, on every instance. It must be false." >&2
      fatal=1 ;;
  esac
  [ "$fatal" = 0 ] || exit 1
}

# ------------------------------------------- post-onboard config patches ----
#   logging.logDir      quickstart hardcodes <instanceRoot>/logs; use LOG_DIR
#   auth.disableSignUp  no password self-registration on this instance
#   telemetry.enabled   off
#   secrets.keyFilePath moved to sit beside config.json and .env
#
# Closing signup is safe because nothing depends on it for account creation: the
# provisioning worker inserts users directly, and the trusted proxy resolves
# them by email.
apply_config_patches() {
  if ! mkdir -p "$LOG_DIR" 2>/dev/null || [ ! -w "$LOG_DIR" ]; then
    echo "WARNING: log directory $LOG_DIR is not writable by $(id -un)." >&2
    echo "         Fix: sudo install -d -o \"$(id -un)\" -g \"$(id -gn)\" \"$LOG_DIR\"" >&2
  fi

  # Create the directory private, then MOVE any existing key BEFORE the config
  # is repointed. The other order is destructive: the CLI would find no key at
  # the new path, generate a fresh one, and every secret encrypted under the old
  # key would be unrecoverable.
  secrets_dir="$(dirname "$PAPERCLIP_SECRETS_MASTER_KEY_FILE")"
  mkdir -p "$secrets_dir"
  chmod 700 "$secrets_dir" 2>/dev/null || true

  current_key="$(node -e '
    const fs = require("fs");
    try {
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(cfg.secrets?.localEncrypted?.keyFilePath ?? "");
    } catch { process.stdout.write(""); }
  ' "$CONFIG_PATH")"

  if [ -n "$current_key" ] && [ "$current_key" != "$PAPERCLIP_SECRETS_MASTER_KEY_FILE" ] && [ -f "$current_key" ]; then
    if [ -f "$PAPERCLIP_SECRETS_MASTER_KEY_FILE" ]; then
      echo "WARNING: master keys exist at BOTH paths:" >&2
      echo "           $current_key" >&2
      echo "           $PAPERCLIP_SECRETS_MASTER_KEY_FILE" >&2
      echo "         Leaving both untouched - picking one could orphan stored secrets." >&2
      echo "         Resolve by hand, then re-run." >&2
    else
      mv "$current_key" "$PAPERCLIP_SECRETS_MASTER_KEY_FILE"
      echo "Moved secrets master key: $current_key -> $PAPERCLIP_SECRETS_MASTER_KEY_FILE"
    fi
  fi
  if [ -f "$PAPERCLIP_SECRETS_MASTER_KEY_FILE" ]; then
    chmod 600 "$PAPERCLIP_SECRETS_MASTER_KEY_FILE"
  fi

  node -e '
    const fs = require("fs");
    const [p, dir, keyPath] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.logging = { ...cfg.logging, mode: "file", logDir: dir };
    cfg.auth = { ...cfg.auth, disableSignUp: true };
    cfg.telemetry = { ...cfg.telemetry, enabled: false };
    cfg.secrets = {
      ...cfg.secrets,
      localEncrypted: { ...cfg.secrets?.localEncrypted, keyFilePath: keyPath },
    };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "$CONFIG_PATH" "$LOG_DIR" "$PAPERCLIP_SECRETS_MASTER_KEY_FILE"
  echo "Config patched: logging.logDir=$LOG_DIR, auth.disableSignUp=true, telemetry.enabled=false"
  echo "                secrets.keyFilePath=$PAPERCLIP_SECRETS_MASTER_KEY_FILE (dir 700, key 600)"

  # Signup is now off and there is no password path for a provisioned user: the
  # queue writes a `user` row and no `account` row, so identity has to come from
  # the proxy. Without it, nobody can sign in at all.
  if [ "${PAPERCLIP_PROXY_AUTH_ENABLED:-}" != "true" ]; then
    echo "WARNING: PAPERCLIP_PROXY_AUTH_ENABLED is not 'true' in this environment." >&2
    echo "         Signup is disabled and provisioned users have no password, so" >&2
    echo "         nobody can sign in until proxy auth is on." >&2
  fi
}

# --------------------------------------------------------- health / engine --
LOCAL_API="http://127.0.0.1:$PORT"

health_field() {
  local field="$1" json
  json="$(curl -fsS --max-time 5 "$LOCAL_API/api/health" 2>/dev/null || true)"
  [ -n "$json" ] || { printf 'unreachable'; return; }
  printf '%s' "$json" | node -e '
    let raw = ""; const f = process.argv[1];
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw)[f] ?? "unknown")); }
      catch { process.stdout.write("unknown"); }
    });
  ' "$field" 2>/dev/null || printf 'unknown'
}

# status:"ok" proves BOTH halves — the process is listening AND Postgres is
# reachable. The route answers "unhealthy" with error:"database_unreachable"
# when the process is up but the database is not.
engine_status() {
  if [ "$(health_field status)" = "ok" ]; then
    echo "engine: RUNNING on $LOCAL_API (bootstrapStatus=$(health_field bootstrapStatus))"
    return 0
  fi
  echo "engine: NOT RUNNING on $LOCAL_API"
  return 1
}

# What the worker will apply on boot 2. Read-only, best effort, never fatal.
#
# The URL is split into libpq variables rather than passed as an argument: the
# connection string carries the password and argv is visible to anyone who can
# run `ps`.
queue_report() {
  echo "--- provisioning queue ---"
  if ! command -v psql > /dev/null 2>&1; then
    echo "  (psql not installed — skipping; check with: database.js provisioning-report)"
    return 0
  fi
  local host port user dbname pass
  IFS=$'\t' read -r host port user dbname pass <<< "$(node -e '
    try {
      const u = new URL(process.env.DATABASE_URL);
      process.stdout.write([
        u.hostname, u.port || "5432",
        decodeURIComponent(u.username), u.pathname.slice(1),
        decodeURIComponent(u.password),
      ].join("\t"));
    } catch { process.stdout.write("\t\t\t\t"); }
  ')" || true
  if [ -z "${host:-}" ]; then
    echo "  (DATABASE_URL is not a URL this can parse — skipping)"
    return 0
  fi
  PGPASSWORD="$pass" psql --no-psqlrc --quiet \
    -h "$host" -p "$port" -U "$user" -d "$dbname" -c "
      SELECT job_type, status, count(*)
      FROM provisioning.provisioning_jobs GROUP BY 1,2 ORDER BY 1,2;
    " 2>/dev/null || echo "  (no provisioning queue reachable in this database yet)"
}

# ------------------------------------------------------------ check-env -----
# Answers "what do I need to set, and what is already set?" without changing
# anything. Secrets are reported as set/unset, never printed.
show_env() {
  local name="$1" note="$2" value="${!1:-}"
  if [ -n "$value" ]; then
    printf '  %-40s %-9s %s\n' "$name" "set" "$note"
  else
    printf '  %-40s %-9s %s\n' "$name" "MISSING" "$note"
  fi
}

check_env() {
  echo "=== you must set these ==="
  show_env POSTGRES_URL "-> DATABASE_URL. The only way Paperclip finds the database."
  echo
  echo "=== resolved from the above, or defaulted ==="
  printf '  %-40s %s\n' "DATABASE_URL" "${DATABASE_URL%%\?*}"
  printf '  %-40s %s\n' "PAPERCLIP_HOME" "$PAPERCLIP_HOME"
  printf '  %-40s %s\n' "PAPERCLIP_INSTANCE_ID" "$PAPERCLIP_INSTANCE_ID"
  printf '  %-40s %s\n' "PAPERCLIP_CONFIG" "$CONFIG_PATH"
  printf '  %-40s %s\n' "  (instance .env)" "$ENV_PATH"
  printf '  %-40s %s\n' "PORT (from PAPERCLIP_PORT)" "$PORT"
  printf '  %-40s %s\n' "PAPERCLIP_FQDN" "$PAPERCLIP_FQDN"
  printf '  %-40s %s\n' "PAPERCLIP_BASE_URL" "$PAPERCLIP_BASE_URL"
  printf '  %-40s %s\n' "PAPERCLIP_ALLOWED_HOSTNAMES" "$PAPERCLIP_ALLOWED_HOSTNAMES"
  printf '  %-40s %s\n' "LOG_DIR" "$LOG_DIR"
  printf '  %-40s %s\n' "PAPERCLIP_DB_BACKUP_DIR" "$PAPERCLIP_DB_BACKUP_DIR"
  printf '  %-40s %s\n' "PAPERCLIP_STORAGE_LOCAL_DIR" "$PAPERCLIP_STORAGE_LOCAL_DIR"
  printf '  %-40s %s\n' "PAPERCLIP_SECRETS_MASTER_KEY_FILE" "$PAPERCLIP_SECRETS_MASTER_KEY_FILE"
  if [ -n "${PAPERCLIP_AGENT_JWT_SECRET:-}" ]; then
    printf '  %-40s %s\n' "PAPERCLIP_AGENT_JWT_SECRET" "set (reused or generated; not printed)"
  fi
  echo
  echo "=== needed for anyone to sign in ==="
  show_env PAPERCLIP_PROXY_AUTH_ENABLED "must be 'true': provisioned users have no password."
  printf '  %-40s %-9s %s\n' "PAPERCLIP_PROXY_AUTH_USER_HEADER" \
    "${PAPERCLIP_PROXY_AUTH_USER_HEADER:-default}" "x-forwarded-user unless set"
  echo
  echo "=== must NOT be set / must be false ==="
  if [ -n "${PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN:-}" ]; then
    printf '  %-40s %-9s %s\n' "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN" "SET" "FATAL - deletes instance_admin rows"
  else
    printf '  %-40s %-9s %s\n' "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN" "unset" "correct"
  fi
  printf '  %-40s %-9s %s\n' "PAPERCLIP_PROXY_AUTH_AUTO_PROVISION" \
    "${PAPERCLIP_PROXY_AUTH_AUTO_PROVISION:-unset}" "must be false or unset"
  printf '  %-40s %-9s %s\n' "PAPERCLIP_PROVISIONING_WORKER_ENABLED" \
    "forced off" "boot 1 never provisions; entrypoint.sh sets it for boot 2"
  echo
  echo "=== optional ==="
  printf '  %-40s %s\n' "PAPERCLIP_CLI" "${PAPERCLIP_CLI:-(not set - using: ${PAPERCLIP_CMD[*]})}"
  printf '  %-40s %s\n' "PAPERCLIP_PUBLIC_URL" "${PAPERCLIP_PUBLIC_URL:-(not set)}"
  printf '  %-40s %s\n' "LOG_BASE_DIR" "$LOG_BASE_DIR"
}

case "$MODE" in
  check-env)    check_env; exit 0 ;;
  status)       engine_status || true; echo; queue_report; exit 0 ;;
  queue)        queue_report; exit 0 ;;
  check-engine)
    if [ "$WAIT_FOR_READY" = true ]; then
      deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
      while [ "$(date +%s)" -lt "$deadline" ]; do
        engine_status && exit 0
        sleep 2
      done
    fi
    engine_status; exit $? ;;
  apply-config)
    [ -f "$CONFIG_PATH" ] || { echo "no config at $CONFIG_PATH" >&2; exit 1; }
    apply_config_patches; exit 0 ;;
esac

check_gates

# ---------------------------------------------------------------- guard -----
# onboard preserves an existing config and applies none of the above.
if [ -f "$CONFIG_PATH" ]; then
  echo "config already exists at $CONFIG_PATH - onboard would be a no-op."
  echo "Remove or move it first to re-onboard with these values."
  echo
  queue_report
  exit 0
fi

# ---------------------------------------------------- persist the values ----
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
ensure_dir "$(dirname "$CONFIG_PATH")" "config directory"

# This rewrite truncates the file, so carry over every key the script does NOT
# manage — the published URLs, PAPERCLIP_PROXY_AUTH_*, whatever entrypoint.sh
# wrote, anything an operator added by hand. An allowlist was tried first and
# was the wrong shape: it silently dropped whatever nobody had thought to list.
#
# PAPERCLIP_PROVISIONING_WORKER_ENABLED is deliberately NOT managed here, so if
# entrypoint.sh has written it, it is preserved rather than overwritten with
# this script's boot-1 value.
MANAGED_ENV_KEYS="DATABASE_URL PAPERCLIP_DB_BACKUP_ENABLED PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES
PAPERCLIP_DB_BACKUP_RETENTION_DAYS PAPERCLIP_DB_BACKUP_DIR PAPERCLIP_LOG_DIR PORT SERVE_UI
PAPERCLIP_ALLOWED_HOSTNAMES PAPERCLIP_STORAGE_PROVIDER PAPERCLIP_STORAGE_LOCAL_DIR
PAPERCLIP_SECRETS_PROVIDER PAPERCLIP_SECRETS_STRICT_MODE PAPERCLIP_AGENT_JWT_SECRET
PAPERCLIP_SECRETS_MASTER_KEY_FILE"
PRESERVED_ENV=""
if [ -f "$ENV_PATH" ]; then
  PRESERVED_ENV="$(awk -v managed="$MANAGED_ENV_KEYS" '
    BEGIN { n = split(managed, list, /[ \t\n]+/); for (i = 1; i <= n; i++) if (list[i] != "") seen[list[i]] = 1 }
    /^[A-Za-z_][A-Za-z0-9_]*=/ { key = $0; sub(/=.*/, "", key); if (!(key in seen)) print }
  ' "$ENV_PATH")"
fi

cat > "$ENV_PATH" <<EOF
# Generated by onboard-paperclip-1-new.sh
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
PAPERCLIP_SECRETS_MASTER_KEY_FILE=$PAPERCLIP_SECRETS_MASTER_KEY_FILE
PAPERCLIP_AGENT_JWT_SECRET=$PAPERCLIP_AGENT_JWT_SECRET
EOF
if [ -n "$PRESERVED_ENV" ]; then
  printf '\n# Preserved from the previous .env - not managed by this script\n' >> "$ENV_PATH"
  printf '%s\n' "$PRESERVED_ENV" >> "$ENV_PATH"
fi
chmod 600 "$ENV_PATH"

# ---------------------------------------------------- run onboard, then stop --
# `onboard --yes` writes the config and then starts the server in the FOREGROUND
# and never returns (shouldRunNow in cli/src/commands/onboard.ts; no flag
# overrides it). Run it in its own process group, poll /api/health until it is
# up — which also means migrations finished, and stopping earlier can interrupt
# one — then signal the group.
#
# The server is deliberately left STOPPED. supervisord/systemd starts the real
# one afterwards, and THAT is boot 2, the one with the provisioning flag on.
echo "Using CLI:    ${PAPERCLIP_CMD[*]}"
echo "Database:     ${DATABASE_URL%%\?*}"
echo "Config:       $CONFIG_PATH"
echo "Provisioning: DISABLED for this run (boot 1)"
echo

ONBOARD_RC=0
ONBOARD_LOG="$(mktemp "${TMPDIR:-/tmp}/paperclip-onboard-new.XXXXXX.log")"
ONBOARD_READY_TIMEOUT="${ONBOARD_READY_TIMEOUT:-900}"

echo "Running onboard (server will be started, then stopped automatically)..."
echo "  log: $ONBOARD_LOG"

# setsid gives onboard its own process group, so the stop below reaches the node
# server AND anything it spawned, without ever signalling this script.
if command -v setsid > /dev/null 2>&1; then
  setsid "${PAPERCLIP_CMD[@]}" onboard --config "$CONFIG_PATH" --yes --bind lan \
    > "$ONBOARD_LOG" 2>&1 &
else
  "${PAPERCLIP_CMD[@]}" onboard --config "$CONFIG_PATH" --yes --bind lan \
    > "$ONBOARD_LOG" 2>&1 &
fi
ONBOARD_PID=$!

onboard_ready=false
deadline=$(( $(date +%s) + ONBOARD_READY_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$ONBOARD_PID" 2>/dev/null; then
    wait "$ONBOARD_PID" 2>/dev/null || ONBOARD_RC=$?
    echo "  onboard exited on its own (status ${ONBOARD_RC})"
    break
  fi
  if [ "$(health_field status)" = "ok" ]; then
    onboard_ready=true
    echo "  server is up — config written and migrations applied"
    break
  fi
  sleep 2
done

if [ "$onboard_ready" = true ]; then
  # Signal the process group (negative pid). SIGINT first because node has no
  # handler and exits cleanly on it; escalate only if something is still alive.
  echo "  stopping the onboarding server..."
  kill -INT -"$ONBOARD_PID" 2>/dev/null || kill -INT "$ONBOARD_PID" 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$ONBOARD_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$ONBOARD_PID" 2>/dev/null; then
    echo "  still running after SIGINT — sending SIGTERM"
    kill -TERM -"$ONBOARD_PID" 2>/dev/null || kill -TERM "$ONBOARD_PID" 2>/dev/null || true
    sleep 3
    kill -KILL -"$ONBOARD_PID" 2>/dev/null || true
  fi
  wait "$ONBOARD_PID" 2>/dev/null || true
  echo "  stopped"
elif [ "$ONBOARD_RC" = 0 ] && ! [ -f "$CONFIG_PATH" ]; then
  echo "onboard never reported a healthy server within ${ONBOARD_READY_TIMEOUT}s." >&2
  echo "  see $ONBOARD_LOG" >&2
fi

echo "--- last 20 lines of onboard output ---"
tail -20 "$ONBOARD_LOG" 2>/dev/null || true
echo "---"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "onboard exited ${ONBOARD_RC} without writing $CONFIG_PATH - nothing to patch." >&2
  exit 1
fi

apply_config_patches

echo
echo "Onboarded: config=$CONFIG_PATH logs=$LOG_DIR backups=$PAPERCLIP_DB_BACKUP_DIR"
echo "Password signup is disabled and telemetry is off."

# ------------------------------------------------------------ next steps ----
# No invite, no claim, no owner. That is the difference, and it is deliberate:
# every one of those now arrives from the queue on boot 2.
echo
queue_report
echo
echo "--- engine ---"
engine_status || true
echo
echo "Boot 1 complete. NOTHING has been provisioned — no user, no company, no"
echo "membership, no invite. The queue above is untouched and is what boot 2"
echo "will apply."
echo
echo "Boot 2 — start the engine with the provisioning worker on:"
echo "  PAPERCLIP_PROVISIONING_WORKER_ENABLED=true \\"
echo "  PAPERCLIP_CONFIG=\"$CONFIG_PATH\" ${PAPERCLIP_CMD[*]} run"
echo
echo "Expect 'provisioning: worker enabled' then one 'provisioning: job applied'"
echo "line per row. An empty queue is fine — it logs 'nothing queued yet' and"
echo "keeps polling, and the rows land whenever they arrive."
