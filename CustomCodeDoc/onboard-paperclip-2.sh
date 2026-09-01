#!/usr/bin/env bash
# onboard-paperclip-2.sh — phase two of Paperclip onboarding: tenant setup.
#
# Run this AFTER onboard-paperclip-1.sh has installed the instance. Phase one
# writes the config and migrates the schema; this one fills it with a company,
# secrets, an agent that can actually authenticate to a model provider, and
# invite links for the humans.
#
# THE ENGINE MUST BE RUNNING. Not as a nicety — there is no offline path here.
# The board API key is minted through the engine, every paperclipai command is
# an HTTP request to it, and every phase below is a write. Step 1 deliberately
# leaves the engine stopped, so start it yourself and confirm with
#   ./onboard-paperclip-1.sh --check-engine
# This script checks the same thing before it touches anything, and refuses to
# start on an engine that is down or whose database is unreachable.
#
# The company, secret, agent and task are idempotent: each is looked up by name
# before it is created, so a re-run is a no-op and a partial run resumes. That
# is what makes this usable for migrating an environment, not just standing one
# up the first time.
#
# INVITES ARE THE EXCEPTION, and it is not a fixable one. A re-run mints a fresh
# link per role and the old ones stay live, so three runs leave nine usable
# credentials on the instance. There is no lookup that would avoid it: the token
# is stored hashed and is returned exactly once, at creation, so "reuse the
# existing invite" cannot print a link. If you are re-running to converge the
# rest, pass --only company,secrets,agent and mint invites deliberately; audit
# what is outstanding with `paperclipai invite list -C <id>` and revoke the rest.
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
#   ./onboard-paperclip-2.sh --verify     # report only, change NOTHING
#   ./onboard-paperclip-2.sh --mint-key --owner-email you@example.com
#
# ADDING AN AGENT TO A COMPANY THAT ALREADY EXISTS — use --add-agent, not a
# second full run. It creates the agent (and its task), reuses the company's
# existing OpenRouter secret, and touches neither ownership nor invites:
#
#   ./onboard-paperclip-2.sh --add-agent \
#     --owner-email you@example.com \
#     --company "Acme" \
#     --agent-name "Deepseek Agent" \
#     --codex-home /sysops/llm/openrouter/deepseek-v4-flash-0731 \
#     --model deepseek/deepseek-v4-flash-0731
#
# --company-id <uuid> targets the company exactly instead of by name. The
# --owner-email is only the identity this run's API key is minted as; it does
# not reassign ownership. Export PAPERCLIP_API_KEY to skip it entirely.
#
# A SECOND OPENROUTER KEY in the same company — the new agent gets its own
# credential and the existing agents keep theirs:
#
#   ./onboard-paperclip-2.sh --add-agent \
#     --owner-email you@example.com --company "Acme" \
#     --agent-name "Deepseek Agent" \
#     --secret-identity openrouter_api_key_2 \
#     --secret-name "OpenRouter (deepseek)" \
#     --openrouter-api-key-file /run/secrets/or-key-2 \
#     --codex-home /sysops/llm/openrouter/deepseek-v4-flash-0731 \
#     --model deepseek/deepseek-v4-flash-0731
#
# FOUR things carry a name here, and NONE of the three --secret-* flags takes
# the credential. Confusing them is the main way to produce an agent that looks
# configured and 401s — or, worse, to write a live API key into a plaintext
# column, which is exactly what happened before these were separated:
#
#   --secret-identity  what Paperclip FILES the secret under, e.g.
#                  openrouter_api_key_deepseek. Every lookup matches on it, so a
#                  new identity means a new secret rather than a rotation of the
#                  existing one. Stored in plaintext; 'secrets list' prints it.
#                  Paperclip's UI and API call this field "Key" — which is why
#                  the old --secret-key flag existed, and why it is now refused:
#                  "key" reads as the credential to nearly everyone.
#   --secret-name  a display LABEL. Matched on by NOTHING. On its own it will
#                  not give you a second secret, and on an existing secret it is
#                  ignored (the run says so).
#   --secret-env   the ENVIRONMENT VARIABLE the secret is bound to inside the
#                  AGENT PROCESS. It must match what the vault's config.toml
#                  auth command reads — for the stock OpenRouter vaults that is
#                  OPENROUTER_API_KEY, which is the default, so usually leave it.
#
#   the CREDENTIAL itself never goes in any of those. It goes in
#   --openrouter-api-key-file (preferred), --openrouter-api-key, or the ambient
#   $OPENROUTER_API_KEY — and only ever reaches the API through --value-env, so
#   it stays out of argv.
#
# Two agents can hold different credentials under different --secret-identity
# values and still bind both to the same --secret-env, because each vault reads
# the same variable name from its own process. That is the normal arrangement.
#
# Reusing an existing --secret-identity with a different credential ROTATES that
# secret, re-credentialling every agent already bound to it — so --add-agent
# refuses that and says this instead.
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
#   --model <id>           Codex model id for the agent, e.g.
#                          openai/gpt-5.6-luna. Becomes adapterConfig.model,
#                          which the adapter passes as `codex --model <id>`.
#                          It selects the model WITHIN the provider the Codex
#                          home's config.toml already chose, so it works
#                          alongside a user-managed CODEX_HOME. Omit to let the
#                          vault's own `model = ...` stand.
#   --codex-home <path>    CODEX_HOME for this agent, overriding the host's
#                          PAPERCLIP_CODEX_HOME. Point one agent at a second
#                          OpenRouter vault to test it side by side.
#                          NOTE: an explicit CODEX_HOME is a hand-off - Codex
#                          treats that home as user-managed, so Paperclip will
#                          not seed auth into it, merge PAPERCLIP_CODEX_PROVIDERS
#                          into it, or rewrite its config.toml. The vault must
#                          therefore carry its own working config.toml, and
#                          agents sharing a path share its session and lock state.
#   --openrouter-api-key <key>   the OpenRouter key to store as the managed
#                          secret. Creates it on first run; ROTATES it if the
#                          secret already exists, because passing a key by hand
#                          is an instruction, not a default. SECURITY: a flag
#                          value is visible in `ps` to every process on the host
#                          for the life of the run — prefer the -file form.
#   --openrouter-api-key-file <path>  same, read from a file. Nothing else on
#                          the box can see it. A trailing newline is stripped.
#                          Wins over --openrouter-api-key.
#                          With neither, $OPENROUTER_API_KEY is used as before,
#                          and an existing secret is reused rather than rotated.
#   --can-create-agents    let this agent hire other agents
#                          (permissions.canCreateAgents, server default FALSE).
#                          Distinct from the human `admin` invite's agents:create
#                          grant: that is a person's permission, this is the
#                          agent's own.
#   --task-title <text>    create a task and assign it to that agent
#   --task-prompt <text>   the task body — the agent's prompt. Required with
#                          --task-title.
#   --invite-roles <list>  comma list, one invite minted per entry.
#                          Default "owner,admin,operator" — three links.
#                          Valid: owner | admin | operator | viewer.
#   --add-agent            add an agent to a company that already exists.
#                          Implies --only agent,task, so no company is created,
#                          no invite is minted, and — the important one —
#                          instance ownership is NOT re-locked, which a normal
#                          run does on every pass and which revokes every live
#                          bootstrap invite as a side effect. Requires
#                          --agent-name and an existing company. The company's
#                          OpenRouter secret is looked up and reused.
#   --company-id <uuid>    target an existing company by id rather than name.
#                          Wins over --company and never creates anything.
#   --secret-identity <id> WHAT PAPERCLIP FILES THE SECRET UNDER — an
#                          identifier such as openrouter_api_key_deepseek.
#                          NEVER the credential: this is stored in plaintext
#                          and 'secrets list' prints it in full. Paperclip's
#                          own UI and API call this field "Key", which is what
#                          the old --secret-key flag was named after and why
#                          that flag is now refused outright.
#                          Every lookup matches on this, so a new identity
#                          creates a new secret rather than rotating the
#                          existing one — which is what lets one company hold
#                          two OpenRouter credentials. With --add-agent it also
#                          switches the secrets phase back on, since that phase
#                          is the only thing that creates a secret.
#                          Default openrouter_api_key.
#                          Also ONBOARD_SECRET_IDENTITY.
#   --secret-name <name>   the secret's display label. Matched on by nothing —
#                          on its own it will NOT give you a second secret. Pair
#                          it with --secret-identity. Default "OpenRouter".
#                          Also ONBOARD_SECRET_NAME.
#   --secret-env <VAR>     the ENVIRONMENT VARIABLE the secret is bound to in
#                          adapterConfig.env — the name the agent's child
#                          process actually sees, and the one the vault's
#                          config.toml auth command reads:
#                            args = ["-c", 'printf %s "$OPENROUTER_API_KEY"']
#                          Independent of --secret-identity: that names the
#                          credential inside Paperclip, this names it inside
#                          the process. Change it only when the vault reads
#                          something else, or the agent gets a secret bound to
#                          a name nothing looks at and 401s on first run.
#                          Default OPENROUTER_API_KEY. Also ONBOARD_SECRET_ENV.
#   --only <phases>        comma list: company,secrets,agent,invite,task
#   --skip-credential-check  skip the phase-6 provider probe. The probe runs
#                          `codex exec` against the vault with a one-word
#                          prompt and is the only check that catches an agent
#                          which looks configured and 401s on its first real
#                          task, so skip it only when a live provider call is
#                          unwanted. Also ONBOARD_SKIP_CREDENTIAL_CHECK=true.
#   --mint-key             print a board API key and exit
#   --pnpm                 run the CLI from this checkout (pnpm paperclipai,
#                          via tsx over cli/src) instead of the installed
#                          release, so a version you are editing in the IDE is
#                          what these scripts drive. Outranks PAPERCLIP_CLI and
#                          is passed through to onboard-paperclip-1.sh.
#   --dry-run      print what a run would do, change nothing. Tolerates a
#                  stopped engine so a plan can still be previewed.
#   --verify       report whether ownership, the company, the secret and the
#                  agent exist. Creates nothing, mints no invites, assigns no
#                  task. Exits 1 if anything is missing, so a test loop can gate
#                  on it. It will not mint an API key either — minting leaves a
#                  live credential behind, which is a change — so --verify needs
#                  PAPERCLIP_API_KEY already set.
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
#   ONBOARD_MODEL          Codex model id (see --model)
#   ONBOARD_CODEX_HOME     CODEX_HOME override (see --codex-home)
#   ONBOARD_CAN_CREATE_AGENTS  "true" to set permissions.canCreateAgents
#   ONBOARD_ADAPTER_TYPE   default "codex_local"
#   ONBOARD_SECRET_NAME    default "OpenRouter"
#   ONBOARD_SECRET_IDENTITY  default "openrouter_api_key"
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
VERIFY_FAILED=false
ARG_AGENT_NAME=""
ARG_TASK_TITLE=""
ARG_TASK_PROMPT=""
ARG_MODEL=""
ARG_CODEX_HOME=""
CAN_CREATE_AGENTS=false
USE_PNPM="${ONBOARD_USE_PNPM:-false}"
ARG_OR_KEY=""
ARG_OR_KEY_FILE=""
ARG_COMPANY_ID=""
ARG_SECRET_NAME=""
ARG_SECRET_IDENTITY=""
ARG_SECRET_ENV=""
# The end-of-run credential probe spends a few hundred provider tokens on a
# one-word prompt. Cheap next to an agent that 401s on its first real task, but
# it is a live API call, so it stays skippable.
SKIP_CRED_CHECK="${ONBOARD_SKIP_CREDENTIAL_CHECK:-false}"
# Add an agent to a company that already exists, rather than standing a tenant
# up from nothing. See the block after argument parsing for what it turns off.
ADD_AGENT=false
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
    --model)        ARG_MODEL="${2:?--model needs a value}"; shift 2 ;;
    --codex-home)   ARG_CODEX_HOME="${2:?--codex-home needs a value}"; shift 2 ;;
    --can-create-agents) CAN_CREATE_AGENTS=true; shift ;;
    --pnpm)         USE_PNPM=true; shift ;;
    --skip-credential-check) SKIP_CRED_CHECK=true; shift ;;
    --add-agent)    ADD_AGENT=true; shift ;;
    --company-id)   ARG_COMPANY_ID="${2:?--company-id needs a value}"; shift 2 ;;
    --secret-name)  ARG_SECRET_NAME="${2:?--secret-name needs a value}"; shift 2 ;;
    --secret-identity)   ARG_SECRET_IDENTITY="${2:?--secret-identity needs a value}"; shift 2 ;;
    # Retired, and deliberately an ERROR rather than an alias for either
    # meaning. "Key" reads as the credential to most people and as the identity
    # in Paperclip's own schema, and both readings existed in real commands: the
    # docs said identifier, an operator passed a live token. Aliasing it to the
    # identity keeps the trap; aliasing it to the credential silently turns an
    # older, correct `--secret-key openrouter_api_key_deepseek` into a run that
    # stores that literal string AS the API key. Refusing is the only reading
    # that cannot corrupt something quietly.
    # `die` is defined below this loop, so this reports the way the loop's own
    # unknown-argument case does.
    --secret-key)
      cat >&2 <<'RETIRED'
