// Enrola N leads ainda não enrolados na cadência. Para uso pelo cron diário
// (chamado via /outbound-batch indiretamente — não, ele só processa pendentes).
//
// O ciclo correto é:
//   1. Algum processo (este script ou similar) ENROLA novos leads na cadência
//      → cria registros em agendamentos_disparos com agendado_para=hoje 08h
//   2. Cron diário (WF-Lucio-CronDiario) chama /outbound-batch, que processa
//      todos pendentes da janela → envia via uazapi.
//
// Critério de seleção dos leads:
//   - leads.origem = 'xlsx-obras' (base importada)
//   - leads.cadencia_id IS NULL (ainda não entrou em cadência nenhuma)
//   - leads.status = 'novo'
//   - leads.modo = 'bot'
//   - Ordenação: prioriza tipo_empresa 'incorporadora' > 'ambos' > 'construtora'
//     > 'indefinido' (Cláudio: foco no decisor definitivo)
//   - Dentro de cada tipo: aleatório (pra não viciar em ordem do CSV)
//
// Uso:
//   node scripts/enrolar-leads-do-dia.js [opções]
//     --quantidade N           default: 70
//     --cadencia <nome>        default: geradores-b2b-v1
//     --telefone <E.164>       força esse lead (ignora critérios, pra smoke test)
//     --dry-run                lista quem seria enrolado, não enrola

import 'dotenv/config';
import { supabase, supabaseEnabled } from '../src/supabase-client.js';
import { enrolarLead } from '../src/cadence-engine.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, fb) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; };

const QTD = parseInt(arg('quantidade', '70'), 10);
const CADENCIA = arg('cadencia', 'geradores-b2b-v1');
const TELEFONE_FORCADO = arg('telefone', null);
const DRY = flag('dry-run');

if (!supabaseEnabled()) { console.error('Supabase off no .env.'); process.exit(1); }

const ORDEM_TIPO = { incorporadora: 1, ambos: 2, construtora: 3, indefinido: 4 };

async function buscarLeads() {
  if (TELEFONE_FORCADO) {
    const { data } = await supabase.from('leads').select('*').eq('telefone', TELEFONE_FORCADO).limit(1);
    return data || [];
  }
  const { data, error } = await supabase
    .from('leads')
    .select('id, telefone, nome, empresa, tipo_empresa, status, modo, cadencia_id, origem')
    .eq('origem', 'xlsx-obras')
    .is('cadencia_id', null)
    .eq('status', 'novo')
    .eq('modo', 'bot')
    .limit(2000);
  if (error) throw new Error(error.message);
  const arr = data || [];
  arr.sort((a, b) => {
    const oa = ORDEM_TIPO[a.tipo_empresa] || 5;
    const ob = ORDEM_TIPO[b.tipo_empresa] || 5;
    if (oa !== ob) return oa - ob;
    return Math.random() - 0.5;
  });
  return arr.slice(0, QTD);
}

(async () => {
  const candidatos = await buscarLeads();
  console.log(`\nCandidatos a enrolar: ${candidatos.length} (cadência=${CADENCIA}, modo=${DRY ? 'DRY-RUN' : 'real'})\n`);

  const distrib = {};
  for (const l of candidatos) distrib[l.tipo_empresa || 'null'] = (distrib[l.tipo_empresa || 'null'] || 0) + 1;
  console.log('Distribuição por tipo_empresa:', distrib);

  if (DRY) {
    candidatos.slice(0, 10).forEach((l, i) => {
      console.log(`  ${i + 1}. ${l.telefone}  ${l.nome || '(sem nome)'}  [${l.tipo_empresa}]  ${l.empresa || ''}`);
    });
    if (candidatos.length > 10) console.log(`  ... + ${candidatos.length - 10} outros`);
    console.log('\n(DRY-RUN — nada enrolado)');
    return;
  }

  let ok = 0, falha = 0;
  for (const lead of candidatos) {
    try {
      const ags = await enrolarLead(lead.id, CADENCIA);
      console.log(`  ✓ ${lead.telefone}  [${lead.tipo_empresa}]  → ${ags.length} passo(s)`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${lead.telefone}: ${err.message}`);
      falha++;
    }
  }
  console.log(`\n${ok} enrolado(s) · ${falha} falha(s).`);
})().catch(err => { console.error('[enrolar-lote] fatal:', err); process.exit(1); });
