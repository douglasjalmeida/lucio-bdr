// One-off: espelha o perfil + obras de um lead REAL da base num lead-alvo (telefone de teste),
// preservando o telefone do alvo, e re-enrola na cadência informada.
//
// Uso: node scripts/espelhar-lead-real.js <leadOrigemId> <leadAlvoId> <cadencia_nome>

import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';
import { enrolarLead } from '../src/cadence-engine.js';

const [, , origemId, alvoId, cadencia] = process.argv;
if (!origemId || !alvoId || !cadencia) {
  console.error('Uso: node scripts/espelhar-lead-real.js <origemId> <alvoId> <cadencia>');
  process.exit(1);
}

(async () => {
  // 1) perfil do lead origem
  const { data: origem, error: e1 } = await supabase
    .from('leads')
    .select('nome, empresa, razao_social, cnpj, tipo_empresa, segmento, cargo')
    .eq('id', origemId).single();
  if (e1) throw e1;

  // 2) atualiza alvo com o perfil (mantém telefone do alvo)
  const { error: e2 } = await supabase.from('leads').update(origem).eq('id', alvoId);
  if (e2) throw e2;
  console.log(`[espelhar] lead ${alvoId} agora espelha "${origem.nome}" / ${origem.empresa}`);

  // 3) limpa lead_obras antigas do alvo e copia as do origem
  await supabase.from('lead_obras').delete().eq('lead_id', alvoId);
  const { data: obras, error: e3 } = await supabase
    .from('lead_obras')
    .select('obra_id, posicao, contato_nome, contato_cargo')
    .eq('lead_id', origemId);
  if (e3) throw e3;
  if (obras?.length) {
    const rows = obras.map(o => ({ ...o, lead_id: Number(alvoId) }));
    const { error: e4 } = await supabase.from('lead_obras').insert(rows);
    if (e4) throw e4;
    console.log(`[espelhar] copiadas ${rows.length} obra(s) pro lead ${alvoId}`);
  } else {
    console.log('[espelhar] origem sem obras vinculadas');
  }

  // 4) re-enrola na cadência (cancela pendentes antigos, cria T+0 = agora)
  const ag = await enrolarLead(Number(alvoId), cadencia);
  console.log(`[espelhar] re-enrolado em "${cadencia}": ${ag.length} passos`);
  for (const a of ag) console.log(`  passo ${a.passo} → ${a.agendado_para}`);
})().catch(err => { console.error('[espelhar] erro:', err.message); process.exit(1); });