onboard-2: --secret-key is ambiguous and no longer accepted — say which you mean.

         The IDENTIFIER Paperclip files the secret under (its "Key" column,
         printed in full by 'secrets list' — never put a credential here):
           --secret-identity openrouter_api_key_deepseek

         The CREDENTIAL itself:
           --openrouter-api-key-file <path>     (preferred: never in argv)
           --openrouter-api-key <value>         (visible in ps)
           $OPENROUTER_API_KEY in the environment
RETIRED
      exit 2 ;;
    --secret-env)   ARG_SECRET_ENV="${2:?--secret-env needs a value}"; shift 2 ;;
    # Prefer --openrouter-api-key-file: a flag value is visible in `ps` to
    # every process on this box for as long as the script runs.
    --openrouter-api-key)      ARG_OR_KEY="${2:?--openrouter-api-key needs a value}"; shift 2 ;;
    --openrouter-api-key-file) ARG_OR_KEY_FILE="${2:?--openrouter-api-key-file needs a path}"; shift 2 ;;
    # Accepts a key on the command line for convenience. Prefer the environment:
    # an argument is visible in `ps` to every process on the box.
    --api-key)      ARG_API_KEY="${2:?--api-key needs a value}"; shift 2 ;;
    # Print the whole leading comment block, however long it grows. This was a
    # fixed `sed -n '2,120p'`, which silently truncated --help the moment the
    # header passed line 120 — the newest flags, the ones most needing
    # documentation, were the ones cut off.
    -h|--help)      awk 'NR>1 { if (/^#/) print; else exit }' "$0"; exit 0 ;;
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

