// Alinha as etapas do CRM ao pipeline do Chatwoot (fonte da verdade): remove
// qualquer etapa que NÃO esteja no conjunto canônico (crm-client STAGES).
//
// SEGURANÇA: só faz sentido com os funis vazios — apagar etapa com card o
// deixa órfão. O script confere a contagem de cards antes e ABORTA se houver.
//
// Uso: node scripts/crm-cleanup-stages.js

import 'dotenv/config';
import { crmEnabled, crmConfig, listarStages, limparStagesForaDoCanonico } from '../src/crm-client.js';

const BASE = (process.env.CRM_BASE_URL || '').replace(/\/+$/, '');
const H = { Authorization: `Bearer ${process.env.CRM_API_TOKEN || ''}` };

async function contarCards(funil, recurso) {
  const r = await fetch(`${BASE}/api/external/${funil}/${recurso}/`, { headers: H });
  const j = await r.json();
  return j?.count != null ? j.count : (j?.results || j || []).length;
}

async function main() {
  if (!crmEnabled()) { console.error('✗ CRM off: preencha CRM_BASE_URL e CRM_API_TOKEN no .env.'); process.exit(1); }
  console.log(`→ CRM: ${crmConfig().base}`);

  // Trava de segurança: aborta se houver qualquer card.
  const nLeads = await contarCards('marketing', 'leads');
  const nDeals = await contarCards('sales', 'deals');
  console.log(`  cards hoje — marketing/leads=${nLeads}  sales/deals=${nDeals}`);
  if (nLeads > 0 || nDeals > 0) {
    console.error('✗ ABORTADO: há cards nos funis. Apagar etapa com card órfana o card. Mova os cards antes.');
    process.exit(1);
  }

  console.log('\n→ Etapas antes:');
  for (const f of ['marketing', 'sales']) {
    const s = await listarStages(f);
    console.log(`  [${f}] ${s.map(x => x.name).join(', ')}`);
  }

  console.log('\n→ Removendo etapas fora do canônico (Chatwoot)...');
  const rel = await limparStagesForaDoCanonico();
  for (const f of ['marketing', 'sales']) {
    for (const r of rel[f]) console.log(`  ✗ [${f}] removida id=${r.id} name=${r.name}`);
    if (!rel[f].length) console.log(`  · [${f}] nada a remover`);
  }

  console.log('\n→ Etapas depois:');
  for (const f of ['marketing', 'sales']) {
    const s = await listarStages(f);
    console.log(`  [${f}] ${s.map(x => x.name).join(', ')}`);
  }
  console.log('\n✓ Limpeza concluída — CRM espelha o pipeline do Chatwoot.');
}

main().catch(e => { console.error('✗ Falhou:', e.message); process.exit(1); });
