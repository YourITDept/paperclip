#!/usr/bin/env bash
# onboard-paperclip-2.sh — phase two of Paperclip onboarding: tenant setup.
#
# Run this AFTER onboard-paperclip.sh has installed the instance, the first
# admin has claimed it, and the server is running. Phase one gets the process
# up; this one fills it with a company, secrets, an agent that can actually
# authenticate to a model provider, and invite links for the humans.
#
# Everything here is idempotent. It looks things up by name before creating
# them, so a re-run is a no-op and a partial run resumes. That is what makes it
# usable for migrating an environment, not just standing one up the first time.
#
# Workflow reference: CustomCodeDoc/Paperclip Onboarding Steps.md (steps 4-8).
# Command reference:  CustomCodeDoc/paperclipai-cli-reference.md
#
# RULE 0: this script never commits anything. See
# CustomCodeDoc/Review and Test Changes.md.
#
# ---------------------------------------------------------------- usage -----
#   ./onboard-paperclip-2.sh --owner-email you@example.com
#   ./onboard-paperclip-2.sh --owner-email you@example.com --company "Acme"
#
# That first line is the whole thing: no key to mint, export, or copy. The
# script mints its own board key, claims the instance if it is unclaimed, and
# then creates the company, secret, agent and invites.
#   ./onboard-paperclip-2.sh --dry-run    # print what it would do
#   ./onboard-paperclip-2.sh --only company,secrets,agent,invite,task
#   ./onboard-paperclip-2.sh --verify     # verification only, change nothing
#   ./onboard-paperclip-2.sh --mint-key --owner-email you@example.com
#
# Flags, each overriding the matching ONBOARD_* variable:
#   --owner-email <email>  instance owner. Identity used by --mint-key, and
#                          recorded in the invite file.
#   --company <name>       company to create or reuse (default "YourITDept")
#   --api-key <key>        board API key. OPTIONAL — when neither this nor
#                          PAPERCLIP_API_KEY is set, the script mints its own
#                          via proxy-header auth. Prefer the environment over
#                          this flag: an argument is visible in `ps`.
#   --api-url <url>        where to reach the server. Origin only, no /api.
#                          Default PAPERCLIP_API_URL, the INTERNAL address
#                          (e.g. http://dev07paperclip97:3100).
#   --public-url <url>     base for invite links — the public FQDN a human's
#                          browser can open (e.g. https://dev07.example.com).
#                          Default PAPERCLIP_PUBLIC_URL.
#   --agent-name <name>    agent to create (default "Codex Worker")
#   --task-title <text>    create a task and assign it to that agent
#   --task-prompt <text>   the task body — the agent's prompt. Required with
#                          --task-title.
#   --invite-roles <list>  comma list, one invite minted per entry.
#                          Default "owner,admin,operator" — three links.
#                          Valid: owner | admin | operator | viewer.
#   --only <phases>        comma list: company,secrets,agent,invite,task
#   --mint-key             print a board API key and exit
#   --dry-run / --verify
#
# Two URLs, deliberately. --api-url is the direct internal route; --mint-key
# needs it, because a reverse proxy overwrites the user header it relies on.
# --public-url only ever appears inside invite links. Getting these backwards
# gives you either a broken --mint-key or invite links nobody can open.
#
#
# ------------------------------------------------------- getting a key -----
# --mint-key gets one without a browser, using this fork's proxy-header auth.
# POST /api/board-api-keys requires only `actor.type === "board"` with a userId
# (access.ts:2898) — unlike POST /api/bootstrap/claim it does NOT demand
# `source === "session"`, so a proxy_header actor qualifies.
#
#   ONBOARD_OWNER_EMAIL=you@example.com ./onboard-paperclip-2.sh --mint-key
#
# Requires PAPERCLIP_PROXY_AUTH_ENABLED=true (already exported here). If the
# user does not exist yet, PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true creates it.
#
#   SECURITY: proxy-header auth does NOT verify where the request came from —
#   it trusts the header unconditionally. Anyone able to reach the port
#   directly can set that header and become any user. That is the documented
#   premise of the feature (proxy-header-auth.ts:19): the server must be
#   reachable ONLY through the reverse proxy, and the proxy must overwrite the
#   header rather than pass a client-supplied one through. This instance binds
#   an internal hostname, which satisfies it. Do not run --mint-key against a
#   publicly-bound port.
#
# The browser route still works and needs no proxy auth:
#   paperclipai auth login && paperclipai token board create --json
#
# Everything else comes from the environment the container already exports
# (/etc/profile.d/container-env.sh): PAPERCLIP_API_URL, PAPERCLIP_PUBLIC_URL,
# PAPERCLIP_CODEX_HOME, OPENROUTER_API_KEY, PAPERCLIP_CLI.
#
# Tunables, all with defaults:
#   ONBOARD_COMPANY_NAME   default "YourITDept"
#   ONBOARD_OWNER_EMAIL    instance owner; invited as `owner` when set
#   ONBOARD_AGENT_NAME     default "Codex Worker"
#   ONBOARD_ADAPTER_TYPE   default "codex_local"
#   ONBOARD_SECRET_NAME    default "OpenRouter"
#   ONBOARD_SECRET_KEY     default "openrouter_api_key"
#   ONBOARD_INVITE_ROLES   comma list, default "owner,admin,operator" — one
#                          invite per entry (owner|admin|operator|viewer)
#   ONBOARD_INVITE_OUT     where the invite links are written,
#                          default ./paperclip-invites-<company>-<date>.txt
#   ONBOARD_TASK_TITLE     when set, a task is created and assigned to the agent
#   ONBOARD_TASK_PROMPT    the task body — this is the agent's prompt
#
# Invite links are written to ONBOARD_INVITE_OUT (mode 0600) as well as printed.
# Treat that file as a credential store: anyone holding a link can join the
# company with the role it carries, until it is used or expires.
set -euo pipefail