# Same reasoning as the --secret-key flag: refuse the retired name rather than
# guess which meaning a stale environment intended.
[ -z "${ONBOARD_SECRET_KEY:-}" ] || die "ONBOARD_SECRET_KEY is retired and ambiguous.
         Rename it to ONBOARD_SECRET_IDENTITY if it holds an identifier such as
         'openrouter_api_key_deepseek'. If it holds an actual credential, unset
         it and pass the value as \$OPENROUTER_API_KEY instead."

# The third of the three, and the one that actually reaches the agent process:
# the ENVIRONMENT VARIABLE the secret is bound to in adapterConfig.env. It must
# match what the vault's config.toml auth command reads —
#   command = "sh"; args = ["-c", 'printf %s "$OPENROUTER_API_KEY"']
# — which is why the default is OPENROUTER_API_KEY and not derived from
# --secret-identity. The two are independent: --secret-identity names the credential
# inside Paperclip, --secret-env names it inside the spawned child.
SECRET_ENV="${ARG_SECRET_ENV:-${ONBOARD_SECRET_ENV:-OPENROUTER_API_KEY}}"
# It becomes a shell variable name in the probe (`env "NAME=value"`) and a JSON
# object key in adapterConfig.env. A name with an `=` or a space would produce a
# malformed binding that the API rejects with a message about env bindings in
# general, pointing nowhere near the flag that caused it.
case "$SECRET_ENV" in
  [A-Za-z_]*) [[ "$SECRET_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || die "--secret-env '$SECRET_ENV' is not a valid environment variable name
         (letters, digits and underscore; not starting with a digit)" ;;
  *) die "--secret-env '$SECRET_ENV' is not a valid environment variable name
         (letters, digits and underscore; not starting with a digit)" ;;
esac

# --secret-identity takes an IDENTIFIER, not the credential. The two are easy to
# confuse — both are "the key" in English — and nothing downstream catches it:
# the API's own validator is /^[a-zA-Z0-9_.-]{1,120}$/, which an OpenRouter
# token satisfies. The result is a live API key written into the secret's `key`
# column, a plaintext identity field that `secrets list` prints in full, while
# the value field it should have gone into holds whatever was in the ambient
# environment. Nothing errors and the agent works, so the leak is silent.
#
# The value also reaches argv, readable by any process on the host via `ps`.
if [ -n "$ARG_SECRET_IDENTITY" ]; then
  _sk_bad=""
  case "$ARG_SECRET_IDENTITY" in
    sk-*|pk-*|sk_*|ghp_*|xoxb-*) _sk_bad="it starts with a known API-token prefix" ;;
  esac
  if [ -z "$_sk_bad" ] && [ -n "${OPENROUTER_API_KEY:-}" ] \
     && [ "$ARG_SECRET_IDENTITY" = "$OPENROUTER_API_KEY" ]; then
    _sk_bad="it is byte-for-byte your \$OPENROUTER_API_KEY"
  fi
  # 60 chars with no underscore is not a name anyone types; identifiers here
  # look like openrouter_api_key_deepseek.
  if [ -z "$_sk_bad" ] && [ "${#ARG_SECRET_IDENTITY}" -gt 60 ]; then
    case "$ARG_SECRET_IDENTITY" in *_*) : ;; *) _sk_bad="it is ${#ARG_SECRET_IDENTITY} characters with no underscore" ;; esac
  fi
  if [ -n "$_sk_bad" ]; then
    die "--secret-identity looks like a credential, not an identifier — $_sk_bad.

         --secret-identity is the secret's NAME INSIDE PAPERCLIP, stored in a
         plaintext identity column and printed in full by 'secrets list'. It is
         not where the credential goes. Something like:
           --secret-identity openrouter_api_key_deepseek

         The credential itself goes here, and only here:
           --openrouter-api-key-file <path>     (preferred: never in argv)
           --openrouter-api-key <value>         (visible in ps)
           \$OPENROUTER_API_KEY in the environment

         If a previous run already stored a credential this way, treat that key
         as disclosed: rotate it at the provider, then delete the secret."
  fi
  unset _sk_bad
fi

# --------------------------------------------------------------- add-agent --
# Adding the second agent is not a smaller version of standing up the tenant; it
# is a different operation, and running the full script again to get one agent
# does three things nobody asked for. So this mode turns them off:
#
#   1. Ownership. The preflight re-locks instance_admin and REVOKES every live
#      bootstrap invite on every run. Correct exactly once, at handover; on the
#      fifth agent it is a live credential being destroyed as a side effect of
#      an unrelated command. --add-agent never touches ownership.
#   2. Company creation. A typo in --company would otherwise create a SECOND
#      company and put the agent in it, which looks like success and is very
#      confusing later. Here the company must already exist.
#   3. Invites. Minting three more links per agent is credential litter.
#
# What is left is the agent, its task, and the credential probe. The secret is
# reused: the agent phase already looks it up by key when the secret phase is
# skipped, so a second agent shares the first one's OpenRouter secret and
# rotating it moves both.
if [ "$ADD_AGENT" = true ]; then
  # An explicit --only still wins, so `--add-agent --only agent` skips the task.
  #
  # --secret-identity asks for a SEPARATE credential, which cannot happen with the
  # secrets phase switched off — the phase is the only thing that creates one.
  # So requesting a distinct key switches it back on, and the new agent binds to
  # the secret that phase produces rather than to the company's existing one.
  if [ -z "$ONLY" ]; then
    if [ -n "$ARG_SECRET_IDENTITY" ]; then ONLY="secrets,agent,task"; else ONLY="agent,task"; fi
  fi
  [ -n "$ARG_AGENT_NAME" ] || die "--add-agent needs --agent-name.
         Without it the name defaults to 'Codex Worker', the agent phase finds
         the existing agent of that name, reports 'exists', and creates nothing
         — a silent no-op that reads like success."
fi

# ------------------------------------------------------------------- cli ----
# Same resolution order as onboard-paperclip.sh, so both scripts agree on which
# binary they are driving.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The workspace checkout, found by walking up for pnpm-workspace.yaml.
find_repo_root() {
  local d="${PAPERCLIP_REPO_ROOT:-$SCRIPT_DIR}"
  while [ "$d" != "/" ]; do
    [ -f "$d/pnpm-workspace.yaml" ] && { printf '%s' "$d"; return 0; }
    d="$(dirname "$d")"
  done
  return 1
}

