#!/usr/bin/env bash
# Paperclip onboarding, step 1 of 2 — install the instance and settle ownership.
#
# onboard has no per-value flags: --yes selects quickstart (no prompts) and every
# value comes from the environment (ONBOARD_ENV_KEYS in cli/src/commands/onboard.ts).
#
# Usage:
#   ./onboard-paperclip-1.sh                    # onboard this host
#   ./onboard-paperclip-1.sh --check-engine     # is the engine running? (add --wait to poll)
#   ./onboard-paperclip-1.sh --status           # engine + release + claim state
#   ./onboard-paperclip-1.sh --release          # which release is linked, and running
#   ./onboard-paperclip-1.sh --claim-admin --owner-email <email>
#   ./onboard-paperclip-1.sh --set-owner   --owner-email <email>
#   ./onboard-paperclip-1.sh --apply-config     # re-apply config patches to an install
#   ./onboard-paperclip-1.sh --lock-signup      # close signup once the CEO has claimed
#
# Flags: --owner-email <email>   --timeout <seconds>   --wait   --force
#
# THE ENGINE IS LEFT STOPPED when onboarding finishes. This script starts one
# only long enough to write the config and run migrations, then stops it again;
# starting the real one belongs to whatever supervises this host. Step 2 cannot
# do anything without a running engine, so start it and confirm with
# --check-engine before running onboard-paperclip-2.sh.
#
# Getting the first instance admin, and why it looks like this. In
# authenticated/private mode the server exposes POST /api/bootstrap/claim
# (server/src/routes/access.ts), which makes ANY signed-in browser user the
# first instance admin - no invite token needed, first come first served. That
# route requires a real browser session, so it cannot be scripted at all.
#
# Two headless paths exist instead, and they are NOT the same thing:
#
#   --claim-admin  first-come-first-served, like the browser route. Grants
#                  instance_admin only while nobody holds it, and refuses to
#                  reassign. The right call for a first claim.
#   --set-owner    authoritative. Makes one email the SOLE instance_admin,
#                  removes any other holder, and revokes every live bootstrap
#                  invite so the ownership link cannot be redeemed afterwards.
#                  Idempotent. Step 2 calls this on every run.
#
# Both need proxy auth on (PAPERCLIP_PROXY_AUTH_ENABLED=true) to provision the
# account, and psql to reach the database. Both write instance_user_roles
# directly, which is safe because claimFirstInstanceAdmin does exactly that and
# nothing else - there are no memberships or grants to keep in step.
#
# A bootstrap_ceo invite link is still minted and saved as a browser fallback
# for when proxy auth is off. Treat it as a credential: anyone holding it can
# claim ownership until it is used, expires, or --set-owner revokes it.
set -euo pipefail

MODE="onboard"
FORCE_LOCK=false
WAIT_FOR_READY=false
CLAIM_EMAIL="${ONBOARD_OWNER_EMAIL:-}"
WAIT_TIMEOUT="${ONBOARD_WAIT_TIMEOUT:-120}"
while [ $# -gt 0 ]; do
  case "$1" in
    --lock-signup) MODE="lock-signup"; shift ;;
    --apply-config) MODE="apply-config"; shift ;;
    --force) FORCE_LOCK=true; shift ;;
    --wait) WAIT_FOR_READY=true; shift ;;
    --status) MODE="status"; shift ;;
    --check-engine) MODE="check-engine"; shift ;;
    --release) MODE="release"; shift ;;
    --claim-admin) MODE="claim-admin"; shift ;;
    --set-owner) MODE="set-owner"; shift ;;
    --owner-email) CLAIM_EMAIL="${2:?--owner-email needs a value}"; shift 2 ;;
    --timeout) WAIT_TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
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
CONFIG_PATH="${PAPERCLIP_CONFIG:-/sysops/config/paperclip/config.json}"
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
# PAPERCLIP_PORT is what the container exports and what paperclip-run.sh
# starts the engine on, so derive PORT from it rather than repeating the
# number here - a hardcoded 3100 silently probes the wrong port the moment
# the deployment moves, and every health check then reports NOT RUNNING.
export PORT="${PAPERCLIP_PORT:-3100}"

# No browser, ever. This script runs at container start where there is no
# display and nothing to open a browser with. Two CLI paths would otherwise try:
# the dashboard opener after a service install (cli/src/onboard-service.ts:111)
# and `auth login`'s xdg-open (cli/src/client/board-auth.ts:183). Both check
# PAPERCLIP_NO_BROWSER, so setting it here disables both.
# The onboard run below is already non-interactive, but that relies on stdio not
# being a tty — this does not, so it holds however the script is invoked.
export PAPERCLIP_NO_BROWSER=1
export SERVE_UI=true

# The public name callers use to reach this host. It seeds the bootstrap invite
# URL and the hostname allowlist, so a browser hitting that name is not rejected.
export PAPERCLIP_FQDN="${PAPERCLIP_FQDN:-$(hostname -f)}"

