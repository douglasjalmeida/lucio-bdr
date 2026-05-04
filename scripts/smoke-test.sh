#!/usr/bin/env bash
# Smoke test do bridge Lúcio. Roda com bridge já no ar: `npm run dev` em outro terminal.
set -e

PORT="${PORT:-8788}"
BASE="http://localhost:${PORT}"

echo "─── /health ───────────────────────────────"
curl -sS "$BASE/health" | sed 's/,/,\n  /g'
echo
echo

echo "─── /in (mock lead) ────────────────────────"
curl -sS -X POST "$BASE/in" \
  -H 'Content-Type: application/json' \
  -d '{
    "telefone": "+5562999999999",
    "nome": "Smoke Test",
    "mensagem": "oi, vi vocês trabalham com geradores, queria entender melhor",
    "chatid": "5562999999999@s.whatsapp.net",
    "timestamp": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "autor": "lead"
  }' | sed 's/,/,\n  /g'
echo
echo
echo "✓ smoke test concluído"
