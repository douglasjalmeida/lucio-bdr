// Enrola a lista Intec (leads origem=xlsx-obras) na cadência 1 (geradores-b2b-v1),
// 1 toque (T+0), escalonando 50 leads por dia útil, cada lead com horário irregular
// (gap aleatório 3-10min a partir das 08:00 do seu dia).
//
// Modo simulação (default): calcula e imprime o cronograma, NÃO grava.
// Modo commit:  node scripts/enrolar-intec.js --commit   → grava no banco.
import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';

const COMMIT = process.argv.includes('--commit');
const POR_DIA = 50;
const GAP_MIN = 180, GAP_MAX = 600;   // 3 a 10 min, em segundos
const HORA_INICIO = 8;                // 08:00 BRT
const CADENCIA_ID = 1;

// próximo dia útil >= base (seg-sex)
function proximoDiaUtil(base) {
  const d = new Date(base);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function hhmm(d) {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// leads ainda não enrolados
const { data: leads, error } = await supabase
  .from('leads').select('id, nome, empresa')
  .eq('origem', 'xlsx-obras').is('cadencia_id', null)
  .order('id', { ascending: true });
if (error) { console.error('erro leads:', error.message); process.exit(1); }
console.log(`Leads a enrolar: ${leads.length} | ${POR_DIA}/dia | gap ${GAP_MIN/60}-${GAP_MAX/60}min | COMMIT=${COMMIT}\n`);

// monta cronograma
const agora = new Date();
let dia = proximoDiaUtil(new Date(agora.getTime() + 24 * 3600 * 1000)); // começa amanhã (próx. dia útil)
dia.setHours(HORA_INICIO, 0, 0, 0);

const plano = [];
let noDia = 0, cursor = new Date(dia);
for (let i = 0; i < leads.length; i++) {
  if (noDia === POR_DIA) {
    dia = proximoDiaUtil(new Date(dia.getTime() + 24 * 3600 * 1000));
    dia.setHours(HORA_INICIO, 0, 0, 0);
    cursor = new Date(dia); noDia = 0;
  }
  if (noDia > 0) cursor = new Date(cursor.getTime() + rnd(GAP_MIN, GAP_MAX) * 1000);
  plano.push({ lead: leads[i], quando: new Date(cursor) });
  noDia++;
}

// resumo por dia
const porDia = {};
for (const p of plano) {
  const k = p.quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  (porDia[k] ??= []).push(p.quando);
}
console.log('=== Resumo por dia ===');
for (const [k, arr] of Object.entries(porDia)) {
  console.log(`${k}: ${arr.length} leads | ${hhmm(arr[0]).slice(6)} → ${hhmm(arr[arr.length-1]).slice(6)}`);
}

// detalhe do 1º dia
const primeiroDia = Object.keys(porDia)[0];
console.log(`\n=== Cronograma completo do 1º dia (${primeiroDia}) ===`);
plano.filter(p => p.quando.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}) === primeiroDia)
  .forEach((p, i) => console.log(`${String(i+1).padStart(2)}. ${hhmm(p.quando).slice(6)}  ${p.lead.empresa} (${p.lead.nome})`));

if (!COMMIT) { console.log('\n[SIMULAÇÃO — nada gravado. Rode com --commit pra valer.]'); process.exit(0); }

// grava
console.log('\n[COMMIT] gravando...');
let ok = 0;
for (const p of plano) {
  const { error: e1 } = await supabase.from('agendamentos_disparos')
    .insert({ lead_id: p.lead.id, passo: 1, agendado_para: p.quando.toISOString(), status: 'pendente' });
  if (e1) { console.error(`lead ${p.lead.id} agendamento erro:`, e1.message); continue; }
  const { error: e2 } = await supabase.from('leads')
    .update({ cadencia_id: CADENCIA_ID, passo_atual: 0, status: 'em_cadencia' }).eq('id', p.lead.id);
  if (e2) { console.error(`lead ${p.lead.id} update erro:`, e2.message); continue; }
  ok++;
}
console.log(`Enrolados: ${ok}/${plano.length}`);
process.exit(0);