# PAPERCLIP_PUBLIC_URL, PAPERCLIP_API_URL and PAPERCLIP_RUNTIME_API_URL describe
# how this deployment publishes itself. They are set outside this script and are
# authoritative - it never assigns them, and must not override them here.
#
# That matters for the invite: an explicit --base-url is resolved BEFORE
# PAPERCLIP_PUBLIC_URL (resolveBaseUrl in cli/src/commands/auth-bootstrap-ceo.ts),
# so passing a derived URL unconditionally would quietly beat the published one.
# Hence the order below - PAPERCLIP_FQDN only fills the gap when no public URL
# has been set. PAPERCLIP_BASE_URL stays available for a one-off override, e.g.
# a reverse proxy terminating TLS: PAPERCLIP_BASE_URL=https://paperclip.example.com
PAPERCLIP_BASE_URL="${PAPERCLIP_BASE_URL:-${PAPERCLIP_PUBLIC_URL:-http://$PAPERCLIP_FQDN:$PORT}}"

#export PAPERCLIP_ALLOWED_HOSTNAMES="$(hostname -s),$(hostname -f)"
export PAPERCLIP_ALLOWED_HOSTNAMES="${PAPERCLIP_ALLOWED_HOSTNAMES:-$(hostname -s),$(hostname -f),127.0.0.1}"
# The invite URL hands out PAPERCLIP_FQDN, so that name has to be allowed even
# when the list was supplied by the caller - otherwise the server rejects the
# very hostname this script just told the operator to use.
case ",$PAPERCLIP_ALLOWED_HOSTNAMES," in
  *",$PAPERCLIP_FQDN,"*) ;;
  *) export PAPERCLIP_ALLOWED_HOSTNAMES="$PAPERCLIP_ALLOWED_HOSTNAMES,$PAPERCLIP_FQDN" ;;
esac

# ------------------------------------------------ storage + secrets ---------
export PAPERCLIP_STORAGE_PROVIDER=local_disk
export PAPERCLIP_STORAGE_LOCAL_DIR="$INSTANCE_ROOT/data/storage"
export PAPERCLIP_SECRETS_PROVIDER=local_encrypted
export PAPERCLIP_SECRETS_STRICT_MODE=false

# The master key for the local_encrypted provider, kept beside config.json and
# .env rather than under the instance root. It is not instance state: losing it
# makes every stored secret permanently undecryptable, so it belongs with the
# files that are deliberately preserved, next to the JWT secret that is already
# in .env. onboard honours this env var (ONBOARD_ENV_KEYS in
# cli/src/commands/onboard.ts), so a fresh install writes the key here directly
# and nothing has to be moved afterwards.
export PAPERCLIP_SECRETS_MASTER_KEY_FILE="${PAPERCLIP_SECRETS_MASTER_KEY_FILE:-$(dirname "$CONFIG_PATH")/secrets/master.key}"

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

# ------------------------------------------- post-onboard config patches ----
# Applied after onboarding, and re-appliable to an existing install with
# --apply-config. None of these have an onboard env var, so they are written to
# the config file directly. Kept in one function so the two callers cannot drift.
#
#   logging.logDir      quickstart hardcodes <instanceRoot>/logs; use LOG_DIR
#   auth.disableSignUp  no password self-registration on this instance
#   telemetry.enabled   off
#
# Closing signup is only safe because the trusted proxy provisions users:
# resolveProxyHeaderUser inserts into authUsers directly, bypassing Better Auth,
# so disableSignUp does not block it (server/src/auth/proxy-header-auth.ts).
# With proxy auth off this leaves NO way to create the first account, hence the
# warning below.
apply_config_patches() {
  # Pointing logging.logDir at a directory that does not exist leaves the server
  # unable to write logs; create it here rather than finding out at startup.
  if ! mkdir -p "$LOG_DIR" 2>/dev/null || [ ! -w "$LOG_DIR" ]; then
    echo "WARNING: log directory $LOG_DIR is not writable by $(id -un)." >&2
    echo "         Fix: sudo install -d -o \"$(id -un)\" -g \"$(id -gn)\" \"$LOG_DIR\"" >&2
  fi

  # Secrets key: create the directory private, then MOVE any existing key before
  # the config is repointed. The other order is destructive - the CLI would find
  # no key at the new path, generate a fresh one, and every secret encrypted
  # under the old key would be unrecoverable.
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

  if [ "${PAPERCLIP_PROXY_AUTH_ENABLED:-}" != "true" ]; then
    echo "WARNING: PAPERCLIP_PROXY_AUTH_ENABLED is not 'true' in this environment." >&2
    echo "         Signup is now disabled and nothing else provisions users, so no" >&2
    echo "         new account can be created until proxy auth is on." >&2
  fi
}

# ------------------------------------------------------- apply config mode ---
# Re-applies the patches above without re-onboarding. The normal path exits
# early when a config already exists, so this is how an existing install picks
# up changed values (a moved log directory, telemetry, signup).
if [ "$MODE" = "apply-config" ]; then
  [ -f "$CONFIG_PATH" ] || {
    echo "No config at $CONFIG_PATH - run this script without --apply-config first." >&2
    exit 1
  }
  cp -p "$CONFIG_PATH" "$CONFIG_PATH.bak"
  apply_config_patches
  echo "Previous config saved to $CONFIG_PATH.bak"
  echo "Restart the server for it to take effect:"
  echo "  PAPERCLIP_CONFIG=\"$CONFIG_PATH\" ${PAPERCLIP_CMD[*]} run"
  exit 0
