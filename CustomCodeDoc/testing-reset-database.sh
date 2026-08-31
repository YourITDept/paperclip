#!/usr/bin/env bash
# testing-reset-database.sh — put the instance back to "never onboarded" so the
# onboarding scripts can be run end to end again.
#
# This exists for testing the onboarding path repeatedly. It is destructive by
# design: it drops the Paperclip database and, at higher levels, the instance
# state and config too. Nothing here is recoverable.
#
# RULE 0: this script never commits anything. See
# CustomCodeDoc/Review and Test Changes.md.
#
# ------------------------------------------------------------- what resets --
# Three levels, because "reset" means different things depending on what you
# are testing. Each includes the ones above it.
#
#   --db-only     (default) drop and recreate the database.
#                 Onboarding config survives, so the server restarts against an
#                 empty schema and migrations re-run. This is what you want to
#                 re-test onboard-paperclip-2.sh: company, secrets, agent,
#                 invites and the admin claim all disappear.
#
#   --full        the above, plus the instance state directory
#                 ($PAPERCLIP_HOME/instances/<id>): workspaces, projects,
#                 companies, logs, locks, runtime-info.json, and the per-instance
#                 secrets keys. Use when instance state is what you are testing.
#
#   --factory     the above, plus the config file and the secrets master key.
#                 Puts the host back to before onboard-paperclip-1.sh ever ran,
#                 so the whole two-script flow can be exercised from zero.
#
# ------------------------------------------------------------ what it never --
# It does not touch:
#   * /sysops/llm/**            the credential vaults (Codex/Claude/OpenRouter)
#   * the container environment (/etc/profile.d/container-env.sh)
#   * the installed release tree under /install
# Those are inputs to onboarding, not products of it.
#
# ------------------------------------------------------------------ usage ---
#   ./testing-reset-database.sh --db-only          # ask, then drop the DB
#   ./testing-reset-database.sh --full --yes       # no prompt
#   ./testing-reset-database.sh --factory --yes
#   ./testing-reset-database.sh --status           # show what exists, change nothing
#
#   --yes        skip the confirmation prompt (for scripted test loops)
#   --keep-key   at --factory, keep the secrets master key
#
# ------------------------------------------------------- the full test loop --
#   ./testing-reset-database.sh --db-only --yes
#   sudo supervisorctl restart paperclip      # let migrations rebuild the schema
#   ./onboard-paperclip-1.sh --wait
#   ./onboard-paperclip-1.sh --claim-admin --owner-email admin@example.com
#   ./onboard-paperclip-2.sh --owner-email admin@example.com
set -euo pipefail

LEVEL="db-only"
ASSUME_YES=false
KEEP_KEY=false
STATUS_ONLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --db-only)  LEVEL="db-only"; shift ;;
    --full)     LEVEL="full"; shift ;;
    --factory)  LEVEL="factory"; shift ;;
    --status)   STATUS_ONLY=true; shift ;;
    --yes|-y)   ASSUME_YES=true; shift ;;
    --keep-key) KEEP_KEY=true; shift ;;
    -h|--help)  sed -n '2,52p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die()  { printf 'reset: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }

command -v psql > /dev/null 2>&1 || die "psql is required"
command -v node > /dev/null 2>&1 || die "node is required"

CONFIG_PATH="${PAPERCLIP_CONFIG:-/sysops/config/paperclip/config.json}"
INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_ROOT="${PAPERCLIP_HOME:-$HOME/.paperclip}/instances/$INSTANCE_ID"

read_cfg() { node -e "try{const c=require('$CONFIG_PATH');process.stdout.write(String($1 ?? ''))}catch{process.stdout.write('')}"; }

CONN="$(read_cfg 'c.database?.connectionString')"
KEY_FILE="$(read_cfg 'c.secrets?.localEncrypted?.keyFilePath')"

# Parse the connection string in node rather than with a regex: passwords
# routinely contain characters that break naive splitting.
DB_NAME="$(node -e "try{const u=new URL('$CONN');process.stdout.write(u.pathname.slice(1))}catch{process.stdout.write('')}")"
ADMIN_CONN="$(node -e "try{const u=new URL('$CONN');u.pathname='/postgres';process.stdout.write(u.toString())}catch{process.stdout.write('')}")"

# ----------------------------------------------------------------- status ---
if [ "$STATUS_ONLY" = true ]; then
  echo "config:        ${CONFIG_PATH} $([ -f "$CONFIG_PATH" ] && echo '(present)' || echo '(missing)')"
  echo "database:      ${DB_NAME:-<unknown>}"
  if [ -n "$ADMIN_CONN" ]; then
    tables="$(psql "$CONN" -tAc "select count(*) from information_schema.tables where table_schema='public';" 2>/dev/null || echo '?')"
    admins="$(psql "$CONN" -tAc "select count(*) from instance_user_roles where role='instance_admin';" 2>/dev/null || echo '?')"
    companies="$(psql "$CONN" -tAc "select count(*) from companies;" 2>/dev/null || echo '?')"
    echo "  tables:      $tables"
    echo "  admins:      $admins"
    echo "  companies:   $companies"
  fi
  echo "instance root: $INSTANCE_ROOT $([ -d "$INSTANCE_ROOT" ] && echo '(present)' || echo '(missing)')"
  echo "secrets key:   ${KEY_FILE:-<none>} $([ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ] && echo '(present)' || echo '(missing)')"
  exit 0