# No browser: this runs headless at container start. `auth login` would
# otherwise try xdg-open (cli/src/client/board-auth.ts:183), which honours this.
export PAPERCLIP_NO_BROWSER=1

# ------------------------------------------------------------------ args ----
DRY_RUN=false
VERIFY_ONLY=false
MINT_KEY=false
ONLY=""
ARG_OWNER_EMAIL=""
ARG_COMPANY_NAME=""
ARG_API_KEY=""
ARG_API_URL=""
ARG_PUBLIC_URL=""
ARG_INVITE_ROLES=""
MINTED_THIS_RUN=false
ARG_AGENT_NAME=""
ARG_TASK_TITLE=""
ARG_TASK_PROMPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY_RUN=true; shift ;;
    --verify)       VERIFY_ONLY=true; shift ;;
    --mint-key)     MINT_KEY=true; shift ;;
    --only)         ONLY="${2:?--only needs a value}"; shift 2 ;;
    --owner-email)  ARG_OWNER_EMAIL="${2:?--owner-email needs a value}"; shift 2 ;;
    --company)      ARG_COMPANY_NAME="${2:?--company needs a value}"; shift 2 ;;
    --api-url)      ARG_API_URL="${2:?--api-url needs a value}"; shift 2 ;;
    --public-url)   ARG_PUBLIC_URL="${2:?--public-url needs a value}"; shift 2 ;;
    --invite-roles) ARG_INVITE_ROLES="${2:?--invite-roles needs a value}"; shift 2 ;;
    --agent-name)   ARG_AGENT_NAME="${2:?--agent-name needs a value}"; shift 2 ;;
    --task-title)   ARG_TASK_TITLE="${2:?--task-title needs a value}"; shift 2 ;;
    --task-prompt)  ARG_TASK_PROMPT="${2:?--task-prompt needs a value}"; shift 2 ;;
    # Accepts a key on the command line for convenience. Prefer the environment:
    # an argument is visible in `ps` to every process on the box.
    --api-key)      ARG_API_KEY="${2:?--api-key needs a value}"; shift 2 ;;
    -h|--help)      sed -n '2,99p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Resolved here, before anything reads them: a flag beats the environment, and
