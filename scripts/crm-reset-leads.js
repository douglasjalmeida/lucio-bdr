// Reseta o espelho CRM de leads específicos: apaga os cards no CRM (lead no
// Marketing + negócio no Vendas) e zera crm_lead_id/crm_deal_id no Supabase.
// Usado pra limpar cards de teste e devolver o CRM à consistência com o Chatwoot.
//
// Uso: node scripts/crm-reset-leads.js 395 396

import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';
import { crmEnabled, removerLead, removerNegocio } from '../src/crm-client.js';

const IDS = process.argv.slice(2).map(Number).filter(Boolean);

async function main() {
  if (!IDS.length) { console.error('Uso: node scripts/crm-reset-leads.js <leadId> [<leadId>...]'); process.exit(1); }
  if (!crmEnabled()) { console.error('✗ CRM off.'); process.exit(1); }

  const { data: leads } = await supabase
    .from('leads').select('id, nome, crm_lead_id, crm_deal_id').in('id', IDS);

  for (const l of leads || []) {
    console.log(`\n→ ${l.nome} (lead ${l.id})  crm_lead_id=${l.crm_lead_id ?? '–'} crm_deal_id=${l.crm_deal_id ?? '–'}`);
    if (l.crm_lead_id) {
      try { await removerLead(l.crm_lead_id); console.log(`  ✗ card Marketing id=${l.crm_lead_id} removido`); }
      catch (e) { console.log(`  ! Marketing id=${l.crm_lead_id}: ${e.message}`); }
    }
    if (l.crm_deal_id) {
      try { await removerNegocio(l.crm_deal_id); console.log(`  ✗ negócio Vendas id=${l.crm_deal_id} removido`); }
      catch (e) { console.log(`  ! Vendas id=${l.crm_deal_id}: ${e.message}`); }
    }
    await supabase.from('leads').update({ crm_lead_id: null, crm_deal_id: null }).eq('id', l.id);
    console.log(`  ↺ crm_lead_id/crm_deal_id zerados no Supabase`);
  }
  console.log('\n✓ Reset concluído.');
}

main().catch(e => { console.error('✗ Falhou:', e.message); process.exit(1); });
