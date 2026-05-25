// Preview dos 3 toques pra UM lead, simulando "não respondeu" entre eles.
// NÃO envia, NÃO grava. Uso: node scripts/preview-3toques.js [leadId]
import 'dotenv/config';
import { formularToque } from '../src/cadence-engine.js';
import { supabase } from '../src/supabase-client.js';

const leadId = Number(process.argv[2]) || 5;
const { data: lead } = await supabase.from('leads').select('*').eq('id', leadId).single();
const { data: passos } = await supabase
  .from('passos_cadencia').select('ordem, prompt_orientacao')
  .eq('cadencia_id', 1).order('ordem');

process.stdout.write(`Lead: ${lead.empresa} — ${lead.nome} [${lead.tipo_empresa}]\n`);
const historico = [];
for (const p of passos) {
  const { texto } = await formularToque({
    lead, passo: p.ordem, promptOrientacao: p.prompt_orientacao, historico,
  });
  process.stdout.write(`\n━━━━━━━━━━ TOQUE ${p.ordem} ━━━━━━━━━━\n${texto}\n`);
  // simula que o Lúcio mandou e o lead não respondeu (alimenta o próximo toque)
  historico.push({ enviada_em: `dia-${p.ordem}`, autor: 'lucio', texto });
}
process.exit(0);
