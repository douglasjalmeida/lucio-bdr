// Manda payload mock pro /in do bridge local. Uso pra testar sem WhatsApp real.
// Uso: node scripts/simular-conversa.js +5562999999999 "oi, vi que vocês trabalham com geradores"

import 'dotenv/config';

const PORT = process.env.PORT || '8788';
const URL = `http://localhost:${PORT}/in`;

const telefone = process.argv[2] || '+5562999999999';
const mensagem = process.argv[3] || 'oi, queria saber mais sobre geradores';
const autor = process.argv[4] || 'lead'; // 'lead' | 'humano'
const nome = process.argv[5] || 'Teste';

const payload = {
  telefone,
  nome,
  mensagem,
  chatid: `${telefone.replace('+', '')}@s.whatsapp.net`,
  timestamp: new Date().toISOString(),
  autor,
};

console.log('[simular] POST', URL);
console.log('[simular] payload', payload);

const r = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const data = await r.json().catch(() => null);
console.log(`[simular] HTTP ${r.status}`);
console.log('[simular] resposta:', JSON.stringify(data, null, 2));