# --mint-key below needs the owner email already settled.
OWNER_EMAIL="${ARG_OWNER_EMAIL:-${ONBOARD_OWNER_EMAIL:-}}"
COMPANY_NAME="${ARG_COMPANY_NAME:-${ONBOARD_COMPANY_NAME:-YourITDept}}"
[ -n "$ARG_API_KEY" ] && export PAPERCLIP_API_KEY="$ARG_API_KEY"

# Two distinct URLs, and conflating them is the classic mistake here.
#
#   API_URL     THE ONLY URL THIS SCRIPT EVER CONNECTS TO. Internal by default
#               (PAPERCLIP_API_URL=http://<host>:<port>), reached directly with
#               no proxy in the path.
#
#               The public URL is deliberately NOT usable for this: it fronts
#               the sign-in and proxy services, so a request through it needs
#               browser authorization and would be rejected or answered as a
#               different identity. --mint-key in particular depends on the
#               direct route, because the proxy overwrites the very header it
#               relies on.
#
#   PUBLIC_URL  TEXT ONLY. It is never connected to. It appears inside invite
#               links and in the invite file header, because a human opens
#               those in a browser, where going through the proxy is correct.
#
# If you are adding a request to this script, it uses PAPERCLIP_API_URL. There
# is no case where a request should go to PUBLIC_URL.
#
# Origin only for both — no trailing /api. Paths are composed as /api/...,
# so a base ending in /api yields /api/api/... and 404s.
[ -n "$ARG_API_URL" ] && export PAPERCLIP_API_URL="$ARG_API_URL"
PUBLIC_URL="${ARG_PUBLIC_URL:-${ONBOARD_PUBLIC_URL:-${PAPERCLIP_PUBLIC_URL:-}}}"

# Normalize both: drop trailing slashes, then a trailing /api. Without this a
# base of "https://host/api/" silently becomes /api/api/... and every call 404s.
normalize_base() {
  local u="$1"
  u="${u%"${u##*[!/]}"}"      # strip trailing slashes
  [ "${u%/api}" != "$u" ] && u="${u%/api}"
  printf '%s' "$u"
}
[ -n "${PAPERCLIP_API_URL:-}" ] && export PAPERCLIP_API_URL="$(normalize_base "$PAPERCLIP_API_URL")"
[ -n "$PUBLIC_URL" ] && PUBLIC_URL="$(normalize_base "$PUBLIC_URL")"

die()  { printf 'onboard-2: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }

# Run a phase unless --only excluded it.
want() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }

# ------------------------------------------------------------------- cli ----
# Same resolution order as onboard-paperclip.sh, so both scripts agree on which
# binary they are driving.
if [ -n "${PAPERCLIP_CLI:-}" ]; then
  read -r -a PC <<< "$PAPERCLIP_CLI"
elif command -v paperclipai > /dev/null 2>&1; then
  PC=(paperclipai)
else
  die "no Paperclip CLI found — set PAPERCLIP_CLI or put paperclipai on PATH"
fi
command -v jq > /dev/null 2>&1 || die "jq is required"

# ---------------------------------------------------------------- inputs ----
: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is not set — is the container env sourced?}"