fi

# --------------------------------------------------- health / claim helpers --
# /api/health is unauthenticated and reports bootstrapStatus:
#   "bootstrap_pending" -> no instance_admin exists yet
#   "ready"             -> one does; script 2 can run
# That field is the contract between this script and onboard-paperclip-2.sh.
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

wait_for_server() {
  local deadline=$(( $(date +%s) + WAIT_TIMEOUT )) status
  echo "Waiting up to ${WAIT_TIMEOUT}s for the server on $LOCAL_API ..."
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(health_field status)"
    if [ "$status" = "ok" ]; then
      echo "  server is up (bootstrapStatus=$(health_field bootstrapStatus))"
      return 0
    fi
    sleep 2
  done
  echo "  server did not become healthy within ${WAIT_TIMEOUT}s (last status: ${status:-unreachable})" >&2
  return 1
}

# --------------------------------------------------------- engine check -----
# "Is the engine actually running?" - one probe that answers it properly, used
# both as a report (--status, --check-engine) and as a gate.
#
# /api/health is the right source, and its `status` field says more than a TCP
# connect ever could: the route answers status:"unhealthy" with
# error:"database_unreachable" when the process is up but Postgres is not
# (server/src/routes/health.ts). So status:"ok" has proved BOTH halves - the
# process is listening AND the database is reachable - which is exactly the
# precondition step 2 needs. "It answered the port" is not the same claim.
#
# Returns 0 only when the engine is running and healthy.
json_field() {
  # json_field <json> <field> - empty string when absent or unparseable.
  printf '%s' "$1" | node -e '
    let raw = ""; const f = process.argv[1];
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw)[f] ?? "")); }
      catch { process.stdout.write(""); }
    });
  ' "$2" 2>/dev/null || true
}

engine_status() {
  local json status bs err commit mode exposure
  json="$(curl -fsS --max-time 5 "$LOCAL_API/api/health" 2>/dev/null || true)"

  if [ -z "$json" ]; then
    echo "engine:          NOT RUNNING"
    echo "  nothing answered $LOCAL_API/api/health"
    echo "  Start it however this host does, or directly:"
    echo "    PAPERCLIP_CONFIG=\"$CONFIG_PATH\" ${PAPERCLIP_CMD[*]} run"
    echo "  Then confirm with: $0 --check-engine"
    return 1
  fi

  status="$(json_field "$json" status)"
  bs="$(json_field "$json" bootstrapStatus)"
  commit="$(json_field "$json" commit)"
  mode="$(json_field "$json" deploymentMode)"
  exposure="$(json_field "$json" deploymentExposure)"

  if [ "$status" != "ok" ]; then
    err="$(json_field "$json" error)"
    echo "engine:          RUNNING but UNHEALTHY (status=${status:-unknown})"
    [ -n "$err" ] && echo "  error:         $err"
    if [ "$err" = "database_unreachable" ]; then
      echo "  The process is listening, but Postgres is not answering it. Nothing"
      echo "  in step 2 can work until that is fixed - every step is a database write."
    fi
    return 1
  fi

  echo "engine:          RUNNING and healthy   ($LOCAL_API)"
  echo "  deployment:    ${mode:-unknown}/${exposure:-unknown}"
  echo "  commit:        ${commit:-unknown}"
  echo "  bootstrap:     ${bs:-unknown}$([ "$bs" = "bootstrap_pending" ] && printf '%s' "   (no instance_admin yet)" || true)"
  return 0
}

