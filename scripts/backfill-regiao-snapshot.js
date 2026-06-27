// Aplica/atualiza `por_regiao` num snapshot já gravado em trafego_snapshots,
// SEM refazer o snapshot inteiro. Útil quando o snapshot foi salvo antes de ter
// o breakdown por região da Meta (ou pra corrigir só a região).
//
// Uso:
//   node --env-file=.env scripts/backfill-regiao-snapshot.js <arquivo.json> [--id <uuid>]
//
// <arquivo.json> = { "por_regiao": [ {regiao, conversas, investimento, cpl, proxy}, ... ] }
//   (também aceita o array direto). Sem --id, aplica no snapshot MAIS RECENTE.
//
// Escreve via SUPABASE_SERVICE_ROLE_KEY (PostgREST update, ignora RLS) — não é
// DDL, então independe do read-only do MCP. Idempotente (regrava o campo).

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Faltou SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (rode com --env-file=.env)');
  process.exit(1);
}

const args = process.argv.slice(2);
const idFlag = args.indexOf('--id');
const alvoId = idFlag >= 0 ? args[idFlag + 1] : null;
const skipIdx = idFlag >= 0 ? idFlag + 1 : -1; // só pula o valor do --id, não o índice 0
const arquivo = args.find((a, i) => !a.startsWith('--') && i !== skipIdx);
if (!arquivo) {
  console.error('Uso: node --env-file=.env scripts/backfill-regiao-snapshot.js <arquivo.json> [--id <uuid>]');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(arquivo, 'utf8'));
} catch (e) {
  console.error('Não consegui ler/parsear', arquivo, '-', e.message);
  process.exit(1);
}
const porRegiao = Array.isArray(raw) ? raw : raw.por_regiao;
if (!Array.isArray(porRegiao) || !porRegiao.length) {
  console.error('JSON sem `por_regiao` (array não vazio).');
  process.exit(1);
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Descobre o snapshot alvo (id explícito ou o mais recente).
let alvo;
if (alvoId) {
  const { data, error } = await sb.from('trafego_snapshots')
    .select('id, janela_inicio, janela_fim, conversas').eq('id', alvoId).maybeSingle();
  if (error) { console.error('Erro ao buscar snapshot:', error.message); process.exit(1); }
  alvo = data;
} else {
  const { data, error } = await sb.from('trafego_snapshots')
    .select('id, janela_inicio, janela_fim, conversas').order('capturado_em', { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error('Erro ao buscar snapshot:', error.message); process.exit(1); }
  alvo = data;
}
if (!alvo) { console.error('Nenhum snapshot encontrado.'); process.exit(1); }

const somaRegiao = porRegiao.reduce((s, r) => s + (Number(r.conversas) || 0), 0);
console.log(`Snapshot alvo: ${alvo.id} (janela ${alvo.janela_inicio} a ${alvo.janela_fim}, conversas=${alvo.conversas})`);
console.log(`Regiões: ${porRegiao.length} · soma de conversas por região = ${somaRegiao}`);
if (alvo.conversas != null && somaRegiao !== alvo.conversas) {
  console.warn(`⚠ Aviso: soma por região (${somaRegiao}) difere do total do snapshot (${alvo.conversas}). Gravando assim mesmo.`);
}

const { error: upErr } = await sb.from('trafego_snapshots').update({ por_regiao: porRegiao }).eq('id', alvo.id);
if (upErr) { console.error('Erro ao gravar por_regiao:', upErr.message); process.exit(1); }

console.log('✓ por_regiao gravado. Abra /dashboard → aba Tráfego → "Conversões por região".');