# ------------------------------------------------------------- mint a key ---
# Minting is a function, not a mode, so the normal run can do it silently.
# Requiring the operator to mint separately and export the result was two steps
# for something the script can always do for itself.
mint_board_key() {
  local email="$1" hdr base resp key
  command -v curl > /dev/null 2>&1 || die "curl is required to mint an API key"
  [ -n "$email" ] || die "minting a key needs an owner email.
         Pass --owner-email you@example.com, or set ONBOARD_OWNER_EMAIL."
  [ "${PAPERCLIP_PROXY_AUTH_ENABLED:-}" = "true" ] \
    || die "cannot mint a key: PAPERCLIP_PROXY_AUTH_ENABLED is not 'true'.
         Either enable proxy auth, or supply a key yourself:
           paperclipai auth login && paperclipai token board create --json
           export PAPERCLIP_API_KEY=..."

  hdr="${PAPERCLIP_PROXY_AUTH_USER_HEADER:-x-forwarded-user}"
  base="${PAPERCLIP_API_URL%/}"

  # Origin is REQUIRED, not decoration. boardMutationGuard (a CSRF guard) exempts
  # local_implicit / board_key / cloud_tenant sources but NOT proxy_header, so a
  # proxy-header POST with no Origin/Referer is rejected 403 "Board mutation
  # requires trusted browser origin" even though the identity resolved fine.
  # $base is trusted because it matches the Host header curl already sends.
  resp="$(curl -sS -X POST "$base/api/board-api-keys" \
    -H "$hdr: $email" \
    -H "Origin: $base" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg n "onboard-paperclip-2 $(date -u +%Y-%m-%dT%H:%M:%SZ)" '{name:$n}')" \
    2>&1)" || die "request failed: $resp"

  key="$(printf '%s' "$resp" | jq -r '.key // .token // .apiKey // empty' 2>/dev/null || true)"
  if [ -z "$key" ]; then
    printf 'Could not read a key from the response:\n%s\n\n' "$resp" >&2
    case "$resp" in
      *"trusted browser origin"*)
        die "the CSRF guard rejected this, not proxy auth — the identity was fine.
         boardMutationGuard requires an Origin/Referer matching a trusted origin.
         Trusted here: \$PAPERCLIP_API_URL ($base), \$PAPERCLIP_PUBLIC_URL,
         http://localhost:3100, http://127.0.0.1:3100.
         This script sends 'Origin: $base'; if that is still refused, the server
         is seeing a different Host — try --api-url http://localhost:3100" ;;
      *"Board authentication required"*|*401*)
        die "proxy auth did not resolve '$email' — check the header name ($hdr),
         PAPERCLIP_PROXY_AUTH_EMAIL_DOMAINS, and whether the user exists
         (PAPERCLIP_PROXY_AUTH_AUTO_PROVISION=true creates it on first sight)" ;;
      *"Permission denied"*|*403*)
        die "'$email' authenticated but lacks permission to mint a board key" ;;
      *)
        die "unexpected response — see above" ;;
    esac
  fi
  printf '%s' "$key"
}

# --mint-key: print one and stop. Useful for scripting or to hand to another tool.
if [ "$MINT_KEY" = true ]; then
  if [ "$DRY_RUN" = true ]; then
    printf 'would POST %s/api/board-api-keys as %s\n' "${PAPERCLIP_API_URL%/}" "$OWNER_EMAIL" >&2
    printf '(dry run — no key minted, nothing printed to stdout)\n' >&2
    exit 0
  fi
  MINTED="$(mint_board_key "$OWNER_EMAIL")"
  printf '%s\n' "$MINTED"
  printf '\nExport it, or just run without --mint-key and the script mints its own:\n  export PAPERCLIP_API_KEY=%s\n' "$MINTED" >&2
  exit 0
fi

# Normal run: mint silently when no key was supplied, so a bare
#   ./onboard-paperclip-2.sh --owner-email you@example.com
# is all that is needed. A key in the environment always wins.
if [ -z "${PAPERCLIP_API_KEY:-}" ]; then
  if [ "$DRY_RUN" = true ]; then
    info "would mint a board API key as ${OWNER_EMAIL:-<no --owner-email>}"
    PAPERCLIP_API_KEY="dry-run-placeholder"
  else
    PAPERCLIP_API_KEY="$(mint_board_key "$OWNER_EMAIL")"
    MINTED_THIS_RUN=true
  fi
fi
export PAPERCLIP_API_URL PAPERCLIP_API_KEY

