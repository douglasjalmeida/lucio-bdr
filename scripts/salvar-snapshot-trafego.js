// Ingere o snapshot de tráfego da Meta em `trafego_snapshots` (Supabase CMO).
//
// Fluxo: o secretário Douglas (que tem o MCP da Meta) puxa os insights da janela
// e PREENCHE scripts/snapshot-trafego.json com os números reais. Depois roda:
//
//   node --env-file=.env scripts/salvar-snapshot-trafego.js
//
// Grava 1 linha (histórico) via SUPABASE_SERVICE_ROLE_KEY. A aba Tráfego do
// dashboard lê o snapshot mais recente. Quando a coleta virar automática (n8n),
// o fluxo insere na MESMA tabela — o dashboard não muda.
//
// Modelo dos campos: ver scripts/snapshot-trafego.example.json.
//
// IMAGEM DO CRIATIVO (imagem_url): o endpoint de *insights* da Meta NÃO traz a
// imagem. Pra cada anúncio, puxar à parte o creative e pegar a URL da imagem:
//   GET /{ad-id}?fields=creative{thumbnail_url,image_url}
// e gravar em criativos[].imagem_url (image_url = imagem cheia; thumbnail_url =
// preview pequeno, sempre presente). Sem isso o card mostra "sem imagem".
//
// CONVERSÕES POR REGIÃO (por_regiao): vem do mesmo ads_insights, com breakdown
// `region` na métrica de resultado:
//   GET act_<id>/insights?breakdowns=region&fields=spend,actions&time_range=...
// e some, por região, a action onsite_conversion.messaging_conversation_started_*
// (conversa de WhatsApp iniciada). Grave cada região como:
//   { "regiao": "São Paulo", "conversas": N, "investimento": gasto, "cpl": gasto/N }
// Se a Meta NÃO entregar a conversa de mensagem quebrada por região, use cliques
// no link / leads por região como PROXY e marque "proxy": true (o dashboard
// rotula "(proxy: cliques)"). Nunca fabricar número — sem dado, deixe [] e o
// dashboard mostra estado vazio honesto. Requer a migração 010 aplicada.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arquivo = join(__dirname, 'snapshot-trafego.json');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Faltou SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (rode com --env-file=.env)');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(arquivo, 'utf8'));
} catch (e) {
  console.error('Não consegui ler/parsear scripts/snapshot-trafego.json:', e.message);
  console.error('Copie scripts/snapshot-trafego.example.json e preencha com os números da janela.');
  process.exit(1);
}

for (const campo of ['janela_inicio', 'janela_fim', 'conta_id']) {
  if (!raw[campo]) {
    console.error(`Campo obrigatório ausente no JSON: ${campo}`);
    process.exit(1);
  }
}

const snapshot = {
  capturado_em: new Date().toISOString(),
  janela_inicio: raw.janela_inicio,
  janela_fim: raw.janela_fim,
  conta_id: raw.conta_id,
  investimento: Number(raw.investimento ?? 0),
  impressoes: Number(raw.impressoes ?? 0),
  conversas: Number(raw.conversas ?? 0),
  ctr: raw.ctr ?? null,
  cpc: raw.cpc ?? null,
  cpl: raw.cpl ?? null,
  criativos: Array.isArray(raw.criativos) ? raw.criativos : [],
  por_regiao: Array.isArray(raw.por_regiao) ? raw.por_regiao : [],
  origem: raw.origem ?? 'mcp',
};

const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await sb
  .from('trafego_snapshots')
  .insert(snapshot)
  .select('id, capturado_em')
  .single();

if (error) {
  console.error('Erro ao inserir snapshot:', error.message);
  process.exit(1);
}

console.log('✓ Snapshot gravado no CMO:', data.id);
console.log('  capturado_em:', data.capturado_em);
console.log('  criativos:', snapshot.criativos.length);
console.log('  regiões:', snapshot.por_regiao.length);
console.log('Abra /dashboard → aba Tráfego pra ver os KPIs + galeria + regiões.');
