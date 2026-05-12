// Enrola 1 lead numa cadência. Cria o lead se não existir.
//
// Uso:
//   node scripts/enrolar-lead.js +5562999999999 geradores-b2b-v1-teste
//   node scripts/enrolar-lead.js +5562999999999 geradores-b2b-v1-teste "João" "Padaria do João"
//
// Args: <telefone> <cadencia_nome> [nome] [empresa] [segmento]

import 'dotenv/config';
import {
  supabaseEnabled,
  buscarLeadPorTelefone,
  criarLead,
} from '../src/supabase-client.js';
import { enrolarLead } from '../src/cadence-engine.js';

const [, , telefone, cadenciaNome, nome, empresa, segmento] = process.argv;

if (!telefone || !cadenciaNome) {
  console.error('Uso: node scripts/enrolar-lead.js <telefone E.164> <cadencia> [nome] [empresa] [segmento]');
  process.exit(1);
}
if (!supabaseEnabled()) {
  console.error('Supabase não configurado. Verifica SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env');
  process.exit(1);
}

(async () => {
  let lead = await buscarLeadPorTelefone(telefone);
  if (!lead) {
    lead = await criarLead({
      nome: nome || null,
      empresa: empresa || null,
      telefone,
      segmento: segmento || null,
      origem: 'csv-manual',
    });
    console.log(`[enrolar] criado lead id=${lead.id} telefone=${telefone}`);
  } else {
    console.log(`[enrolar] lead já existe id=${lead.id} status=${lead.status}`);
  }

  const agendamentos = await enrolarLead(lead.id, cadenciaNome);
  console.log(`[enrolar] cadência "${cadenciaNome}" agendada com ${agendamentos.length} passos:`);
  for (const a of agendamentos) {
    console.log(`  passo ${a.passo} → ${a.agendado_para}`);
  }
})().catch(err => {
  console.error('[enrolar] erro:', err.message);
  process.exit(1);
});