# COMPANY_NAME and OWNER_EMAIL are resolved during argument parsing above.
AGENT_NAME="${ARG_AGENT_NAME:-${ONBOARD_AGENT_NAME:-Codex Worker}}"
ADAPTER_TYPE="${ONBOARD_ADAPTER_TYPE:-codex_local}"
SECRET_NAME="${ONBOARD_SECRET_NAME:-OpenRouter}"
SECRET_KEY="${ONBOARD_SECRET_KEY:-openrouter_api_key}"
INVITE_ROLES="${ARG_INVITE_ROLES:-${ONBOARD_INVITE_ROLES:-owner,admin,operator}}"
CODEX_HOME_VALUE="${PAPERCLIP_CODEX_HOME:-}"
BASE_URL="${PUBLIC_URL:-${PAPERCLIP_API_URL%/api}}"
INVITE_OUT="${ONBOARD_INVITE_OUT:-./paperclip-invites-$(printf '%s' "$COMPANY_NAME" | tr -c '[:alnum:]' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')-$(date -u +%Y%m%dT%H%M%SZ).txt}"

# Collected invite rows: "<role>\t<url>\t<inviteId>". Printed and written at the
# end so a failure mid-loop cannot leave a half-written credential file behind.
INVITE_ROWS=()

run() {
  if [ "$DRY_RUN" = true ]; then printf '    would run: %s\n' "$*"; return 0; fi
  "$@"
}

# --------------------------------------------------------------- preflight --
step 0/6 "Preflight"

# An unclaimed instance has no instance_admin, and company creation then fails
# with "Creating companies requires board/instance-admin authentication" — a
# message that points at agent API keys and sends you the wrong way entirely.
# Check the real precondition first, and fix it, rather than failing at 1/6.
BOOTSTRAP="$(curl -fsS --max-time 5 "${PAPERCLIP_API_URL%/}/api/health" 2>/dev/null \
  | jq -r '.bootstrapStatus // "unknown"' 2>/dev/null || echo unreachable)"
if [ "$BOOTSTRAP" = "unreachable" ]; then
  die "cannot reach ${PAPERCLIP_API_URL%/}/api/health — is the server running?
         Start it (supervisorctl/systemd), then re-run."
fi
# Lock ownership to --owner-email, every run, whatever state the instance is in.
#
# Not just when unclaimed. Script 1 leaves a bootstrap_ceo invite link behind,
# and anyone holding it can claim ownership until it is redeemed or expires.
# This makes the named email the sole instance_admin and revokes those links, so
# whatever happened between the two scripts is overwritten deterministically.
if [ -n "$OWNER_EMAIL" ]; then
  OWNER_TOOL="$(dirname "$0")/onboard-paperclip-1.sh"
  if [ -x "$OWNER_TOOL" ]; then
    if [ "$DRY_RUN" = true ]; then
      info "would lock instance ownership to $OWNER_EMAIL and revoke bootstrap invites"
    else
      info "locking instance ownership to $OWNER_EMAIL ..."
      "$OWNER_TOOL" --set-owner --owner-email "$OWNER_EMAIL" \
        | sed 's/^/  /' || die "could not set the instance owner — see above"
    fi
  elif [ "$BOOTSTRAP" = "bootstrap_pending" ]; then
    die "instance is unclaimed and $OWNER_TOOL is missing.
         Run: ./onboard-paperclip-1.sh --set-owner --owner-email $OWNER_EMAIL"
  else
    info "note: $OWNER_TOOL missing — ownership not verified"
  fi
elif [ "$BOOTSTRAP" = "bootstrap_pending" ]; then
  die "an unclaimed instance needs --owner-email so ownership can be assigned"
fi

WHOAMI="$("${PC[@]}" access whoami --json 2>/dev/null || true)"
[ -n "$WHOAMI" ] || die "access whoami failed — PAPERCLIP_API_KEY is missing, wrong, or the server is down.
         Every later step would fail as a confusing 401. Fix the token first."
info "authenticated: $(printf '%s' "$WHOAMI" | jq -r '.email // .userId // "board user"')"
[ "$MINTED_THIS_RUN" = true ] && info "api key:       minted for this run (not stored)"
info "connecting to: $PAPERCLIP_API_URL   (internal — every request goes here)"
info "invite links:  ${BASE_URL:-<unset>}   (text only — never connected to)"
if [ -z "$PUBLIC_URL" ]; then
  info "note: no public URL set, so invite links fall back to the API URL."
  info "      If that is an internal hostname, the links will not open from a"
  info "      normal browser. Pass --public-url https://<fqdn> to fix it."
