// Apaga SOMENTE leads de teste (origem != 'xlsx-obras') e suas linhas-filho.
// PRESERVA a base de obras (origem='xlsx-obras') e a tabela obras.
//
// Uso: node scripts/wipe-test-leads.js

import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';

const PRESERVAR = 'xlsx-obras';
const TABELAS_FILHO = ['mensagens', 'agendamentos_disparos', 'transicoes_pipeline', 'eventos', 'lead_obras'];

(async () => {
  // 1) ids dos leads de teste
  const { data: alvo, error: e1 } = await supabase
    .from('leads').select('id, nome, origem').neq('origem', PRESERVAR);
  if (e1) throw e1;
  const ids = alvo.map(l => l.id);
  console.log(`[wipe] leads de teste a apagar: ${ids.length}`);
  alvo.forEach(l => console.log(`  id=${l.id} origem=${l.origem} nome=${l.nome}`));
  if (!ids.length) { console.log('[wipe] nada a fazer.'); return; }

  // 2) filhos
  for (const t of TABELAS_FILHO) {
    const { error, count } = await supabase.from(t).delete({ count: 'exact' }).in('lead_id', ids);
    if (error) { console.error(`  [${t}] ERRO: ${error.message}`); }
    else console.log(`  [${t}] removidas: ${count}`);
  }

  // 3) leads (segurança dupla: filtra por origem != xlsx-obras)
  const { error: e3, count } = await supabase
    .from('leads').delete({ count: 'exact' }).neq('origem', PRESERVAR);
  if (e3) throw e3;
  console.log(`[wipe] leads removidos: ${count}`);

  // 4) confere o que sobrou
  const { count: restante } = await supabase.from('leads').select('*', { count: 'exact', head: true });
  console.log(`[wipe] leads restantes (devem ser só xlsx-obras): ${restante}`);
})().catch(err => { console.error('[wipe] erro:', err.message); process.exit(1); });
