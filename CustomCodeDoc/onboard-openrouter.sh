#!/usr/bin/env bash
#
# onboarding-openrouter.sh — configure the OpenAI Codex CLI to route through
# OpenRouter on Ubuntu.  Supports multiple side-by-side profiles, each with its
# own Codex home, key, and model.
#
# Writes, inside the chosen Codex home (default ~/.codex):
#   config.toml          provider block + model selection (backed up if present)
#   openrouter.env       CODEX_HOME only, mode 0600 — no key is written
# and, unless --no-launcher:
#   ~/.local/bin/codex-<name>   wrapper that pins CODEX_HOME and execs codex
#
# Usage:
#   ./onboard-openrouter.sh sk-or-v1-xxxxxxxx
#   ./onboard-openrouter.sh -p ~/.codex-work -n work sk-or-v1-yyyy
#   ./onboard-openrouter.sh -p ~/.codex-cheap -m 'openai/gpt-5.1-codex-mini' sk-or-v1-zzz
#   sudo ./onboard-openrouter.sh --user deploy sk-or-v1-xxxx
#   OPENROUTER_API_KEY=sk-or-v1-xxxx ./onboard-openrouter.sh
# 
# onboard-openrouter.sh -m 'openai/gpt-5.6-luna'
# onboard-openrouter.sh -p ~/.codex-cheap -m 'openai/gpt-5.1-codex-mini'
# onboard-openrouter.sh -p ~/.codex-deepseek -m 'deepseek/deepseek-v4-flash-0731'
#
#
set -euo pipefail

# ---------------------------------------------------------------- defaults ---
MODEL_DEFAULT='~openai/gpt-latest'
PROVIDER_ID='openrouter'
BASE_URL='https://openrouter.ai/api/v1'
REASONING_DEFAULT='high'

MODEL="$MODEL_DEFAULT"
REASONING="$REASONING_DEFAULT"
TARGET_USER=""
CODEX_PATH=""
PROFILE_NAME=""
API_KEY="${OPENROUTER_API_KEY:-}"
VERIFY=0
FORCE=0
LAUNCHER=1

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }

usage() {
	cat <<'USAGE'
Usage: onboarding-openrouter.sh [options] [OPENROUTER_API_KEY]

Options:
  -p, --path DIR        Codex home for this profile. Default: ~/.codex
                        Relative paths resolve against the target user's home.
                        Use a distinct DIR per key to keep profiles separate.
  -n, --name NAME       Profile name; sets the launcher to codex-NAME.
                        Default: derived from DIR (~/.codex -> "default",
                        ~/.codex-work -> "work").
  -u, --user USER       Configure USER's home instead of the current user's
                        (requires root; files are chowned to USER).
  -m, --model SLUG      OpenRouter model slug. Default: ~openai/gpt-latest
                        e.g. openai/gpt-5.3-codex, ~anthropic/claude-sonnet-latest
  -e, --effort LEVEL    model_reasoning_effort: low|medium|high|xhigh|max
                        Default: high
  -k, --verify          Call the OpenRouter API to confirm the key is live.
  -f, --force           Overwrite an existing config.toml without prompting.
      --no-launcher     Skip the ~/.local/bin/codex-NAME wrapper.
  -h, --help            Show this help.

The key may also be supplied via the OPENROUTER_API_KEY environment variable,
which avoids putting it in your shell history.

Each profile is a separate CODEX_HOME. Run the script once per key, then use
the generated wrappers -- codex-work, codex-cheap, ... -- to pick one.
USAGE
}

# ------------------------------------------------------------------ parse ----
while [ $# -gt 0 ]; do
	case "$1" in
		-p|--path)   CODEX_PATH="${2:-}";   [ -n "$CODEX_PATH" ]   || die "--path needs a value"; shift 2 ;;
		-n|--name)   PROFILE_NAME="${2:-}"; [ -n "$PROFILE_NAME" ] || die "--name needs a value"; shift 2 ;;
		-u|--user)   TARGET_USER="${2:-}";  [ -n "$TARGET_USER" ]  || die "--user needs a value"; shift 2 ;;
		-m|--model)  MODEL="${2:-}";        [ -n "$MODEL" ]        || die "--model needs a value"; shift 2 ;;
		-e|--effort) REASONING="${2:-}";    [ -n "$REASONING" ]    || die "--effort needs a value"; shift 2 ;;
		-k|--verify)    VERIFY=1;  shift ;;
		-f|--force)     FORCE=1;   shift ;;
		--no-launcher)  LAUNCHER=0; shift ;;
		-h|--help)      usage; exit 0 ;;
		--)             shift; break ;;
		-*)             die "unknown option: $1 (try --help)" ;;
		*)              API_KEY="$1"; shift ;;
	esac
