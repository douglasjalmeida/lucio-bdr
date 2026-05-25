// Preview seguro do toque T+0: chama formularToque (mesma função do batch)
// pra alguns leads de amostra. NÃO envia, NÃO grava — só imprime o texto.
// Uso: node scripts/preview-toque1.js [id1 id2 ...]
import 'dotenv/config';
import { formularToque } from '../src/cadence-engine.js';
import { supabase } from '../src/supabase-client.js';

const ids = process.argv.slice(2).map(Number).filter(Boolean);
const alvo = ids.length ? ids : [5, 6, 7, 8, 9];

const { data: passo, error: ep } = await supabase
  .from('passos_cadencia').select('prompt_orientacao')
  .eq('cadencia_id', 1).eq('ordem', 1).single();
if (ep) { console.error('erro prompt:', ep.message); process.exit(1); }

const { data: leads, error: el } = await supabase
  .from('leads').select('*').in('id', alvo);
if (el) { console.error('erro leads:', el.message); process.exit(1); }

for (const lead of leads) {
  process.stdout.write(`\n══════════════════════════════════════════\n`);
  process.stdout.write(`${lead.empresa} — ${lead.nome} [${lead.tipo_empresa}]\n`);
  process.stdout.write(`tel ${lead.telefone}\n──────────────────────────────────────────\n`);
  try {
    const { texto } = await formularToque({
      lead, passo: 1, promptOrientacao: passo.prompt_orientacao, historico: [],
    });
    process.stdout.write(texto + '\n');
  } catch (e) {
    process.stdout.write(`[erro ao formular: ${e.message}]\n`);
  }
}
process.exit(0);