# Grant instance_admin without a browser.
#
# This is the headless equivalent of the browser claim route. It is safe to do
# in SQL because claimFirstInstanceAdmin (server/src/first-admin-claim.ts) does
# exactly one thing: insert a single instance_user_roles row, only when no
# instance_admin exists. There are no memberships or grants to keep in step.
# The NOT EXISTS makes it idempotent and preserves first-come-first-served.
#
# The user row itself is created by proxy-header auth: one authenticated GET
# with the user header auto-provisions it when
# PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true. Letting the app do that keeps
# schema knowledge for `user` out of this script.
claim_admin() {
  local email="$1"
  [ -n "$email" ] || { echo "claim-admin needs --owner-email" >&2; return 1; }
  command -v psql > /dev/null 2>&1 || { echo "psql is required for --claim-admin" >&2; return 1; }

  local cs
  cs="$(node -e "
    try { const c = require('$CONFIG_PATH');
      process.stdout.write(c.database?.connectionString ?? ''); } catch { process.stdout.write(''); }
  ")"
  [ -n "$cs" ] || { echo "no database connectionString in $CONFIG_PATH" >&2; return 1; }

  local hdr="${PAPERCLIP_PROXY_AUTH_USER_HEADER:-x-forwarded-user}"
  if [ "${PAPERCLIP_PROXY_AUTH_ENABLED:-}" != "true" ]; then
    echo "PAPERCLIP_PROXY_AUTH_ENABLED is not 'true'; cannot auto-provision '$email'." >&2
    echo "  Enable proxy auth, or create the account another way first." >&2
    return 1
  fi

  # Provision the user. Any authenticated route runs the actor middleware; the
  # response code does not matter, only that the header was seen.
  curl -sS -o /dev/null --max-time 10 "$LOCAL_API/api/companies" -H "$hdr: $email" || true

  # The email is bound as a psql variable rather than interpolated. :'email' is
  # quoted and escaped by psql itself, so an apostrophe in an address is a
  # character rather than syntax - the same rule the CLI reference states for
  # jq-built payloads, applied to SQL.
  #
  # The SQL goes in on STDIN, not through -c. psql only performs variable
  # interpolation on input it reads through its own lexer (stdin or -f); with
  # -c the string is handed to the server verbatim, so :'email' arrives as
  # literal SQL and the server answers `syntax error at or near ":"`. That
  # error was then swallowed by 2>/dev/null and surfaced as the wrong
  # diagnosis - "no user row for <email>" - for an account that did exist.
  local uid uid_err
  uid_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-uid.XXXXXX")"
  uid="$(psql "$cs" -v ON_ERROR_STOP=1 -v email="$email" -tA 2>"$uid_err" <<'SQL' | tr -d '[:space:]'
select id from "user" where lower(email) = lower(:'email') limit 1;
SQL
)"
  # A query that ERRORED and a query that matched nothing both come back empty.
  # Telling them apart is the whole difference between "this account has not
  # been provisioned yet" and "the statement never reached the table".
  if [ -s "$uid_err" ]; then
    echo "the user lookup failed:" >&2
    sed 's/^/    /' "$uid_err" >&2
    rm -f "$uid_err"
    return 1
  fi
  rm -f "$uid_err"
  if [ -z "$uid" ]; then
    echo "'$email' still has no user row after a proxy-auth request." >&2
    echo "  Check PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true and PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS." >&2
    return 1
  fi

  # ON_ERROR_STOP and a checked exit status. This used to swallow every failure
  # into /dev/null, and `set -e` is no help: the function is called as
  # `claim_admin ... || exit 1`, which disables errexit for its entire body.
  if ! psql "$cs" -v ON_ERROR_STOP=1 -v uid="$uid" -qA > /dev/null 2>&1 <<'SQL'
insert into instance_user_roles (user_id, role)
  select :'uid', 'instance_admin'
  where not exists (select 1 from instance_user_roles where role = 'instance_admin');
SQL
  then
    echo "the database refused the instance_admin grant." >&2
    echo "  Nothing was changed. Check the connection string in $CONFIG_PATH." >&2
    return 1
  fi

  local holder
  holder="$(psql "$cs" -tAc "select u.email from instance_user_roles r join \"user\" u on u.id = r.user_id
      where r.role = 'instance_admin' limit 1;" 2>/dev/null | tr -d '[:space:]')"
  if [ "$(printf '%s' "$holder" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$email" | tr 'A-Z' 'a-z')" ]; then
    echo "instance_admin: $holder"
    return 0
  fi
  echo "instance_admin is already held by '${holder:-unknown}', not '$email'." >&2
  echo "  The claim is first-come-first-served and was not reassigned." >&2
  return 1
}

# ------------------------------------------------------- release awareness ---
# This host carries several installed releases side by side and /vhome/paperclip
# is what PAPERCLIP_CLI resolves through, so "which Paperclip am I driving?" has
# a real answer that is easy to get wrong. It already cost a debugging round:
# the symlink pointed at an older release whose CLI force-set
# PAPERCLIP_OPEN_ON_LISTEN=true, so onboarding opened a browser that no
# environment variable could suppress — fixed in newer builds (#12435).
#
# Report it rather than assume it. `newest` is by directory mtime, which is how
# these are laid down; it is a hint, not a version comparison.
RELEASE_DIR_ROOT="${PAPERCLIP_RELEASE_ROOT:-/install/paperclip}"
PAPERCLIP_LINK="${PAPERCLIP_LINK:-/vhome/paperclip}"

