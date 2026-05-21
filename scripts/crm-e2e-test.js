// Teste ISOLADO do espelho CRM (registrarTransicao → espelharTransicao).
// ⚠️ ATENÇÃO: isto NÃO é o fluxo real. Chama registrarTransicao direto, que
// espelha SÓ pro CRM — NÃO passa pelo Chatwoot. Resultado: cria SQL no CRM sem
// SQL no Chatwoot (inconsistência que confunde). Pra teste fiel (Chatwoot + CRM
// juntos), simular inbound real no /in. Use este só pra validar o espelho em si.
// 1) apaga os leads de teste informados (CASCADE limpa mensagens/transições);
// 2) recria 2 leads (Douglas + Fernando);
// 3) empurra cada um por uma sequência de etapas via registrarTransicao,
//    com pausa entre etapas pro espelho fire-and-forget completar + persistir
//    o id do card (crítico no funil de vendas, que não acha por telefone);
// 4) verifica os cards no CRM e os ids salvos no Supabase.
//
// Deixa os cards no CRM pra inspeção (NÃO limpa no fim).
// Uso: node scripts/crm-e2e-test.js

import 'dotenv/config';
import { supabase, criarLead, registrarTransicao } from '../src/supabase-client.js';

const APAGAR_IDS = [391, 392, 393, 394];
const BASE = (process.env.CRM_BASE_URL || '').replace(/\/+$/, '');
const H = { Authorization: `Bearer ${process.env.CRM_API_TOKEN || ''}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ALVOS = [
  { nome: 'Douglas Almeida', telefone: '+554896990020', empresa: 'Teste E2E',
    seq: ['em-cadencia', 'mql-respondeu', 'mql-qualificado', 'humano-atendendo', 'sql-contato-feito', 'sql-proposta'] },
  { nome: 'Fernando', telefone: '+554899386988', empresa: 'Teste E2E',
    seq: ['em-cadencia', 'mql-respondeu', 'mql-qualificado', 'humano-atendendo'] },
];

async function cardPorId(funil, rec, id) {
  if (!id) return null;
  const r = await fetch(`${BASE}/api/external/${funil}/${rec}/${id}/`, { headers: H });
  if (!r.ok) return null;
  return r.json();
}

async function main() {
  // 1) apaga os leads de teste
  const { data: apagados } = await supabase.from('leads').delete().in('id', APAGAR_IDS).select('id, nome');
  console.log(`→ Apagados ${apagados?.length || 0} lead(s):`, (apagados || []).map(l => `${l.id}:${l.nome}`).join(', ') || '(nenhum)');

  // 2+3) recria e empurra pela pipeline
  for (const alvo of ALVOS) {
    console.log(`\n=== ${alvo.nome} (${alvo.telefone}) ===`);
    const lead = await criarLead({ nome: alvo.nome, empresa: alvo.empresa, telefone: alvo.telefone, origem: 'inbound' });
    console.log(`  lead Supabase id=${lead.id}`);
    for (const etapa of alvo.seq) {
      await registrarTransicao(lead.id, null, etapa, 'auto');
      await sleep(1800); // espera o espelho fire-and-forget completar + persistir id
      const { data: l } = await supabase.from('leads').select('crm_lead_id, crm_deal_id').eq('id', lead.id).maybeSingle();
      console.log(`  ✓ ${etapa.padEnd(18)} crm_lead_id=${l?.crm_lead_id ?? '–'} crm_deal_id=${l?.crm_deal_id ?? '–'}`);
    }
  }

  // 4) verificação final no CRM (busca cards pelos ids salvos no Supabase)
  console.log('\n=== Verificação no CRM ===');
  for (const alvo of ALVOS) {
    const { data: l } = await supabase.from('leads').select('crm_lead_id, crm_deal_id').eq('telefone', alvo.telefone).maybeSingle();
    const lead = await cardPorId('marketing', 'leads', l?.crm_lead_id);
    const deal = await cardPorId('sales', 'deals', l?.crm_deal_id);
    console.log(`  ${alvo.nome}:`);
    console.log(`    Marketing → ${lead ? `id=${lead.id} stage=${lead.stage} title="${lead.title}"` : 'NÃO ENCONTRADO'}`);
    console.log(`    Vendas    → ${deal ? `id=${deal.id} stage=${deal.stage} title="${deal.title}"` : 'NÃO ENCONTRADO'}`);
  }
  console.log('\n✓ E2E concluído. Cards deixados no CRM pra inspeção visual nos funis.');
}

main().catch(e => { console.error('✗ Falhou:', e.message); process.exit(1); });