done

case "$REASONING" in
	low|medium|high|xhigh|max) ;;
	*) die "--effort must be one of: low medium high xhigh max" ;;
esac

# -------------------------------------------------------------- resolve me ---
if [ -n "$TARGET_USER" ]; then
	[ "$(id -u)" -eq 0 ] || die "--user requires root"
	HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
	[ -n "$HOME_DIR" ] || die "no such user: $TARGET_USER"
	[ -d "$HOME_DIR" ] || die "home directory does not exist: $HOME_DIR"
	OWNER="$TARGET_USER"
else
	HOME_DIR="$HOME"
	OWNER="$(id -un)"
fi

# ------------------------------------------------------- resolve codex home --
# Absolute path required: it is baked into config.toml's auth command and into
# the launcher, both of which run with an unpredictable working directory.
if [ -z "$CODEX_PATH" ]; then
	CODEX_DIR="$HOME_DIR/.codex"
else
	# shellcheck disable=SC2088  # matching a literal ~ the caller quoted, on purpose
	case "$CODEX_PATH" in
		'~')    CODEX_DIR="$HOME_DIR" ;;
		'~/'*)  CODEX_DIR="$HOME_DIR/${CODEX_PATH#\~/}" ;;   # quoted ~ from the caller
		/*)     CODEX_DIR="$CODEX_PATH" ;;
		*)      CODEX_DIR="$HOME_DIR/$CODEX_PATH" ;;
	esac
fi
CODEX_DIR="${CODEX_DIR%/}"

case "$CODEX_DIR" in
	*[[:space:]]*) die "--path must not contain whitespace: $CODEX_DIR" ;;
esac

# ---------------------------------------------------------- resolve name -----
if [ -z "$PROFILE_NAME" ]; then
	base="$(basename "$CODEX_DIR")"
	base="${base#.}"           # .codex-work  -> codex-work
	base="${base#codex}"       # codex-work   -> -work
	base="${base#-}"           # -work        -> work
	base="${base#_}"
	PROFILE_NAME="${base:-default}"
fi
case "$PROFILE_NAME" in
	*[!A-Za-z0-9._-]*) die "--name may only contain letters, digits, dot, dash, underscore" ;;
esac

CONFIG="$CODEX_DIR/config.toml"
ENV_FILE="$CODEX_DIR/openrouter.env"
BIN_DIR="$HOME_DIR/.local/bin"
LAUNCHER_PATH="$BIN_DIR/codex-$PROFILE_NAME"
BASHRC="$HOME_DIR/.bashrc"

# --------------------------------------------------------------- get key -----
if [ -z "$API_KEY" ]; then
	if [ -t 0 ]; then
		printf 'OpenRouter API key for profile "%s" (input hidden): ' "$PROFILE_NAME"
		read -rs API_KEY
		printf '\n'
	else
		die "no API key given; pass it as an argument or set OPENROUTER_API_KEY"
	fi
fi

# Strip stray whitespace/CR — a trailing \r from a copied key fails at runtime
# while still looking correct in the file.
API_KEY="$(printf '%s' "$API_KEY" | tr -d '[:space:]')"
[ -n "$API_KEY" ] || die "empty API key"

case "$API_KEY" in
	sk-or-*) ;;
	*) printf 'warning: key does not start with "sk-or-"; continuing anyway\n' >&2 ;;
esac

# --------------------------------------------------------------- verify ------
if [ "$VERIFY" -eq 1 ]; then
	command -v curl >/dev/null 2>&1 || die "--verify needs curl installed"
	printf 'Verifying key against OpenRouter... '
	code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
		-H "Authorization: Bearer $API_KEY" "$BASE_URL/key" || true)"
	case "$code" in
		200) printf 'ok\n' ;;
		401|403) printf 'rejected (HTTP %s)\n' "$code"; die "the key was refused by OpenRouter" ;;
		*)   printf 'inconclusive (HTTP %s), continuing\n' "${code:-none}" ;;
	esac
fi

# --------------------------------------------------------------- write -------
umask 077   # nothing is world-readable, not even momentarily

mkdir -p "$CODEX_DIR"
chmod 700 "$CODEX_DIR"

if [ -f "$CONFIG" ] && [ "$FORCE" -eq 0 ]; then
	backup="$CONFIG.bak.$(date +%Y%m%d%H%M%S)"
	cp -p "$CONFIG" "$backup"
	info "existing config backed up to $backup"
fi

cat > "$ENV_FILE" <<ENVEOF
# Written by onboarding-openrouter.sh on $(date -Is) — profile: $PROFILE_NAME
# Source this to point a shell at the "$PROFILE_NAME" profile.
export CODEX_HOME="$CODEX_DIR"
ENVEOF
chmod 600 "$ENV_FILE"

# The auth command takes the key from OPENROUTER_API_KEY in Codex's own
# environment. Nothing under CODEX_HOME supplies it, so the key has to be
# exported by whatever starts codex — the profile itself carries only the
# model and provider settings.
cat > "$CONFIG" <<TOMLEOF
# Written by onboarding-openrouter.sh on $(date -Is) — profile: $PROFILE_NAME
# Docs: https://openrouter.ai/docs/cookbook/coding-agents/codex-cli

model = "$MODEL"
model_provider = "$PROVIDER_ID"
model_reasoning_effort = "$REASONING"

[model_providers.$PROVIDER_ID]
name = "$PROVIDER_ID"
base_url = "$BASE_URL"

[model_providers.$PROVIDER_ID.auth]
command = "sh"
args = ["-c", 'printf %s "\$OPENROUTER_API_KEY"']
TOMLEOF
chmod 600 "$CONFIG"

# -------------------------------------------------------------- launcher -----
if [ "$LAUNCHER" -eq 1 ]; then
	mkdir -p "$BIN_DIR"
	cat > "$LAUNCHER_PATH" <<LAUNCHEOF
#!/usr/bin/env bash
# codex-$PROFILE_NAME — Codex CLI pinned to $CODEX_DIR
# Written by onboarding-openrouter.sh
export CODEX_HOME="$CODEX_DIR"
# openrouter.env carries no key, only CODEX_HOME. It is sourced anyway so
# that anything you add to it later reaches codex.
if [ -r "\$CODEX_HOME/openrouter.env" ]; then
	. "\$CODEX_HOME/openrouter.env"
fi
exec codex "\$@"
LAUNCHEOF
	chmod 700 "$LAUNCHER_PATH"
	info "launcher written to $LAUNCHER_PATH"

	# Ubuntu's stock ~/.profile only adds ~/.local/bin to PATH if the directory
	# existed at login, so a fresh mkdir above is not enough for this session or
	# for non-login shells.
	MARKER='# >>> codex/openrouter path >>>'
	if [ -f "$BASHRC" ] && grep -qF "$MARKER" "$BASHRC"; then
		:
	else
		cat >> "$BASHRC" <<RCEOF

$MARKER
case ":\$PATH:" in *":$BIN_DIR:"*) ;; *) PATH="$BIN_DIR:\$PATH" ;; esac
# <<< codex/openrouter path <<<
RCEOF
		info "added $BIN_DIR to PATH in $BASHRC"
	fi
fi

# ---------------------------------------------------------------- ownership --
if [ -n "$TARGET_USER" ]; then
	group="$(id -gn "$TARGET_USER")"
	chown -R "$TARGET_USER:$group" "$CODEX_DIR"
	if [ "$LAUNCHER" -eq 1 ]; then
		chown "$TARGET_USER:$group" "$LAUNCHER_PATH"
		chown "$TARGET_USER:$group" "$BIN_DIR" 2>/dev/null || true
	fi
	if [ -f "$BASHRC" ]; then chown "$TARGET_USER:$group" "$BASHRC"; fi
fi

# ------------------------------------------------------------------ report ---
cat <<DONE

Codex profile "$PROFILE_NAME" configured for OpenRouter.

  user        $OWNER
  CODEX_HOME  $CODEX_DIR
  config      $CONFIG
  env         $ENV_FILE (0600, CODEX_HOME only)
  model       $MODEL   (reasoning effort: $REASONING)
DONE

if [ "$LAUNCHER" -eq 1 ]; then
	cat <<DONE

Start a new shell, then run it from any project directory:

  codex-$PROFILE_NAME

Equivalent without the wrapper:

  CODEX_HOME=$CODEX_DIR codex
DONE
else
	cat <<DONE

Use it with:

  CODEX_HOME=$CODEX_DIR codex      # or: . "$ENV_FILE"
DONE
fi

# Show sibling profiles so it is obvious what already exists.
siblings="$(find "$HOME_DIR" -maxdepth 1 -type d -name '.codex*' -printf '%f\n' 2>/dev/null | sort || true)"
if [ "$(printf '%s\n' "$siblings" | grep -c .)" -gt 1 ]; then
	printf '\nCodex homes now present in %s:\n' "$HOME_DIR"
	printf '%s\n' "$siblings" | sed 's/^/  /'
fi

if ! command -v codex >/dev/null 2>&1; then
	printf '\nnote: no "codex" binary on PATH yet — install it with\n      npm install -g @openai/codex\n'
fi