report_release() {
  local linked newest
  linked="$(readlink -f "$PAPERCLIP_LINK" 2>/dev/null || echo '<unresolved>')"
  newest="$(ls -1dt "$RELEASE_DIR_ROOT"/*/ 2>/dev/null | head -1)"
  newest="${newest%/}"

  echo "release link:    $PAPERCLIP_LINK -> ${linked##*/}"
  echo "newest on disk:  ${newest##*/}"
  if [ -n "$newest" ] && [ "$linked" != "$newest" ]; then
    echo "  WARNING: the link is NOT the newest installed release."
    echo "           Repoint it if that is not deliberate:"
    echo "             sudo supervisorctl stop paperclip"
    echo "             sudo ln -sfn $newest $PAPERCLIP_LINK"
    echo "             sudo supervisorctl start paperclip"
  fi

  # The CLI the scripts actually invoke, and whether it still carries the
  # force-open-browser bug. Cheap, and it is the concrete symptom people hit.
  local cli_dist="$linked/node_modules/paperclipai/dist/index.js"
  if [ -f "$cli_dist" ]; then
    if grep -q 'PAPERCLIP_OPEN_ON_LISTEN = "true"' "$cli_dist" 2>/dev/null; then
      echo "  WARNING: this release forces PAPERCLIP_OPEN_ON_LISTEN=true — onboarding"
      echo "           will open a browser and no env var can stop it. Use a newer release."
    fi
  fi

  # What the *running* server reports, which can differ from the link if it has
  # not been restarted since a repoint.
  local commit
  # The braces + `|| true` matter: this script runs under `set -euo pipefail`,
  # so an unreachable server made curl fail the pipeline and abort the whole
  # function before it could print anything. A reporting helper must never be
  # able to kill its caller.
  commit="$( { curl -fsS --max-time 3 "$LOCAL_API/api/health" 2>/dev/null || true; } \
    | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(r).commit||"unknown"))}catch{process.stdout.write("unreachable")}})' 2>/dev/null || true)"
  echo "running commit:  ${commit:-unreachable}"
  if [ "$commit" = "unreachable" ]; then
    echo "  (server not answering — start it, or it has not restarted since the repoint)"
  fi
}

# ----------------------------------------------------------- release mode ---
if [ "$MODE" = "release" ]; then
  report_release
  exit 0
fi

# ------------------------------------------------------ check engine mode ---
# The single question step 2 depends on. Exits 0 when the engine is up and
# healthy, 1 when it is not, so a test loop can gate on it:
#   ./onboard-paperclip-1.sh --check-engine && ./onboard-paperclip-2.sh ...
# --wait polls until it comes up instead of answering immediately.
if [ "$MODE" = "check-engine" ]; then
  [ "$WAIT_FOR_READY" = false ] || wait_for_server || true
  if engine_status; then
    case "$(health_field bootstrapStatus)" in
      ready)             echo "next: ./onboard-paperclip-2.sh --owner-email <email>" ;;
      bootstrap_pending) echo "next: $0 --set-owner --owner-email <email>   (or run step 2, which does it)" ;;
    esac
    exit 0
  fi
  exit 1
fi

# Make one email the sole instance_admin, and close the door behind it.
#
# --claim-admin is first-come-first-served: it only acts when nobody holds the
# role. That is right for a first claim, but it leaves two open questions once
# onboarding is scripted:
#
#   * script 1 mints a bootstrap_ceo invite link. Anyone holding that link can
#     claim ownership until it is used or expires.
#   * if someone already claimed, --claim-admin silently leaves them in place.
#
# lock_owner settles both: the named email ends up holding instance_admin, any
# other holder is removed, and every live bootstrap invite is revoked so the
# link cannot be redeemed afterwards. Idempotent — safe to run every time.
lock_owner() {
  local email="$1"
  [ -n "$email" ] || { echo "lock_owner needs an email" >&2; return 1; }
  command -v psql > /dev/null 2>&1 || { echo "psql is required" >&2; return 1; }

  local cs
  cs="$(node -e "
    try { const c = require('$CONFIG_PATH');
      process.stdout.write(c.database?.connectionString ?? ''); } catch { process.stdout.write(''); }
  ")"
  [ -n "$cs" ] || { echo "no database connectionString in $CONFIG_PATH" >&2; return 1; }

  local hdr="${PAPERCLIP_PROXY_AUTH_USER_HEADER:-x-forwarded-user}"
  if [ "${PAPERCLIP_PROXY_AUTH_ENABLED:-}" = "true" ]; then
    # Provision the account if it has never been seen. Harmless if it exists.
    curl -sS -o /dev/null --max-time 10 "$LOCAL_API/api/companies" -H "$hdr: $email" || true
  fi

  # The email is bound as a psql variable rather than interpolated. :'email' is
  # quoted and escaped by psql itself, so an apostrophe in an address is a
  # character rather than syntax - the same rule the CLI reference states for
  # jq-built payloads, applied to SQL.
  #
  # The SQL goes in on STDIN, not through -c. psql only performs variable
  # interpolation on input it reads through its own lexer (stdin or -f); with
  # -c the string is handed to the server verbatim, so :'email' arrives as
  # literal SQL and the server answers `syntax error at or near ":"`. That
  # error was then swallowed by 2>/dev/null and surfaced as the wrong
  # diagnosis - "no user row for <email>" - for an account that did exist.
  local uid uid_err
  uid_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-uid.XXXXXX")"
  uid="$(psql "$cs" -v ON_ERROR_STOP=1 -v email="$email" -tA 2>"$uid_err" <<'SQL' | tr -d '[:space:]'
select id from "user" where lower(email) = lower(:'email') limit 1;
SQL
)"
  # A query that ERRORED and a query that matched nothing both come back empty.
  # Telling them apart is the whole difference between "this account has not
  # been provisioned yet" and "the statement never reached the table".
  if [ -s "$uid_err" ]; then
    echo "the user lookup failed:" >&2
    sed 's/^/    /' "$uid_err" >&2
    rm -f "$uid_err"
    return 1
  fi
  rm -f "$uid_err"
  if [ -z "$uid" ]; then
    echo "no user row for '$email' — cannot make them the owner." >&2
    echo "  With proxy auth on, one authenticated request creates it." >&2
    return 1
  fi

  local before
  before="$(psql "$cs" -tAc "select coalesce(string_agg(u.email, ','), '(none)')
      from instance_user_roles r join \"user\" u on u.id = r.user_id
      where r.role = 'instance_admin';" 2>/dev/null | tr -d '[:space:]')"

  # Grant and remove in ONE transaction, with ON_ERROR_STOP and a checked exit
  # status.
  #
  # As two separate unchecked statements this could leave the instance with no
  # admin at all: a silently failing grant did not stop the delete, which then
  # removed every existing holder. `set -e` never caught it either, because the
  # function is called as `lock_owner ... || exit 1` and errexit is disabled for
  # the whole body of a function invoked that way. A transaction makes the
  # ordering argument true instead of merely intended.
  if ! psql "$cs" -v ON_ERROR_STOP=1 -v uid="$uid" -qA > /dev/null 2>&1 <<'SQL'