fi

if [ "$VERIFY_ONLY" = false ] && [ -z "${OPENROUTER_API_KEY:-}" ] && want secrets; then
  die "OPENROUTER_API_KEY is not set. Refusing to create an empty secret —
         an empty credential fails at first agent run, not here, which is the
         expensive place to find out. Export it, or --only company,agent."
fi

# ----------------------------------------------------------------- company --
COMPANY_ID=""
if want company; then
  step 1/6 "Company '$COMPANY_NAME'"
  COMPANY_ID="$("${PC[@]}" company list --json 2>/dev/null \
    | jq -r --arg n "$COMPANY_NAME" 'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end
        | map(select(.name == $n)) | .[0].id // empty')"
  if [ -n "$COMPANY_ID" ]; then
    info "exists: $COMPANY_ID"
  else
    if [ "$DRY_RUN" = true ]; then
      info "would create company '$COMPANY_NAME'"; COMPANY_ID="<new>"
    else
      COMPANY_ID="$("${PC[@]}" company create --json --payload-json \
        "$(jq -nc --arg n "$COMPANY_NAME" '{name:$n}')" | jq -r '.id')"
      [ -n "$COMPANY_ID" ] && [ "$COMPANY_ID" != "null" ] || die "company create returned no id"
      info "created: $COMPANY_ID"
    fi
  fi
else
  COMPANY_ID="$("${PC[@]}" company list --json 2>/dev/null \
    | jq -r --arg n "$COMPANY_NAME" 'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end
        | map(select(.name == $n)) | .[0].id // empty')"
  [ -n "$COMPANY_ID" ] || die "company '$COMPANY_NAME' not found and --only excluded creating it"
fi

# ----------------------------------------------------------------- secret ---
SECRET_ID=""
if want secrets; then
  step 2/6 "Secret '$SECRET_NAME'"
  SECRET_ID="$("${PC[@]}" secrets list -C "$COMPANY_ID" --json 2>/dev/null \
    | jq -r --arg k "$SECRET_KEY" 'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end
        | map(select(.key == $k)) | .[0].id // empty')"
  if [ -n "$SECRET_ID" ]; then
    info "exists: $SECRET_ID  (rotate with: paperclipai secrets rotate)"
  elif [ "$DRY_RUN" = true ]; then
    info "would create secret '$SECRET_NAME' from \$OPENROUTER_API_KEY"; SECRET_ID="<new>"
  else
    # --value-env, never --value: the value must not appear in argv, where any
    # process on the box could read it out of `ps`.
    SECRET_ID="$("${PC[@]}" secrets create --json \
      -C "$COMPANY_ID" \
      --name "$SECRET_NAME" \
      --key "$SECRET_KEY" \
      --value-env OPENROUTER_API_KEY \
      --description "OpenRouter key for ${ADAPTER_TYPE} agents" | jq -r '.id')"
    [ -n "$SECRET_ID" ] && [ "$SECRET_ID" != "null" ] || die "secrets create returned no id"
    info "created: $SECRET_ID"
  fi
fi

