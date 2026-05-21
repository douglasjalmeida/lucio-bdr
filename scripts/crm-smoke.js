// Smoke test do espelho CRM — exercita um lead fake pelas transições e valida
// que o MESMO card é movido (idempotência), não recriado. NÃO toca Supabase;
// simula a persistência do id carregando o "patch" retornado entre transições
// (no sistema real, registrarTransicao grava crm_lead_id/crm_deal_id no lead).
//
// Pré-requisito: CRM_BASE_URL + CRM_API_TOKEN no .env + etapas criadas.
// Uso:
//   node scripts/crm-smoke.js [telefone]   roda a sequência e limpa no fim
//   node scripts/crm-smoke.js --clean      só apaga cards "SMOKE CRM — apagar"

import 'dotenv/config';
import { crmEnabled, espelharTransicao, removerLead, removerNegocio } from '../src/crm-client.js';

const TITULO = 'SMOKE CRM — apagar';
const BASE = (process.env.CRM_BASE_URL || '').replace(/\/+$/, '');
const H = { Authorization: `Bearer ${process.env.CRM_API_TOKEN || ''}` };

const args = process.argv.slice(2);
const soLimpar = args.includes('--clean');
const TELEFONE = args.find(a => !a.startsWith('--')) || '5548988887777';
const lead0 = { telefone: TELEFONE, nome: TITULO, empresa: 'Teste Luminus' };

const SEQUENCIA = [
  'em-cadencia', 'mql-respondeu', 'mql-qualificado',
  'humano-atendendo', 'sql-contato-feito', 'sql-ganho',
];

async function listar(funil, recurso) {
  const r = await fetch(`${BASE}/api/external/${funil}/${recurso}/`, { headers: H });
  const j = await r.json();
  return j?.results || j || [];
}

// Apaga todos os cards de smoke (por título) nos dois funis. Limpa órfãos.
async function limparSmoke() {
  const leads = (await listar('marketing', 'leads')).filter(c => c.title === TITULO);
  const deals = (await listar('sales', 'deals')).filter(c => c.title === TITULO);
  for (const l of leads) await removerLead(l.id);
  for (const d of deals) await removerNegocio(d.id);
  console.log(`  limpeza: ${leads.length} lead(s) + ${deals.length} negócio(s) "${TITULO}" removidos`);
}

async function main() {
  if (!crmEnabled()) { console.error('✗ CRM off: preencha CRM_BASE_URL e CRM_API_TOKEN no .env.'); process.exit(1); }

  if (soLimpar) {
    console.log('→ Limpando cards de smoke...');
    await limparSmoke();
    console.log('✓ Limpo.');
    return;
  }

  console.log(`→ Telefone smoke: ${TELEFONE}`);
  console.log('→ Pré-limpeza (remove sobras de rodadas anteriores)...');
  await limparSmoke();

  console.log('\n→ Rodando sequência (carregando id entre transições):');
  let lead = { ...lead0 };
  const idsLead = new Set(), idsDeal = new Set();
  for (const etapa of SEQUENCIA) {
    const patch = await espelharTransicao(lead, etapa);
    if (patch) lead = { ...lead, ...patch };           // simula persistência no Supabase
    if (lead.crm_lead_id) idsLead.add(lead.crm_lead_id);
    if (lead.crm_deal_id) idsDeal.add(lead.crm_deal_id);
    console.log(`  ✓ ${etapa.padEnd(18)} lead=${lead.crm_lead_id ?? '–'} deal=${lead.crm_deal_id ?? '–'}`);
  }

  const ok = idsLead.size <= 1 && idsDeal.size <= 1;
  console.log(`\n  IDs de lead distintos: ${[...idsLead].join(',') || '–'} | IDs de negócio distintos: ${[...idsDeal].join(',') || '–'}`);
  console.log(ok
    ? '  ✓ IDEMPOTENTE — 1 lead + 1 negócio, movidos pelas etapas (não recriados).'
    : '  ✗ FALHOU — mais de um card criado; idempotência quebrada.');

  console.log('\n→ Limpeza final...');
  await limparSmoke();
  console.log(ok ? '\n✓ Smoke OK.' : '\n✗ Smoke com falha.');
  if (!ok) process.exit(1);
}

main().catch(e => { console.error('✗ Falhou:', e.message); process.exit(1); });