begin;
insert into instance_user_roles (user_id, role)
  values (:'uid', 'instance_admin')
  on conflict do nothing;
delete from instance_user_roles
  where role = 'instance_admin' and user_id <> :'uid';
commit;
SQL
  then
    echo "could not reassign instance_admin — the database refused the change." >&2
    echo "  Nothing was removed: the grant and the removal are one transaction," >&2
    echo "  so the previous holder is still in place." >&2
    return 1
  fi

  # Revoke every live bootstrap invite: the link script 1 printed is a standing
  # offer of ownership to whoever holds it.
  local revoked
  revoked="$(psql "$cs" -tAc "with revoked as (
        update invites set revoked_at = now(), updated_at = now()
        where invite_type = 'bootstrap_ceo' and revoked_at is null and accepted_at is null
        returning 1)
      select count(*) from revoked;" 2>/dev/null | tr -d '[:space:]')"

  local after
  after="$(psql "$cs" -tAc "select coalesce(string_agg(u.email, ','), '(none)')
      from instance_user_roles r join \"user\" u on u.id = r.user_id
      where r.role = 'instance_admin';" 2>/dev/null | tr -d '[:space:]')"

  # Report what the database now holds, not what was asked for. After a
  # successful transaction there is exactly one holder and it is this email;
  # anything else means the change did not take.
  if [ "$(printf '%s' "$after" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$email" | tr 'A-Z' 'a-z')" ]; then
    echo "instance_admin reads '$after' after the change, expected '$email'." >&2
    return 1
  fi

  echo "instance_admin: $after"
  [ "$before" != "$after" ] && echo "  (was: $before)"
  [ "${revoked:-0}" != "0" ] && echo "  revoked ${revoked} live bootstrap invite(s) — the ownership link no longer works"
  return 0
}

# Preconditions shared by the modes that touch the database directly.
# Both used to fail as a silent two-minute wait; the cause is knowable up front.
require_instance() {
  if [ ! -f "$CONFIG_PATH" ]; then
    echo "No config at $CONFIG_PATH — this instance has not been onboarded." >&2
    echo "  A --factory reset removes it." >&2
    echo >&2
    # The mode flags REPLACE onboarding rather than preceding it, and reading
    # "--claim-admin" as "onboard, then claim" is the natural mistake: it is one
    # script, so a flag looks additive. It is not - this branch exits long
    # before the onboard code at the bottom of the file. Say so here, where the
    # wrong assumption actually shows up.
    echo "  Note: '$MODE' is a MODE, not an extra step - it replaces onboarding" >&2
    echo "  rather than running before it. Onboard first, with no flags at all:" >&2
    echo >&2
    echo "    ./onboard-paperclip-1.sh                 # writes config, migrates, stops" >&2
    echo "    <start the engine>                       # $MODE needs one running" >&2
    echo "    ./onboard-paperclip-1.sh --check-engine" >&2
    echo "    ./onboard-paperclip-1.sh --$MODE --owner-email <email>" >&2
    if [ "$MODE" = "claim-admin" ]; then
      echo >&2
      echo "  Though you probably do not need --claim-admin at all: step 2 calls" >&2
      echo "  --set-owner itself on every run, so ./run-test.sh covers this." >&2
    fi
    return 1
  fi
  local cs
  cs="$(node -e "
    try { const c = require('$CONFIG_PATH');
      process.stdout.write(c.database?.connectionString ?? ''); } catch { process.stdout.write(''); }
  ")"
  if [ -z "$cs" ]; then
    echo "No database connectionString in $CONFIG_PATH — cannot reach the database." >&2
    return 1
  fi
  if ! psql "$cs" -tAc "select 1;" > /dev/null 2>&1; then
    echo "Cannot reach the database named in $CONFIG_PATH." >&2
    echo "  Is the Postgres container up?" >&2
    return 1
  fi
  return 0
}