fi

[ -n "$CONN" ] || die "no database connectionString in $CONFIG_PATH"
[ -n "$DB_NAME" ] || die "could not read a database name from the connection string"

# ---------------------------------------------------------------- confirm ---
echo "About to reset — level: $LEVEL"
info "database        $DB_NAME  (dropped and recreated)"
[ "$LEVEL" != "db-only" ] && info "instance state  $INSTANCE_ROOT  (deleted)"
if [ "$LEVEL" = "factory" ]; then
  info "config          $CONFIG_PATH  (deleted)"
  if [ "$KEEP_KEY" = true ]; then
    info "secrets key     ${KEY_FILE:-<none>}  (KEPT)"
  else
    info "secrets key     ${KEY_FILE:-<none>}  (deleted — any secret encrypted with it is unrecoverable)"
  fi
fi
echo
if [ "$ASSUME_YES" != true ]; then
  printf 'Type the database name (%s) to confirm: ' "$DB_NAME"
  read -r answer
  [ "$answer" = "$DB_NAME" ] || die "confirmation did not match; nothing was changed"
fi

# ------------------------------------------------------------ stop server ---
# Dropping a database out from under a live server leaves it erroring until it
# is restarted, and open connections block the DROP outright.
step 1/4 "Stopping the server if it is running"
if command -v supervisorctl > /dev/null 2>&1; then
  supervisorctl stop paperclip > /dev/null 2>&1 && info "supervisord: paperclip stopped" \
    || info "supervisord: not running under it, or already stopped"
else
  info "no supervisorctl; stop the server yourself if it is running"
fi

# --------------------------------------------------------------- database ---
step 2/4 "Recreating the database"
# Terminate leftover backends first, otherwise DROP DATABASE fails with
# "is being accessed by other users".
psql "$ADMIN_CONN" -qAc "select pg_terminate_backend(pid) from pg_stat_activity
  where datname = '$DB_NAME' and pid <> pg_backend_pid();" > /dev/null 2>&1 || true
psql "$ADMIN_CONN" -qAc "drop database if exists \"$DB_NAME\";" > /dev/null \
  || die "could not drop $DB_NAME — is something still connected?"
psql "$ADMIN_CONN" -qAc "create database \"$DB_NAME\";" > /dev/null \
  || die "dropped $DB_NAME but could not recreate it"
info "$DB_NAME dropped and recreated (empty — migrations run on next start)"

# ---------------------------------------------------------- instance state --
step 3/4 "Instance state"
if [ "$LEVEL" = "db-only" ]; then
  info "kept (use --full to remove $INSTANCE_ROOT)"
else
  if [ -d "$INSTANCE_ROOT" ]; then
    rm -rf "${INSTANCE_ROOT:?}"
    info "removed $INSTANCE_ROOT"
  else
    info "nothing at $INSTANCE_ROOT"
  fi
fi

# ----------------------------------------------------------- config / key ---
step 4/4 "Config and secrets key"
if [ "$LEVEL" != "factory" ]; then
  info "kept (use --factory to remove the config and the master key)"
else
  [ -f "$CONFIG_PATH" ] && { rm -f "$CONFIG_PATH"; info "removed $CONFIG_PATH"; } \
                        || info "no config at $CONFIG_PATH"
  if [ -n "$KEY_FILE" ] && [ "$KEEP_KEY" != true ]; then
    [ -f "$KEY_FILE" ] && { rm -f "$KEY_FILE"; info "removed $KEY_FILE"; } \
                       || info "no key at $KEY_FILE"
  else
    info "secrets key kept"
  fi
fi

cat <<EOF

Reset complete (level: $LEVEL).

Next:
EOF
if [ "$LEVEL" = "factory" ]; then
  cat <<'EOF'
  ./onboard-paperclip-1.sh                 # re-onboard from zero (writes config)
  ./onboard-paperclip-1.sh --claim-admin --owner-email <email>
  ./onboard-paperclip-2.sh --owner-email <email>
EOF
else
  cat <<'EOF'
  sudo supervisorctl start paperclip       # migrations rebuild the schema
  ./onboard-paperclip-1.sh --status        # expect bootstrap_pending
  ./onboard-paperclip-1.sh --claim-admin --owner-email <email>
  ./onboard-paperclip-2.sh --owner-email <email>
EOF
fi
