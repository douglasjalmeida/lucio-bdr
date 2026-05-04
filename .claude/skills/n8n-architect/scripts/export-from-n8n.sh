#!/usr/bin/env bash
# Exporta workflows de uma instância n8n via API REST.
#
# Uso:
#   ./export-from-n8n.sh pessoal              # todos workflows da pessoal
#   ./export-from-n8n.sh luminus              # todos workflows da Luminus
#   ./export-from-n8n.sh luminus 42           # só workflow ID 42
#
# Lê credenciais do .env na mesma pasta da skill.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SKILL_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[ERRO] .env não encontrado em $ENV_FILE" >&2
  echo "      Copia .env.example pra .env e preenche os valores." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

INSTANCE="${1:-}"
WORKFLOW_ID="${2:-}"

if [[ -z "$INSTANCE" ]]; then
  echo "Uso: $0 <pessoal|luminus> [workflow_id]" >&2
  exit 2
fi

case "$INSTANCE" in
  pessoal)
    BASE_URL="${N8N_PESSOAL_URL:-}"
    API_KEY="${N8N_PESSOAL_API_KEY:-}"
    ;;
  luminus)
    BASE_URL="${N8N_LUMINUS_URL:-}"
    API_KEY="${N8N_LUMINUS_API_KEY:-}"
    ;;
  *)
    echo "[ERRO] Instância inválida: $INSTANCE (use pessoal ou luminus)" >&2
    exit 2
    ;;
esac

if [[ -z "$BASE_URL" || -z "$API_KEY" ]]; then
  echo "[ERRO] URL ou API key vazias para '$INSTANCE'. Confere .env." >&2
  exit 1
fi

# Sanitizar URL (remover trailing slash, garantir api/v1)
BASE_URL="${BASE_URL%/}"
API_URL="${BASE_URL}/api/v1"

# Repo root: 4 níveis acima da pasta scripts (.claude/skills/n8n-architect/scripts → repo)
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DATE_DIR="$(date +%Y-%m-%d)"
OUT_DIR="$REPO_ROOT/docs/n8n-backup/$INSTANCE/$DATE_DIR"
mkdir -p "$OUT_DIR"

echo "=== Export $INSTANCE → $OUT_DIR ==="

fetch_one() {
  local id="$1"
  local resp
  resp="$(curl -sS -H "X-N8N-API-KEY: $API_KEY" "$API_URL/workflows/$id")"
  local name
  name="$(echo "$resp" | python3 -c 'import sys,json,re; d=json.load(sys.stdin); print(re.sub(r"[^a-zA-Z0-9._-]+","_",d.get("name","sem-nome"))[:60])' 2>/dev/null || echo "id-$id")"
  local file="$OUT_DIR/${id}-${name}.json"
  echo "$resp" | python3 -m json.tool > "$file"
  echo "  ✓ $file"
}

if [[ -n "$WORKFLOW_ID" ]]; then
  fetch_one "$WORKFLOW_ID"
else
  list="$(curl -sS -H "X-N8N-API-KEY: $API_KEY" "$API_URL/workflows?limit=250")"
  ids="$(echo "$list" | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(w["id"]) for w in d.get("data", [])]')"
  count=0
  for id in $ids; do
    fetch_one "$id"
    count=$((count + 1))
  done
  echo
  echo "Total: $count workflow(s) exportados."
fi