# -------------------------------------------------------- set owner mode ---
if [ "$MODE" = "set-owner" ]; then
  require_instance || exit 1
  # The server is only needed to auto-provision an unknown email. If the user
  # already exists, ownership is pure database work and the server can stay down.
  if [ "$(health_field status)" != "ok" ]; then
    echo "Engine is not answering on $LOCAL_API." >&2
    echo "  Ownership is a database operation, so this still works IF the account" >&2
    echo "  already exists. If '$CLAIM_EMAIL' has never signed in, the account has" >&2
    echo "  to be provisioned first, which needs the engine up: start it, then" >&2
    echo "    $0 --check-engine" >&2
  fi
  lock_owner "$CLAIM_EMAIL" || exit 1
  echo "bootstrapStatus: $(health_field bootstrapStatus)"
  exit 0
fi

# ------------------------------------------------------------ status mode ---
if [ "$MODE" = "status" ]; then
  report_release
  echo
  engine_status || true
  echo
  bs="$(health_field bootstrapStatus)"
  case "$bs" in
    ready)             echo "next: ./onboard-paperclip-2.sh --owner-email <email>" ;;
    bootstrap_pending) echo "next: $0 --claim-admin --owner-email <email>" ;;
    *)                 echo "next: start the engine, then re-run $0 --status" ;;
  esac
  exit 0
fi

# ------------------------------------------------------- claim admin mode ---
if [ "$MODE" = "claim-admin" ]; then
  require_instance || exit 1
  [ "$(health_field status)" = "ok" ] || wait_for_server || exit 1
  if [ "$(health_field bootstrapStatus)" = "ready" ]; then
    echo "Instance already claimed; nothing to do."
    exit 0
  fi
  claim_admin "$CLAIM_EMAIL" || exit 1
  echo "bootstrapStatus: $(health_field bootstrapStatus)"
  exit 0
fi

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
        echo "  Sign in at $PAPERCLIP_BASE_URL and claim it first." >&2
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
# This rewrite truncates the file, so carry over every key the script does NOT
# manage itself - the published URLs, PAPERCLIP_PROXY_AUTH_*, anything an
# operator added by hand. An allowlist was tried first and was the wrong shape:
# it silently dropped whatever nobody had thought to list, which is exactly how
# a working deployment setting disappears during a re-onboard.
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
PAPERCLIP_SECRETS_MASTER_KEY_FILE=$PAPERCLIP_SECRETS_MASTER_KEY_FILE
PAPERCLIP_AGENT_JWT_SECRET=$PAPERCLIP_AGENT_JWT_SECRET
EOF
if [ -n "$PRESERVED_ENV" ]; then
  printf '\n# Preserved from the previous .env - not managed by this script\n' >> "$ENV_PATH"
  printf '%s\n' "$PRESERVED_ENV" >> "$ENV_PATH"
fi
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

# ---------------------------------------------------- run onboard, then stop --
# `onboard --yes` writes the config and then starts the server in the FOREGROUND
# and never returns: cli/src/commands/onboard.ts sets
#   shouldRunNow = !serviceInstalled && (opts.run === true || opts.yes === true)
# and there is no flag that overrides it. --install-service does not help either,
# because detectServiceManager() finds no systemd user manager in a container.
#
# This used to need onboard-paperclip.exp, which drove a pty and typed the Ctrl+C
# an operator otherwise had to. That is now done here instead: run onboard in its
# own process group in the background, poll /api/health until the server is up
# (which also means migrations finished — stopping earlier can interrupt one),
# then signal the group and carry on. No expect, no pty, no operator.
#
# The server is deliberately left STOPPED. supervisord/systemd starts the real
# one afterwards; this script only needed it up long enough to prove the config
# works and the schema is migrated.
ONBOARD_RC=0
ONBOARD_LOG="$(mktemp "${TMPDIR:-/tmp}/paperclip-onboard.XXXXXX.log")"
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

# Wait for readiness. Two exits: the server answers /api/health, or onboard died.
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
  # Signal the process group (negative pid) so the node server and its children
  # all stop. SIGINT first because node has no handler and exits cleanly on it;
  # escalate only if something is still alive.
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

# Surface the tail either way: this is the only place onboard's own output shows.
echo "--- last 20 lines of onboard output ---"
tail -20 "$ONBOARD_LOG" 2>/dev/null || true
echo "---"

# 130 (SIGINT) is the expected way out of the line above. Anything else that did
# not leave a config behind is a real failure - patching a file that onboard
# never wrote would just fail more confusingly a few lines down.
if [ ! -f "$CONFIG_PATH" ]; then
  echo "onboard exited ${ONBOARD_RC} without writing $CONFIG_PATH - nothing to patch." >&2
  exit 1
fi

apply_config_patches

# "${PAPERCLIP_CMD[@]}" service restart --instance "$PAPERCLIP_INSTANCE_ID" || true
# "${PAPERCLIP_CMD[@]}" doctor --config "$CONFIG_PATH" --yes