# ------------------------------------------------------------------ agent ---
AGENT_ID=""
if want agent; then
  step 3/6 "Agent '$AGENT_NAME'"
  AGENT_ID="$("${PC[@]}" agent list -C "$COMPANY_ID" --json 2>/dev/null \
    | jq -r --arg n "$AGENT_NAME" 'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end
        | map(select(.name == $n)) | .[0].id // empty')"
  if [ -n "$AGENT_ID" ]; then
    info "exists: $AGENT_ID"
  elif [ "$DRY_RUN" = true ]; then
    info "would create agent '$AGENT_NAME' ($ADAPTER_TYPE)"; AGENT_ID="<new>"
  else
    # The credential is bound as a secret_ref rather than left to the host
    # environment. Resolved adapter env is merged AFTER the ACPX host-env
    # projection and is not filtered by it, so a bound key always reaches the
    # child process. A host-exported one depends on the allowlist.
    ENV_JSON="$(jq -nc --arg sid "$SECRET_ID" --arg home "$CODEX_HOME_VALUE" '
      ({}
       | if $home == "" then . else .CODEX_HOME = {type:"plain", value:$home} end
       | if $sid  == "" then . else .OPENROUTER_API_KEY = {type:"secret_ref", secretId:$sid} end)')"
    AGENT_ID="$("${PC[@]}" agent create --json -C "$COMPANY_ID" --payload-json \
      "$(jq -nc --arg n "$AGENT_NAME" --arg t "$ADAPTER_TYPE" --argjson env "$ENV_JSON" \
         '{name:$n, adapterType:$t, adapterConfig:{env:$env}}')" | jq -r '.id')"
    [ -n "$AGENT_ID" ] && [ "$AGENT_ID" != "null" ] || die "agent create returned no id"
    info "created: $AGENT_ID"
    info "bound:   CODEX_HOME=$CODEX_HOME_VALUE, OPENROUTER_API_KEY=secret_ref"
  fi
fi

# ---------------------------------------------------------------- invites ---
if want invite; then
  step 4/6 "Invite links"
  IFS=',' read -r -a ROLES <<< "$INVITE_ROLES"
  for role in "${ROLES[@]}"; do
    role="$(printf '%s' "$role" | tr -d '[:space:]')"
    [ -n "$role" ] || continue
    if [ "$DRY_RUN" = true ]; then info "would mint a '$role' invite"; continue; fi
    # humanRole defaults to `operator` when omitted — always send it explicitly.
    RESP="$("${PC[@]}" invite create --json -C "$COMPANY_ID" --payload-json \
      "$(jq -nc --arg r "$role" '{allowedJoinTypes:"human", humanRole:$r}')")"
    TOKEN="$(printf '%s' "$RESP" | jq -r '.token // .invite.token // .inviteToken // empty')"
    INVITE_ID="$(printf '%s' "$RESP" | jq -r '.id // .invite.id // empty')"
    # Prefer the server's own inviteUrl: it is built from the instance's
    # configured auth public base URL, which is authoritative and may differ
    # from PAPERCLIP_PUBLIC_URL in this shell. Fall back to composing one.
    URL="$(printf '%s' "$RESP" | jq -r '.inviteUrl // empty')"
    if [ -z "$URL" ] && [ -n "$TOKEN" ]; then URL="${BASE_URL%/}/invite/$TOKEN"; fi
    if [ -n "$URL" ]; then
      INVITE_ROWS+=("$(printf '%s\t%s\t%s' "$role" "$URL" "${INVITE_ID:-unknown}")")
      info "$role: $URL"
    else
      # The token is only ever returned at creation — it is stored hashed, so it
      # cannot be read back later. Say so loudly rather than implying a lookup.
      INVITE_ROWS+=("$(printf '%s\t%s\t%s' "$role" "<token-not-returned>" "${INVITE_ID:-unknown}")")
      info "$role: created (id ${INVITE_ID:-unknown}) but no token in the response"
      info "       the token is stored hashed and cannot be recovered — revoke and re-mint:"
      info "       paperclipai invite revoke ${INVITE_ID:-<id>}"
    fi
  done
  [ -n "$OWNER_EMAIL" ] && info "owner on record: $OWNER_EMAIL (invites are links; Paperclip sends no mail)"

  # Write the credential file once, atomically, 0600 from the moment it exists.
  if [ "${#INVITE_ROWS[@]}" -gt 0 ]; then
    umask 077
    TMP_OUT="$(mktemp "${INVITE_OUT}.XXXXXX")"
    {
      printf '# Paperclip invite links\n'
      printf '# company : %s (%s)\n' "$COMPANY_NAME" "$COMPANY_ID"
      printf '# instance: %s\n' "${BASE_URL%/}"
      printf '# created : %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      [ -n "$OWNER_EMAIL" ] && printf '# owner   : %s\n' "$OWNER_EMAIL"
      printf '#\n# These links are credentials. Anyone who opens one joins the company\n'
      printf '# with the role shown. They expire; mint fresh ones if unused.\n'
      printf '#\n# role\turl\tinvite_id\n'
      for row in "${INVITE_ROWS[@]}"; do printf '%s\n' "$row"; done
    } > "$TMP_OUT"
    chmod 600 "$TMP_OUT"
    mv -f "$TMP_OUT" "$INVITE_OUT"
    info "wrote ${#INVITE_ROWS[@]} invite(s) to $INVITE_OUT (mode 0600)"
  fi
