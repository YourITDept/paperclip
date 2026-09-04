#!/bin/bash

COMPANY="Bring Your AI to Life"

OPENROUTER_API_KEY="${1}"

./onboard-paperclip-2.sh --pnpm \
  --owner-email "admin@bringyouraito.life" \
  --company "${COMPANY}" \
  --invite-roles "admin,operator" \
  --agent-name "OpenRouter Codex Agent" \
  --codex-home "${PAPERCLIP_CODEX_HOME}" \
  --openrouter-api-key "${OPENROUTER_API_KEY}" \
  --model "openai/gpt-5.6-luna" \
  --can-create-agents \
  || exit 1

./onboard-paperclip-2.sh --pnpm \
  --add-agent \
  --company "${COMPANY}" \
  --owner-email "admin@bringyouraito.life" \
  --agent-name "OpenRouter Deepseek Agent" \
  --secret-identity "openrouter_api_key_deepseek" \
  --secret-name "OpenRouter-Deepseek" \
  --openrouter-api-key "${OPENROUTER_API_KEY}" \
  --codex-home "/sysops/llm/openrouter/deepseek-v4-flash-0731" \
  --model "deepseek/deepseek-v4-flash-0731" \
  --can-create-agents \
  || exit 1

./onboard-paperclip-2.sh --pnpm \
  --add-agent \
  --company "${COMPANY}" \
  --owner-email "admin@bringyouraito.life" \
  --agent-name "OpenRouter gpt-5.6-Luna Agent" \
  --secret-identity "openrouter_api_key_luna" \
  --secret-name "OpenRouter-Luna" \
  --openrouter-api-key "${OPENROUTER_API_KEY}" \
  --codex-home "/sysops/llm/openrouter/gpt-5.6-luna" \
  --model "openai/gpt-5.6-luna" \
  --can-create-agents \
  || exit 1

./onboard-paperclip-2.sh --pnpm \
  --add-agent \
  --company "${COMPANY}" \
  --owner-email "admin@bringyouraito.life" \
  --agent-name "OpenRouter gpt-5.1-Codex-Mini Agent" \
  --secret-identity "openrouter_api_key_codex-mini" \
  --secret-name "OpenRouter-Codex-Mini" \
  --openrouter-api-key "${OPENROUTER_API_KEY}" \
  --codex-home "/sysops/llm/openrouter/gpt-5.1-codex-mini" \
  --model "openai/gpt-5.1-codex-mini" \
  --can-create-agents \
  || exit 1
