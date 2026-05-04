#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${1:-luminus}"
if [[ "$INSTANCE" != "luminus" ]]; then
  echo "erro: projeto Lúcio só opera a instância 'luminus' (recebido: $INSTANCE)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "erro: $ENV_FILE não encontrado" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

export N8N_API_URL="${N8N_LUMINUS_URL%/}/api/v1"
export N8N_API_KEY="$N8N_LUMINUS_API_KEY"

export MCP_MODE="stdio"

exec npx -y n8n-mcp