fi

# ------------------------------------------------------------------- task ---
TASK_TITLE="${ARG_TASK_TITLE:-${ONBOARD_TASK_TITLE:-}}"
TASK_PROMPT="${ARG_TASK_PROMPT:-${ONBOARD_TASK_PROMPT:-}}"
if want task && [ -n "$TASK_TITLE" ]; then
  step 5/6 "Task for the agent"
  [ -n "$AGENT_ID" ] || die "a task needs an agent; run without --only, or set --only agent,task"
  PROMPT="$TASK_PROMPT"
  [ -n "$PROMPT" ] || die "a task title was given but the prompt is empty — pass --task-prompt"
  if [ "$DRY_RUN" = true ]; then
    info "would create task '$TASK_TITLE' assigned to $AGENT_ID"
  else
    ISSUE_ID="$("${PC[@]}" issue create --json \
      -C "$COMPANY_ID" \
      --title "$TASK_TITLE" \
      --description "$PROMPT" \
      --assignee-agent-id "$AGENT_ID" \
      --status todo \
      --priority high | jq -r '.id // empty')"
    info "task: ${ISSUE_ID:-created}"
    # Assigned work is picked up on the next heartbeat; wake it now so the
    # onboarding run does not appear to hang.
    run "${PC[@]}" agent wake "$AGENT_ID" -C "$COMPANY_ID" \
      --source assignment --trigger manual --reason "onboarding task assigned" > /dev/null || true
    info "woke agent $AGENT_ID"
  fi
fi

# ------------------------------------------------------------------ verify --
step 6/6 "Verify"
info "company:  $("${PC[@]}" company list --json 2>/dev/null | jq -r --arg n "$COMPANY_NAME" \
  'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end | map(select(.name==$n)) | length') match(es) for '$COMPANY_NAME'"
if want secrets; then
  "${PC[@]}" secrets doctor -C "$COMPANY_ID" > /dev/null 2>&1 \
    && info "secrets: doctor clean" \
    || info "secrets: doctor reported findings — run: paperclipai secrets doctor -C $COMPANY_ID"
fi
info "agents:   $("${PC[@]}" agent list -C "$COMPANY_ID" --json 2>/dev/null | jq -r \
  'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end | length')"
info "invites:  $("${PC[@]}" invite list -C "$COMPANY_ID" --json 2>/dev/null | jq -r \
  'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end | length') outstanding"

cat <<EOF

Done.
  COMPANY_ID=$COMPANY_ID
  SECRET_ID=${SECRET_ID:-<skipped>}
  AGENT_ID=${AGENT_ID:-<skipped>}
EOF

if [ "${#INVITE_ROWS[@]}" -gt 0 ]; then
  printf '\nInvite links (also written to %s, mode 0600):\n\n' "$INVITE_OUT"
  for row in "${INVITE_ROWS[@]}"; do
    printf '  %-9s %s\n' "$(printf '%s' "$row" | cut -f1)" "$(printf '%s' "$row" | cut -f2)"
  done
  printf '\n  Move that file somewhere durable and delete it from here — the tokens\n'
  printf '  are stored hashed server-side and cannot be printed again.\n'
fi

cat <<EOF

Verify the provider credential end to end — this is the step that catches an
agent which looks configured and 401s on its first real run:

  CODEX_HOME=${CODEX_HOME_VALUE:-/sysops/llm/openrouter/default} \\
    codex exec --skip-git-repo-check "Reply with exactly: PONG"

Expect 'provider: openrouter' and 'PONG'. If you get
"provider auth command 'sh' produced an empty token" the key is not reaching
the child process.
EOF