# --pnpm drives the CLI from the working tree instead of the installed release.
#
# --silent is load-bearing: pnpm writes its "> paperclip@ paperclipai ..."
# banner to STDOUT, and nearly every call in this script is
# `... --json | jq -r '.id'`. Without it the first capture returns pnpm chatter
# and the run dies on "company create returned no id" - a message pointing at
# the API when the real fault is the runner.
#
# It outranks PAPERCLIP_CLI on purpose: the container exports that pointing at
# the release binary, so checking it first would make --pnpm a no-op here.
if [ "$USE_PNPM" = true ]; then
  command -v pnpm > /dev/null 2>&1 || die "--pnpm needs pnpm on PATH"
  REPO_ROOT="$(find_repo_root)" \
    || die "--pnpm: no pnpm-workspace.yaml above $SCRIPT_DIR.
         Set PAPERCLIP_REPO_ROOT to the checkout root."
  PC=(pnpm --silent --dir "$REPO_ROOT" paperclipai)
elif [ -n "${PAPERCLIP_CLI:-}" ]; then
  read -r -a PC <<< "$PAPERCLIP_CLI"
elif command -v paperclipai > /dev/null 2>&1; then
  PC=(paperclipai)
elif command -v pnpm > /dev/null 2>&1 && REPO_ROOT="$(find_repo_root)"; then
  PC=(pnpm --silent --dir "$REPO_ROOT" paperclipai)
else
  die "no Paperclip CLI found — set PAPERCLIP_CLI, put paperclipai on PATH, or use --pnpm"
fi
command -v jq > /dev/null 2>&1 || die "jq is required"

# ---------------------------------------------------------------- inputs ----
: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is not set — is the container env sourced?}"

# ---------------------------------------------------------------- engine ----
# Step 2 needs a RUNNING engine for all of it, not just for convenience:
#   * the board API key is minted through it (POST /api/board-api-keys)
#   * every paperclipai command below is an HTTP request to it
#   * ownership, company, secret, agent, invites and the task are all writes
# There is no offline path here, so this is a hard gate rather than a warning.
#
# It runs BEFORE minting deliberately. Minting first meant a stopped engine
# announced itself as a curl failure from inside the key request, which reads
# like an auth problem and sends you looking at proxy headers.
#
# `status` is checked, not merely reachability. /api/health answers
# status:"unhealthy" with error:"database_unreachable" when the process is up
# but Postgres is not (server/src/routes/health.ts), and bootstrapStatus is then
# absent — which the previous check read as "unknown" and let straight through.
HEALTH=""
BOOTSTRAP="unknown"
require_engine() {
  local status err
  HEALTH="$(curl -fsS --max-time 5 "${PAPERCLIP_API_URL%/}/api/health" 2>/dev/null || true)"

  if [ -z "$HEALTH" ]; then
    if [ "$DRY_RUN" = true ]; then
      info "engine:        NOT RUNNING — continuing because this is --dry-run"
      return 0
    fi
    die "the engine is not running: nothing answered ${PAPERCLIP_API_URL%/}/api/health.
         Everything this script does is an HTTP request to it, so there is
         nothing it can do until it is up. Start it, confirm with
           ./onboard-paperclip-1.sh --check-engine
         and re-run."
  fi

  status="$(printf '%s' "$HEALTH" | jq -r '.status // "unknown"')"
  BOOTSTRAP="$(printf '%s' "$HEALTH" | jq -r '.bootstrapStatus // "unknown"')"

  if [ "$status" != "ok" ]; then
    err="$(printf '%s' "$HEALTH" | jq -r '.error // "no error reported"')"
    die "the engine is running but reports status='$status' ($err).
         An engine whose database is unreachable still answers /api/health and
         still fails every write — which is the expensive way to find out. Fix
         that, confirm with ./onboard-paperclip-1.sh --check-engine, re-run."
  fi

  info "engine:        running and healthy at ${PAPERCLIP_API_URL%/}   (commit $(printf '%s' "$HEALTH" | jq -r '.commit // "unknown"'))"
}

# In --mint-key mode the ONLY thing on stdout may be the key itself. The
# documented way to use it is a command substitution -
#   export PAPERCLIP_API_KEY="$(./onboard-paperclip-2.sh --mint-key ...)"
# which the --verify failure below recommends by name - and step/info write to
# stdout, so the preflight banner was captured along with the key. The result
# was a 163-character "key" whose first three lines were a progress report, and
# the only symptom was `access whoami` failing as if the token were wrong.
# Diagnostics go to stderr here; the operator still sees them.
if [ "$MINT_KEY" = true ]; then
  { step 0/6 "Preflight"; require_engine; } >&2
else
  step 0/6 "Preflight"
  require_engine
fi

