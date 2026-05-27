// Reagenda TODOS os agendamentos pendentes da campanha Intec, refatiando a fila.
// Motivo: o 1º dia (27/05) quebrou por falta de crédito Anthropic e os toques
// ficaram atrasados. Decisão Douglas (2026-05-27): amanhã (28/05) mandar 80 leads
// das 08h às 17h; demais dias úteis voltam a 50/dia (08h-13h).
//
// Preserva a ordem original da fila (agendado_para, id) — os atrasados de hoje
// saem primeiro. Só mexe em status='pendente'. Não dispara nada (sem Anthropic).
//
// Simulação (default): imprime o cronograma, NÃO grava.
// Commit:  node scripts/reagendar-intec.js --commit
import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';

const COMMIT = process.argv.includes('--commit');

// Tamanho de cada dia útil a partir de amanhã. Primeiro dia 80, resto 50.
const PRIMEIRO_DIA = 80;
const POR_DIA = 50;

// Janelas (hora local SP). Dia de recuperação usa janela cheia; demais, manhã.
const JANELA_RECUP = { ini: 8, fim: 17 };   // dia de 80
const JANELA_NORMAL = { ini: 8, fim: 13 };  // dias de 50

function proximoDiaUtil(base) {
  const d = new Date(base);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function hhmm(d) {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Distribui N itens uniformemente entre [ini:00, fim:00] do dia, com jitter ±90s.
// Devolve array de Date (UTC) já clampado dentro da janela.
function slotsDoDia(diaBase, n, janela) {
  const inicio = new Date(diaBase); inicio.setHours(janela.ini, 0, 0, 0);
  const fim = new Date(diaBase); fim.setHours(janela.fim, 0, 0, 0);
  const spanMs = fim.getTime() - inicio.getTime();
  const passo = n > 1 ? spanMs / (n - 1) : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    let t = inicio.getTime() + Math.round(i * passo) + rnd(-90, 90) * 1000;
    t = Math.max(inicio.getTime(), Math.min(fim.getTime(), t));
    out.push(new Date(t));
  }
  out.sort((a, b) => a - b);
  return out;
}

// pendentes na ordem original da fila
const { data: pend, error } = await supabase
  .from('agendamentos_disparos')
  .select('id, lead_id, agendado_para')
  .eq('status', 'pendente')
  .order('agendado_para', { ascending: true })
  .order('id', { ascending: true });
if (error) { console.error('erro:', error.message); process.exit(1); }
console.log(`Pendentes a reagendar: ${pend.length} | dia1=${PRIMEIRO_DIA} depois ${POR_DIA}/dia | COMMIT=${COMMIT}\n`);

// monta o plano: dia 1 = amanhã (80), dias seguintes = 50
let dia = proximoDiaUtil(new Date(Date.now() + 24 * 3600 * 1000));
let idx = 0;
const updates = [];
let primeiro = true;
while (idx < pend.length) {
  const tamanho = primeiro ? PRIMEIRO_DIA : POR_DIA;
  const janela = primeiro ? JANELA_RECUP : JANELA_NORMAL;
  const fatia = pend.slice(idx, idx + tamanho);
  const slots = slotsDoDia(dia, fatia.length, janela);
  fatia.forEach((p, i) => updates.push({ id: p.id, lead_id: p.lead_id, quando: slots[i] }));
  idx += fatia.length;
  primeiro = false;
  dia = proximoDiaUtil(new Date(dia.getTime() + 24 * 3600 * 1000));
}

// resumo por dia
const porDia = {};
for (const u of updates) {
  const k = u.quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  (porDia[k] ??= []).push(u.quando);
}
console.log('=== Resumo por dia ===');
for (const [k, arr] of Object.entries(porDia)) {
  console.log(`${k}: ${arr.length} leads | ${hhmm(arr[0]).slice(6)} → ${hhmm(arr[arr.length - 1]).slice(6)}`);
}

if (!COMMIT) { console.log('\n[SIMULAÇÃO — nada gravado. Rode com --commit pra valer.]'); process.exit(0); }

console.log('\n[COMMIT] gravando...');
let ok = 0;
for (const u of updates) {
  const { error: e } = await supabase.from('agendamentos_disparos')
    .update({ agendado_para: u.quando.toISOString() }).eq('id', u.id);
  if (e) { console.error(`agendamento ${u.id} erro:`, e.message); continue; }
  ok++;
}
console.log(`Reagendados: ${ok}/${updates.length}`);
process.exit(0);
