// Analisa a temperatura de leads sob demanda (batch controlado, fora do request
// HTTP). Popula a tabela `eventos` (tipo='lead_temperatura') que o dashboard lê.
//
// Uso:
//   node scripts/analisar-temperatura.js                 # analisa até N leads (default 1) com histórico
//   node scripts/analisar-temperatura.js <lead_id>       # analisa 1 lead específico
//   node scripts/analisar-temperatura.js <lead_id> force # reanalisa mesmo sem mensagem nova
//   node scripts/analisar-temperatura.js --limite 20     # batch dos leads mais recentes
//
// É 1 lead por vez (sequencial) de propósito: cada análise é uma chamada Haiku;
// rodar em massa custa token. Use limite consciente.

import 'dotenv/config';
import { supabase, supabaseEnabled } from '../src/supabase-client.js';
import { analisarTemperatura } from '../src/temperatura-analyzer.js';

const args = process.argv.slice(2);
const force = args.includes('force') || args.includes('--force');
const limiteIdx = args.indexOf('--limite');
const limite = limiteIdx >= 0 ? parseInt(args[limiteIdx + 1] || '1', 10) : 1;
const leadIdArg = args.find(a => /^\d+$/.test(a));

async function pegarLeads() {
  if (leadIdArg) {
    const { data } = await supabase.from('leads').select('*').eq('id', leadIdArg).maybeSingle();
    return data ? [data] : [];
  }
  // Sem id: pega os leads mais recentes (qualquer status) pra um batch enxuto.
  const { data } = await supabase
    .from('leads')
    .select('id, nome, empresa, segmento, status, cadencia_id, telefone')
    .order('id', { ascending: false })
    .limit(limite);
  return data || [];
}

async function main() {
  if (!supabaseEnabled()) {
    console.error('Supabase não configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
  }

  const leads = await pegarLeads();
  if (!leads.length) {
    console.error('Nenhum lead encontrado.');
    process.exit(1);
  }

  console.log(`Analisando ${leads.length} lead(s)${force ? ' (force)' : ''}...\n`);
  for (const lead of leads) {
    const t0 = Date.now();
    const r = await analisarTemperatura(lead, { force });
    const ms = Date.now() - t0;
    console.log(`── lead #${lead.id} — ${lead.nome || '?'} / ${lead.empresa || '?'} (${ms}ms)`);
    console.log(JSON.stringify(r, null, 2));
    console.log('');
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