# ------------------------------------------------------------- mint a key ---
# Minting is a function, not a mode, so the normal run can do it silently.
# Requiring the operator to mint separately and export the result was two steps
# for something the script can always do for itself.
mint_board_key() {
  local email="$1" hdr base resp key
  command -v curl > /dev/null 2>&1 || die "curl is required to mint an API key"
  # Every call here is an authenticated write, so the run needs a board key, and
  # minting one over proxy auth needs an identity to mint it AS. Under
  # --add-agent that is the whole of what the email does — it does not reassign
  # ownership and does not revoke anything — which is worth saying, because
  # "owner" in the flag name suggests otherwise and makes the requirement look
  # like it will change who owns the instance.
  [ -n "$email" ] || die "minting a board API key needs an identity to mint it as.
         Pass --owner-email you@example.com, or set ONBOARD_OWNER_EMAIL, or
         supply a key directly:
           export PAPERCLIP_API_KEY=\"\$(./onboard-paperclip-2.sh --mint-key --owner-email you@example.com)\"
$([ "$ADD_AGENT" = true ] && printf '%s' "
         With --add-agent the email is used ONLY to mint this run's key.
         Ownership is not touched and no invite is revoked.")"
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
if [ -z "${PAPERCLIP_API_KEY:-}" ] && [ "$VERIFY_ONLY" = true ]; then
  die "--verify changes nothing, and minting a board API key IS a change: it
         leaves a live credential on the instance. Supply one instead —
           export PAPERCLIP_API_KEY=\"\$(./onboard-paperclip-2.sh --mint-key --owner-email ${OWNER_EMAIL:-you@example.com})\"
         then re-run with --verify."
fi
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
# The KEY is the identity: every lookup in this script matches on it, and the
# agent binds to whatever secret carries it. The NAME is a display label and is
# matched on by nothing — so changing only the name gets you the same secret
# under a new label on creation, and on an existing secret it does nothing at
# all. To hold a SECOND OpenRouter credential in one company, give it a
# different --secret-identity.
SECRET_NAME="${ARG_SECRET_NAME:-${ONBOARD_SECRET_NAME:-OpenRouter}}"
SECRET_IDENTITY="${ARG_SECRET_IDENTITY:-${ONBOARD_SECRET_IDENTITY:-openrouter_api_key}}"
INVITE_ROLES="${ARG_INVITE_ROLES:-${ONBOARD_INVITE_ROLES:-owner,admin,operator}}"
# --codex-home overrides the host's PAPERCLIP_CODEX_HOME for THIS agent only,
# which is what makes a second vault testable without touching the container
# environment: point one agent at a different OpenRouter home and compare.
#
# The value is bound as CODEX_HOME, and that is a deliberate hand-off - Codex
# treats an explicit CODEX_HOME as a user-managed home, so Paperclip does not
# seed auth into it, merge PAPERCLIP_CODEX_PROVIDERS, or rewrite its
# config.toml. The vault's own config.toml is therefore authoritative for the
# provider, and --model layers on top of it as a CLI flag.
CODEX_HOME_VALUE="${ARG_CODEX_HOME:-${ONBOARD_CODEX_HOME:-${PAPERCLIP_CODEX_HOME:-}}}"

# Codex model id, e.g. openai/gpt-5.6-luna. Passed as adapterConfig.model, which
# the adapter turns into `codex --model <id>` (codex-args.ts). That flag picks
# the model WITHIN the provider the home's config.toml already selects, so it
# works with a user-managed CODEX_HOME even though the config.toml does not.
# Empty means "say nothing", and the vault's own `model = ...` applies.
MODEL="${ARG_MODEL:-${ONBOARD_MODEL:-}}"

# permissions.canCreateAgents defaults to FALSE server-side (agent.ts), so an
# agent cannot hire other agents unless this is set. Distinct from the human
# `admin` invite's agents:create grant - that is a person's permission, this is
# the agent's own.
[ "${ONBOARD_CAN_CREATE_AGENTS:-}" = "true" ] && CAN_CREATE_AGENTS=true
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
# The engine gate above already ran and left $BOOTSTRAP holding the instance's
# claim state.
#
# An unclaimed instance has no instance_admin, and company creation then fails
# with "Creating companies requires board/instance-admin authentication" — a
# message that points at agent API keys and sends you the wrong way entirely.
# Settle the real precondition first, rather than failing at 1/6.
#
# Lock ownership to --owner-email, every run, whatever state the instance is in.
#
# Not just when unclaimed. Script 1 leaves a bootstrap_ceo invite link behind,
# and anyone holding it can claim ownership until it is redeemed or expires.
# This makes the named email the sole instance_admin and revokes those links, so
# whatever happened between the two scripts is overwritten deterministically.
if [ "$ADD_AGENT" = true ]; then
  # Deliberately not touched: re-locking would revoke live bootstrap invites as
  # a side effect of adding an agent. --owner-email may still be supplied here,
  # but it is used ONLY to mint this run's API key, never to reassign ownership.
  info "ownership:     not touched (--add-agent)"
  if [ "$BOOTSTRAP" = "bootstrap_pending" ]; then
    die "the instance is unclaimed, so there is no company to add an agent to.
         Run the full onboarding first:
           ./onboard-paperclip-2.sh --owner-email you@example.com --company '<name>'"
  fi
elif [ "$VERIFY_ONLY" = true ]; then
  info "ownership:     not touched (--verify changes nothing)"
  info "bootstrap:     $BOOTSTRAP"
  if [ "$BOOTSTRAP" != "ready" ]; then
    info "MISSING:       no instance_admin — the instance is unclaimed"
    VERIFY_FAILED=true
  fi
elif [ -n "$OWNER_EMAIL" ]; then
  OWNER_TOOL="$(dirname "$0")/onboard-paperclip-1.sh"
  if [ -x "$OWNER_TOOL" ]; then
    if [ "$DRY_RUN" = true ]; then
      info "would lock instance ownership to $OWNER_EMAIL and revoke bootstrap invites"
    else
      info "locking instance ownership to $OWNER_EMAIL ..."
      # Hand --pnpm on, so both halves drive the same CLI. Ownership itself is
      # psql and curl, but a split runner is the kind of thing that is invisible
      # until the two disagree about which build is installed.
      OWNER_ARGS=(--set-owner --owner-email "$OWNER_EMAIL")
      [ "$USE_PNPM" = true ] && OWNER_ARGS+=(--pnpm)
      "$OWNER_TOOL" "${OWNER_ARGS[@]}" \
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
if [ -z "$WHOAMI" ]; then
  if [ "$DRY_RUN" = true ]; then
    info "whoami:        skipped — no live engine to ask (--dry-run)"
  else
    die "access whoami failed — PAPERCLIP_API_KEY is missing, wrong, or the engine
         is down. Every later step would fail as a confusing 401. Fix the token first."
  fi
else
  info "authenticated: $(printf '%s' "$WHOAMI" | jq -r '.email // .userId // "board user"')"
fi
[ "$MINTED_THIS_RUN" = true ] && info "api key:       minted for this run (not stored)"
info "connecting to: $PAPERCLIP_API_URL   (internal — every request goes here)"
info "invite links:  ${BASE_URL:-<unset>}   (text only — never connected to)"
if [ -z "$PUBLIC_URL" ]; then
  info "note: no public URL set, so invite links fall back to the API URL."
  info "      If that is an internal hostname, the links will not open from a"
  info "      normal browser. Pass --public-url https://<fqdn> to fix it."
fi

# --------------------------------------------------- the OpenRouter key -----
# Three ways in, and the difference between them is who else can read the key.
#
#   --openrouter-api-key-file  a file. Nothing else on the box can see it, and
#                              it is what to use from a script or a vault.
#   --openrouter-api-key       the value on the command line. Convenient, and
#                              visible in `ps` to every process on this host for
#                              as long as this script runs. Warned about below.
#   $OPENROUTER_API_KEY        the ambient environment, as before.
#
# Whichever way it arrives, it is re-exported and handed to the CLI as
# --value-env. The value therefore never appears in `paperclipai`'s own argv,
# which is the process that would otherwise sit in `ps` for the length of an
# HTTP round trip.
#
# KEY_SOURCE drives one behaviour further down: an EXPLICIT key (flag or file)
# rotates an existing secret, an ambient one does not. Re-running onboarding
# with the environment already set must stay a no-op; passing a key by hand is
# an instruction, and silently ignoring it because the secret already existed is
# the kind of no-op that gets discovered days later, after a rotation "did not
# take".
KEY_SOURCE="none"
if [ -n "$ARG_OR_KEY_FILE" ]; then
  [ -f "$ARG_OR_KEY_FILE" ] || die "--openrouter-api-key-file: no such file: $ARG_OR_KEY_FILE"
  # Strip a trailing newline, which every editor adds and which would otherwise
  # be sent as part of the credential and rejected by the provider.
  OPENROUTER_API_KEY="$(tr -d '\r\n' < "$ARG_OR_KEY_FILE")"
  [ -n "$OPENROUTER_API_KEY" ] || die "--openrouter-api-key-file: $ARG_OR_KEY_FILE is empty"
  KEY_SOURCE="file"
elif [ -n "$ARG_OR_KEY" ]; then
  OPENROUTER_API_KEY="$ARG_OR_KEY"
  KEY_SOURCE="flag"
elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
  KEY_SOURCE="env"
fi
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

# Passing a key when the secrets phase is not running is almost always a
# misunderstanding: the new agent binds a secret_ref to the company's EXISTING
# secret, so a key supplied here is never stored and never reaches the agent. It
# is still used to probe the vault in phase 6, so it is not inert — but silently
# accepting it would let someone believe they had rotated a credential when
# nothing was written.
# Only for a key passed deliberately (flag or file). An ambient
# $OPENROUTER_API_KEY is how the vault probe authenticates and is expected to be
# present on every run, so saying this about it would be noise on every run.
if { [ "$KEY_SOURCE" = "flag" ] || [ "$KEY_SOURCE" = "file" ]; } && ! want secrets; then
  info "note:    the key you passed is NOT stored on this run (the secrets phase"
  info "         is skipped), so the agent binds the company's existing secret."
  info "         To rotate it: --only secrets --openrouter-api-key-file <path>"
fi

if [ "$KEY_SOURCE" = "flag" ] && [ "$DRY_RUN" = false ]; then
  info "WARNING: --openrouter-api-key puts the key in this script's argv, where"
  info "         any process on this host can read it from \`ps\` until the run"
  info "         ends. --openrouter-api-key-file avoids that."
fi

if [ "$VERIFY_ONLY" = false ] && [ -z "${OPENROUTER_API_KEY:-}" ] && want secrets; then
  die "no OpenRouter key supplied. Refusing to create an empty secret — an empty
         credential fails at first agent run, not here, which is the expensive
         place to find out. Supply one of:
           export OPENROUTER_API_KEY=sk-or-...
           --openrouter-api-key-file /path/to/key
           --openrouter-api-key sk-or-...        (visible in ps)
         or skip the secret with --only company,agent."
fi

# ----------------------------------------------------------------- company --
COMPANY_ID=""
# An id names the company exactly, so it settles the question before any phase
# gate or name lookup gets a say: two companies may share a display name, and a
# name lookup would pick whichever the API listed first. Checked ahead of
# `want company` on purpose — an id is an instruction to use THAT company, and
# creating one would contradict it.
if [ -n "$ARG_COMPANY_ID" ]; then
  COMPANY_ID="$ARG_COMPANY_ID"
  step 1/6 "Company $COMPANY_ID"
  if [ "$DRY_RUN" = true ]; then
    info "would use existing company $COMPANY_ID"
  else
    COMPANY_NAME="$("${PC[@]}" company get "$COMPANY_ID" --json 2>/dev/null | jq -r '.name // empty' || true)"
    [ -n "$COMPANY_NAME" ] || die "no company with id '$ARG_COMPANY_ID' — check: paperclipai company list"
    info "exists: $COMPANY_NAME"
  fi
elif want company; then
  step 1/6 "Company '$COMPANY_NAME'"
  COMPANY_ID="$("${PC[@]}" company list --json 2>/dev/null \
    | jq -r --arg n "$COMPANY_NAME" 'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end
        | map(select(.name == $n)) | .[0].id // empty' || true)"
  if [ -n "$COMPANY_ID" ]; then
    info "exists: $COMPANY_ID"
  elif [ "$VERIFY_ONLY" = true ]; then
    info "MISSING: no company named '$COMPANY_NAME'"
    VERIFY_FAILED=true
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
        | map(select(.name == $n)) | .[0].id // empty' || true)"
  # A dry run holds a placeholder key, so every lookup above comes back empty.
  # Failing here would report "no such company" about a company that exists,
  # which is worse than not checking — the point of --dry-run is the plan.
  if [ -z "$COMPANY_ID" ] && [ "$DRY_RUN" = true ]; then
    step 1/6 "Company '$COMPANY_NAME'"
    info "would use the existing company (not resolvable in --dry-run)"
    COMPANY_ID="<existing>"
  elif [ -z "$COMPANY_ID" ] && [ "$ADD_AGENT" = true ]; then
    # Naming the alternatives matters more here than anywhere else in the
    # script: the default company name is "YourITDept", so an --add-agent run
    # that forgets --company fails against a name the operator never typed.
    die "no company named '$COMPANY_NAME'.
         --add-agent never creates one — pass --company '<exact name>' or
         --company-id <uuid>. What exists:
$("${PC[@]}" company list --json 2>/dev/null | jq -r 'if type=="array" then . else (.items // .companies // []) end
    | .[] | "           \(.name)  \(.id)"' 2>/dev/null || printf '           (could not list companies)')"
  fi
  [ -n "$COMPANY_ID" ] || die "company '$COMPANY_NAME' not found and --only excluded creating it"
fi

# Without a company there is no -C to pass, so every check below would fail as
# a permissions error rather than as the missing company it actually is.
if [ "$VERIFY_ONLY" = true ] && [ -z "$COMPANY_ID" ]; then
  echo
  echo "VERIFY: FAILED — company '$COMPANY_NAME' does not exist, so nothing"
  echo "        underneath it could be checked. Nothing was changed."
  exit 1
fi

# ----------------------------------------------------------------- secret ---
SECRET_ID=""
if want secrets; then
  step 2/6 "Secret '$SECRET_NAME'"
  SECRET_ROW="$("${PC[@]}" secrets list -C "$COMPANY_ID" --json 2>/dev/null \
    | jq -c --arg k "$SECRET_IDENTITY" 'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end
        | map(select(.key == $k)) | .[0] // empty' || true)"
  SECRET_ID="$(printf '%s' "$SECRET_ROW" | jq -r '.id // empty' 2>/dev/null || true)"
  SECRET_EXISTING_NAME="$(printf '%s' "$SECRET_ROW" | jq -r '.name // empty' 2>/dev/null || true)"
  # Matching is by key alone, so an existing secret keeps the name it was
  # created with and a different --secret-name is silently discarded. Silently
  # is the problem: the run reports success, the label in the UI never changes,
  # and there is nothing to connect the two. Say it outright.
  if [ -n "$SECRET_ID" ] && [ -n "$ARG_SECRET_NAME" ] \
     && [ "$SECRET_EXISTING_NAME" != "$SECRET_NAME" ]; then
    info "note:    --secret-name '$SECRET_NAME' ignored — key '$SECRET_IDENTITY' already"
    info "         exists as '$SECRET_EXISTING_NAME', and lookups match on the key."
    info "         For a SEPARATE secret use a new --secret-identity; to relabel this"
    info "         one: paperclipai secrets update $SECRET_ID \\"
    info "                --payload-json '$(jq -nc --arg n "$SECRET_NAME" '{name:$n}')'"
  fi
  if [ -n "$SECRET_ID" ]; then
    # An explicitly-supplied key means "use this one". The secret already
    # existing must not turn that into a no-op, so rotate it in place: every
    # agent bound to it picks the new value up on its next run, and no agent is
    # edited. An ambient $OPENROUTER_API_KEY is left alone - a re-run of
    # onboarding on a configured host should not rotate anything.
    # Rotating in place is right when onboarding a tenant — one credential, one
    # place to change it. It is almost never right while ADDING an agent: the
    # secret is already bound to the agents that came before, so a new key here
    # silently re-credentials all of them, and the only symptom is the other
    # agents changing behaviour for no visible reason. Refuse, and name the two
    # things the operator might actually have meant.
    # Not just the default key: ANY secret that already exists may already be
    # bound to an agent, so the hazard is "this secret exists", not "this secret
    # is the default one". Rotating is a deliberate re-credentialling of every
    # agent bound to it, which is a different job from adding an agent — so it
    # is refused here and directed at a run that says so.
    if [ "$ADD_AGENT" = true ] \
       && { [ "$KEY_SOURCE" = "flag" ] || [ "$KEY_SOURCE" = "file" ]; } \
       && [ "$VERIFY_ONLY" = false ]; then
      die "refusing to rotate an existing secret while adding an agent.
         Secret $SECRET_ID (key '$SECRET_IDENTITY') already exists, so it may already
         be bound to this company's other agents. Rotating it here would change
         THEIR credential too, silently.

         For a second, separate OpenRouter key — what --add-agent usually means:
           --secret-identity ${SECRET_IDENTITY}_2 --secret-name '<a label>'
         That creates a new secret and binds the new agent to it; existing
         agents keep theirs.

         To genuinely re-credential every agent bound to '$SECRET_IDENTITY', do it as
         its own operation, without --add-agent:
           ./onboard-paperclip-2.sh --only secrets --company '$COMPANY_NAME' \\
             --secret-identity '$SECRET_IDENTITY' --openrouter-api-key-file <path>"
    fi
    case "$KEY_SOURCE" in
      flag|file)
        if [ "$DRY_RUN" = true ]; then
          info "exists: $SECRET_ID — would rotate it to the key from --openrouter-api-key${KEY_SOURCE:+-$KEY_SOURCE}"
        elif [ "$VERIFY_ONLY" = true ]; then
          info "exists: $SECRET_ID  (--verify changes nothing, so it was not rotated)"
        else
          "${PC[@]}" secrets rotate "$SECRET_ID" --value-env OPENROUTER_API_KEY > /dev/null \
            || die "could not rotate secret $SECRET_ID — the old value is still in place"
          info "exists: $SECRET_ID — rotated to the supplied key"
          info "        every agent bound to it uses the new value on its next run"
        fi
        ;;
      *)
        info "exists: $SECRET_ID  (rotate with: paperclipai secrets rotate)"
        ;;
    esac
  elif [ "$VERIFY_ONLY" = true ]; then
    info "MISSING: no secret with key '$SECRET_IDENTITY'"
    VERIFY_FAILED=true
  elif [ "$DRY_RUN" = true ]; then
    info "would create secret '$SECRET_NAME' from the key supplied via $KEY_SOURCE"; SECRET_ID="<new>"
  else
    # --value-env, never --value: the value must not appear in argv, where any
    # process on the box could read it out of `ps`.
    SECRET_ID="$("${PC[@]}" secrets create --json \
      -C "$COMPANY_ID" \
      --name "$SECRET_NAME" \
      --key "$SECRET_IDENTITY" \
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
  # Adding an agent to an existing company is the main reason to run with
  # --only, and `--only agent` skipped the secret phase above and so left
  # SECRET_ID empty - which silently produced an agent with CODEX_HOME bound
  # but NO OPENROUTER_API_KEY. That agent looks perfectly configured and 401s
  # on its first real run, which is the expensive place to find out.
  #
  # So resolve the secret here when the phase did not: a lookup, never a
  # create, so it stays correct under --verify and --dry-run too.
  if [ -z "$SECRET_ID" ] && [ "$DRY_RUN" = false ]; then
    SECRET_ID="$("${PC[@]}" secrets list -C "$COMPANY_ID" --json 2>/dev/null \
      | jq -r --arg k "$SECRET_IDENTITY" 'if type=="array" then . else (.items // .secrets // []) end
          | map(select(.key == $k)) | .[0].id // empty' || true)"
    [ -n "$SECRET_ID" ] && info "secret:  reusing $SECRET_ID (key $SECRET_IDENTITY)"
  fi
  if [ -z "$SECRET_ID" ] && [ "$DRY_RUN" = false ] && [ "$VERIFY_ONLY" = false ]; then
    die "no secret with key '$SECRET_IDENTITY' exists in this company, so the agent
         would be created with no provider credential and 401 on its first run.
         Create it first: drop --only, or use --only secrets,agent."
  fi
  AGENT_ID="$("${PC[@]}" agent list -C "$COMPANY_ID" --json 2>/dev/null \
    | jq -r --arg n "$AGENT_NAME" 'if type=="array" then . else (.items // .invites // .companies // .agents // .secrets // []) end
        | map(select(.name == $n)) | .[0].id // empty' || true)"
  if [ -n "$AGENT_ID" ]; then
    info "exists: $AGENT_ID"
  elif [ "$VERIFY_ONLY" = true ]; then
    info "MISSING: no agent named '$AGENT_NAME'"
    VERIFY_FAILED=true
  elif [ "$DRY_RUN" = true ]; then
    info "would create agent '$AGENT_NAME' ($ADAPTER_TYPE)"
    info "  model:            ${MODEL:-<the vault config.toml default>}"
    info "  codexHome:        ${CODEX_HOME_VALUE:-<the Paperclip-managed home>}"
    info "  canCreateAgents:  $CAN_CREATE_AGENTS"
    AGENT_ID="<new>"
  else
    # The credential is bound as a secret_ref rather than left to the host
    # environment. Resolved adapter env is merged AFTER the ACPX host-env
    # projection and is not filtered by it, so a bound key always reaches the
    # child process. A host-exported one depends on the allowlist.
    # The binding VARIABLE NAME is $SECRET_ENV, not a literal: it has to match
    # whatever the vault's config.toml auth command actually reads. The default
    # vaults read $OPENROUTER_API_KEY, but a vault reading anything else would
    # get a secret bound to a name nothing looks at — configured-looking, and
    # 401 on first run.
    ENV_JSON="$(jq -nc --arg sid "$SECRET_ID" --arg home "$CODEX_HOME_VALUE" --arg envk "$SECRET_ENV" '
      ({}
       | if $home == "" then . else .CODEX_HOME = {type:"plain", value:$home} end
       | if $sid  == "" then . else .[$envk] = {type:"secret_ref", secretId:$sid} end)')"
    # Both optional fields are OMITTED when empty rather than sent as "" or
    # false: adapterConfig.model="" would suppress the --model flag the vault
    # relies on, and an explicit permissions object is worth sending only when
    # it actually changes a default.
    AGENT_ID="$("${PC[@]}" agent create --json -C "$COMPANY_ID" --payload-json \
      "$(jq -nc --arg n "$AGENT_NAME" --arg t "$ADAPTER_TYPE" --argjson env "$ENV_JSON" \
         --arg model "$MODEL" --argjson cca "$CAN_CREATE_AGENTS" '
         {name:$n, adapterType:$t, adapterConfig:{env:$env}}
         | if $model == "" then . else .adapterConfig.model = $model end
         | if $cca then .permissions = {canCreateAgents:true} else . end')" | jq -r '.id')"
    [ -n "$AGENT_ID" ] && [ "$AGENT_ID" != "null" ] || die "agent create returned no id"
    info "created: $AGENT_ID"
    info "bound:   CODEX_HOME=${CODEX_HOME_VALUE:-<managed>}, ${SECRET_ENV}=secret_ref"
    info "model:   ${MODEL:-<unset - the vault config.toml applies>}"
    info "canCreateAgents: $CAN_CREATE_AGENTS"
  fi
fi

# ---------------------------------------------------------------- invites ---
# Minting an invite creates a live credential, so --verify never enters here;
# the verify block below counts what already exists instead.
if want invite && [ "$VERIFY_ONLY" = false ]; then
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
if want task && [ -n "$TASK_TITLE" ] && [ "$VERIFY_ONLY" = false ]; then
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

# ------------------------------------------------------ credential probe ----
# Resolve a `codex` binary to probe the vault with. CODEX_BIN wins so an operator
# can aim at a specific build; otherwise PATH, then the two node_modules
# locations this deployment actually uses.
find_codex_bin() {
  local c
  if [ -n "${CODEX_BIN:-}" ]; then
    [ -x "$CODEX_BIN" ] && { printf '%s' "$CODEX_BIN"; return 0; }
    return 1
  fi
  c="$(command -v codex 2>/dev/null || true)"
  [ -n "$c" ] && { printf '%s' "$c"; return 0; }
  for c in "${REPO_ROOT:-}/node_modules/.bin/codex" /vhome/paperclip/node_modules/.bin/codex; do
    case "$c" in /node_modules/*) continue ;; esac   # REPO_ROOT was empty
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# Every phase above verifies its own write EXCEPT the credential — the one thing
# that fails at run time rather than at create time, which is exactly the failure
# this script exists to prevent. So prove it here instead of printing the command
# for the operator to run later and hoping they do.
#
# What this proves: the vault's config.toml selects a provider and its auth
# command yields a usable token, so a run against this home authenticates.
# What it does NOT prove: that the agent's bound OPENROUTER_API_KEY secret_ref
# resolves server-side. That is a different path — the heartbeat resolves
# bindings before dispatch — and only a real run exercises it. `secrets doctor`
# above is the check for the binding itself.
credential_check() {
  local bin out rc home

  if [ "$SKIP_CRED_CHECK" = true ]; then
    info "codex:    skipped (--skip-credential-check)"
    return 0
  fi
  # No explicit vault means the agent runs against the Paperclip-managed home,
  # which this host cannot stand in for: the server seeds and resolves it per
  # company. Probing the host's own Codex home would answer a different question.
  home="${CODEX_HOME_VALUE:-}"
  if [ -z "$home" ]; then
    info "codex:    skipped — no --codex-home, so the agent uses the managed home"
    return 0
  fi
  # The vault's auth command reads the credential out of the child environment.
  # Absent here it cannot run, but that says nothing about the agent: the agent
  # gets the key from its secret_ref, not from this shell.
  if [ -z "${OPENROUTER_API_KEY:-}" ]; then
    info "codex:    skipped — no key in this shell to probe with"
    info "          (the agent uses its secret_ref, so this is not a fault)"
    return 0
  fi
  if ! bin="$(find_codex_bin)"; then
    info "codex:    skipped — no codex binary found (set CODEX_BIN to probe)"
    return 0
  fi

  # --skip-git-repo-check because $PWD is wherever the operator ran this from,
  # and a read-only one-word prompt has no business caring. Output is captured,
  # never streamed: it carries the model banner and must be summarised, not
  # dumped over the invite links above.
  #
  # </dev/null is load-bearing. `codex exec` appends anything on stdin to the
  # prompt and waits for EOF to do it ("Reading additional input from stdin...").
  # Inheriting this script's stdin therefore hangs the probe for the full
  # timeout whenever stdin is a terminal or an open pipe — which is every
  # interactive run, and the exact shape of an operator running this over SSH.
  #
  # The key is supplied under $SECRET_ENV — the same name the agent binds it to
  # — rather than under a literal OPENROUTER_API_KEY. Probing with the wrong
  # variable name would answer a question about a vault the agent is not going
  # to run, and would pass or fail for reasons unrelated to the real binding.
  set +e
  out="$(CODEX_HOME="$home" env "$SECRET_ENV=$OPENROUTER_API_KEY" \
    timeout 120 "$bin" exec --skip-git-repo-check \
    "Reply with exactly: PONG" < /dev/null 2>&1)"
  rc=$?
  set -e

  if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "PONG"; then
    info "codex:    PONG — $(printf '%s' "$out" | grep -m1 -E '^provider:' || echo 'provider: ?')"
    return 0
  fi

  VERIFY_FAILED=true
  info "codex:    FAILED — the agent will 401 on its first real run"
  if printf '%s' "$out" | grep -q "produced an empty token"; then
    info "          the auth command produced an empty token: the vault's"
    info "          config.toml reads \$OPENROUTER_API_KEY but nothing supplied it"
  elif [ $rc -eq 124 ]; then
    info "          timed out after 120s with no reply from the provider"
  fi
  # Last few lines only. The full transcript is long and the tail carries the
  # provider's own error, which names the actual problem.
  printf '%s\n' "$out" | tail -5 | sed 's/^/          | /'
  return 0
}

# ------------------------------------------------------------------ verify --
step 6/6 "Verify"
# Nothing was created in a dry run, so counting what exists would print blanks
# and read like a failed verification.
if [ "$DRY_RUN" = true ]; then
  info "skipped — nothing was created (--dry-run)"
else
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
credential_check
fi

if [ "$VERIFY_ONLY" = true ]; then
  echo
  if [ "$VERIFY_FAILED" = true ]; then
    echo "VERIFY: FAILED — see the MISSING lines above. Nothing was changed."
    echo "        Run without --verify to create what is missing."
    exit 1
  fi
  echo "VERIFY: OK — ownership, company, secret and agent are all in place."
  echo "        Nothing was changed."
  exit 0
fi

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

# The probe already ran in phase 6 and its verdict is on the "codex:" line
# above. Only say something more when it did not actually pass — a green run
# needs no homework, and printing the command anyway is what made this step
# skippable in the first place.
if [ "$VERIFY_FAILED" = true ]; then
  cat <<EOF

The provider credential check FAILED. The agent is created but will 401 on its
first real task. Reproduce it directly:

  CODEX_HOME=${CODEX_HOME_VALUE:-/sysops/llm/openrouter/default} \\
    codex exec --skip-git-repo-check "Reply with exactly: PONG"

Expect 'provider: openrouter' and 'PONG'. "provider auth command 'sh' produced
an empty token" means the key is not reaching the child process: check that the
vault's config.toml auth command names the variable the key is actually in, and
that the secret bound to the agent (SECRET_ID above) holds the right value.
EOF
  # Non-zero so a caller that chains onto this script stops here. Everything
  # above was created and is not rolled back — the tenant is real, the
  # credential is not proven — so re-running with --verify after a fix is the
  # way back to green, not a second full run.
  exit 1
fi