echo "Onboarded: config=$CONFIG_PATH logs=$LOG_DIR backups=$PAPERCLIP_DB_BACKUP_DIR"

# ------------------------------------------------------- bootstrap invite ----
# Prints the one-time CEO invite URL. --base-url is not optional here: with
# bind=lan the CLI rewrites the host to "localhost"
# (resolveBaseUrl in cli/src/commands/auth-bootstrap-ceo.ts), which is useless
# from any other machine. PAPERCLIP_FQDN is the name to hand out instead.
#
# Only reaches the database, not the server, so it works before the server is
# started - but the URL is not usable until it is. Non-fatal: onboarding has
# already succeeded by this point, and the command can be re-run at any time.
#
# The URL is also written to INVITE_FILE, one line, nothing else - the console
# copy is easy to lose in a container log, and there is no way to print an
# existing invite again: every bootstrap-ceo run REVOKES the outstanding ones
# (auth-bootstrap-ceo.ts) and mints a new token, so a lost URL means re-running
# this command. onboard itself already created one before the server started,
# which the call below has just revoked - the file therefore holds the only
# invite that still works. It sits beside config.json and .env so it survives
# with them, and is 600 because anyone holding it can claim the instance.
INVITE_FILE="$(dirname "$CONFIG_PATH")/bootstrap-ceo-invite.txt"

echo
if invite_output="$("${PAPERCLIP_CMD[@]}" auth bootstrap-ceo --config "$CONFIG_PATH" --base-url "$PAPERCLIP_BASE_URL" 2>&1 | tee /dev/stderr)"; then
  # Not grepped by its "Invite URL:" label: clack prefixes the line with a box
  # character and picocolors wraps the URL in colour codes whenever this runs on
  # a tty. Strip the escapes, then match the URL itself.
  #
  # This bootstrap invite is now a FALLBACK. --claim-admin grants instance_admin
  # headlessly and is the normal path; this link only matters if proxy auth is
  # off, or someone wants to claim from a browser instead.
  invite_url="$(printf '%s\n' "$invite_output" \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -oE 'https?://[^[:space:]]+/invite/[^[:space:]]+' \
    | tail -1)"

  if [ -n "$invite_url" ]; then
    printf '%s\n' "$invite_url" > "$INVITE_FILE"
    chmod 600 "$INVITE_FILE"
    echo "Bootstrap CEO invite saved to $INVITE_FILE"
  else
    echo "WARNING: bootstrap-ceo succeeded but no invite URL could be parsed from its" >&2
    echo "         output, so $INVITE_FILE was not written. The URL above is the only copy." >&2
  fi
else
  echo "WARNING: could not create the bootstrap CEO invite (is the database reachable?)." >&2
  echo "  Retry: ${PAPERCLIP_CMD[*]} auth bootstrap-ceo --config \"$CONFIG_PATH\" --base-url \"$PAPERCLIP_BASE_URL\"" >&2
fi

echo
echo "Password signup is disabled and telemetry is off in $CONFIG_PATH."
echo
echo "IMPORTANT - the instance is unclaimed. Claiming is first come, first served"
echo "among users who can sign in, so do this before anyone else reaches it:"
echo "  1. Start the server:  PAPERCLIP_CONFIG=\"$CONFIG_PATH\" ${PAPERCLIP_CMD[*]} run"
echo "  2. Open $PAPERCLIP_BASE_URL as the admin account"
echo "  3. Claim the instance by opening the invite URL above, or from:"
echo "       ${INVITE_FILE}"
echo
echo "With the trusted proxy on, anyone it authenticates gets an account"
echo "automatically and could claim first - so claim promptly. The UI's own claim"
echo "button rejects proxy-authenticated users; the invite URL is the path that works."

# ------------------------------------------------------------ starting it ---
# onboard --yes already started the server above. To start it again later, the
# config path must be passed explicitly or the CLI will look in ~/.paperclip:
#
#   paperclipai run --config "$CONFIG_PATH" --instance "$PAPERCLIP_INSTANCE_ID"
#
# or equivalently: PAPERCLIP_CONFIG="$CONFIG_PATH" paperclipai run

# ------------------------------------------------------------ next steps ----
# Onboarding started an engine, used it to write the config and run migrations,
# and stopped it again on purpose. Whether one is running NOW is a separate
# question, and it is the one step 2 turns on - so answer it here rather than
# leaving the operator to assume.
echo
echo "--- engine ---"
if engine_status; then
  echo
  echo "Step 1 complete, and the engine is up."
  echo "  next: ./onboard-paperclip-2.sh --owner-email <email>"
else
  echo
  echo "Step 1 is complete - this is expected, not a failure. The engine started"
  echo "here was only ever meant to write the config and run migrations, and was"
  echo "stopped again."
  echo
  echo "Step 2 needs a running engine: it mints its API key through the engine and"
  echo "every command it runs is an HTTP request to it. Start one, then:"
  echo "  $0 --check-engine"
  echo "  ./onboard-paperclip-2.sh --owner-email <email>"
fi
