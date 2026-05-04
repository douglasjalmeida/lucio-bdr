#!/usr/bin/env bash
# Wrapper que carrega .env do projeto antes de rodar o MCP supabase.
# Garante que SUPABASE_ACCESS_TOKEN e SUPABASE_PROJECT_REF estejam no ambiente
# independente de como o Claude Code/Antigravity foi iniciado.

set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$DIR/.env"
  set +a
fi

FLAGS=(--project-ref="$SUPABASE_PROJECT_REF")
if [ "${SUPABASE_MCP_READONLY:-1}" = "1" ]; then
  FLAGS=(--read-only "${FLAGS[@]}")
fi

exec npx -y @supabase/mcp-server-supabase@latest "${FLAGS[@]}"
