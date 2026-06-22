// Recomeça a campanha Intec a partir do ponto da última entrega real (27/05).
// Contexto (incidente 2026-06-01): chip ficou desconectado/restrito; a bridge
// entrou em loop de reenvio (escrita Supabase falhando) e marcou 72 'falha' + 3
// 'enviado' que na verdade FALHARAM no uazapi (delivered=0). Nada foi entregue
// a lead desde 27/05 22:27.
//
// Este script:
//   1) RESET: tudo de 01/06 que está 'falha' ou 'enviado' (mas não entregue)
//      volta pra 'pendente' com tentativas=0.
//   2) REAGENDA: refatia TODOS os pendentes (>= 01/06) a partir do próximo dia
//      útil, preservando a ordem original da fila (atrasados primeiro).
//
// NÃO dispara nada. NÃO mexe nos 4 'enviado' de 27/05 (entregues de verdade).
// Outbound deve seguir 'pausado' — este script só arruma os dados.
//
// Simulação (default): imprime o plano, NÃO grava.
// Commit:  node scripts/recomecar-intec.js --commit
//
// Volumes por dia configuráveis (default conservador pós-restrição do chip):
//   PRIMEIRO_DIA (env) — default 30
//   POR_DIA      (env) — default 30
import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';

const COMMIT = process.argv.includes('--commit');
const PRIMEIRO_DIA = parseInt(process.env.PRIMEIRO_DIA || '30', 10);
const POR_DIA = parseInt(process.env.POR_DIA || '30', 10);

// Janela conservadora pra chip em recuperação: 09h-16h SP (dentro de 09-17 da regra).
const JANELA = { ini: 9, fim: 16 };

function proximoDiaUtil(base) {
  const d = new Date(base);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function hhmm(d) {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Distribui N itens uniformemente entre [ini:00, fim:00] do dia, jitter ±120s,
// garantindo espaçamento mínimo (a regra inegociável é 3min entre mensagens).
function slotsDoDia(diaBase, n, janela) {
  const inicio = new Date(diaBase); inicio.setHours(janela.ini, 0, 0, 0);
  const fim = new Date(diaBase); fim.setHours(janela.fim, 0, 0, 0);
  const spanMs = fim.getTime() - inicio.getTime();
  const passo = n > 1 ? spanMs / (n - 1) : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    let t = inicio.getTime() + Math.round(i * passo) + rnd(-120, 120) * 1000;
    t = Math.max(inicio.getTime(), Math.min(fim.getTime(), t));
    out.push(new Date(t));
  }
  out.sort((a, b) => a - b);
  return out;
}

// ── 1) RESET dos 'sujos' de 01/06 (falha + enviado-não-entregue) ──────────────
const { data: sujos, error: errSel } = await supabase
  .from('agendamentos_disparos')
  .select('id, lead_id, status, agendado_para')
  .gte('agendado_para', '2026-06-01 00:00:00+00')
  .lt('agendado_para', '2026-06-02 00:00:00+00')
  .in('status', ['falha', 'enviado']);
if (errSel) { console.error('erro select sujos:', errSel.message); process.exit(1); }
console.log(`Sujos de 01/06 a resetar (falha+enviado-não-entregue): ${sujos.length}`);

if (COMMIT && sujos.length) {
  let r = 0;
  for (const s of sujos) {
    const { error: e } = await supabase.from('agendamentos_disparos')
      .update({ status: 'pendente', tentativas: 0 }).eq('id', s.id);
    if (e) { console.error(`reset ${s.id} erro:`, e.message); continue; }
    r++;
  }
  console.log(`Resetados pra pendente: ${r}/${sujos.length}`);
} else if (sujos.length) {
  console.log('[SIMULAÇÃO] não resetou (rode --commit pra valer)');
}

// ── 2) REAGENDA todos os pendentes >= 01/06 ───────────────────────────────────
// Em --commit já resetamos; em simulação somamos os sujos ao conjunto pra
// mostrar o plano completo (count) corretamente.
let pend;
if (COMMIT) {
  const { data, error } = await supabase
    .from('agendamentos_disparos')
    .select('id, lead_id, agendado_para')
    .eq('status', 'pendente')
    .gte('agendado_para', '2026-06-01 00:00:00+00')
    .order('agendado_para', { ascending: true })
    .order('id', { ascending: true });
  if (error) { console.error('erro select pend:', error.message); process.exit(1); }
  pend = data;
} else {
  const { data, error } = await supabase
    .from('agendamentos_disparos')
    .select('id, lead_id, agendado_para, status')
    .gte('agendado_para', '2026-06-01 00:00:00+00')
    .in('status', ['pendente', 'falha', 'enviado'])
    .order('agendado_para', { ascending: true })
    .order('id', { ascending: true });
  if (error) { console.error('erro select pend:', error.message); process.exit(1); }
  pend = data;
}
console.log(`\nTotal a reagendar (a partir do ponto de retomada): ${pend.length}`);
console.log(`Cadência: dia1=${PRIMEIRO_DIA}, depois ${POR_DIA}/dia | janela ${JANELA.ini}h-${JANELA.fim}h | COMMIT=${COMMIT}\n`);

let dia = proximoDiaUtil(new Date(Date.now() + 24 * 3600 * 1000));
let idx = 0;
const updates = [];
let primeiro = true;
while (idx < pend.length) {
  const tamanho = primeiro ? PRIMEIRO_DIA : POR_DIA;
  const fatia = pend.slice(idx, idx + tamanho);
  const slots = slotsDoDia(dia, fatia.length, JANELA);
  fatia.forEach((p, i) => updates.push({ id: p.id, quando: slots[i] }));
  idx += fatia.length;
  primeiro = false;
  dia = proximoDiaUtil(new Date(dia.getTime() + 24 * 3600 * 1000));
}

const porDia = {};
for (const u of updates) {
  const k = u.quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  (porDia[k] ??= []).push(u.quando);
}
console.log('=== Plano por dia ===');
for (const [k, arr] of Object.entries(porDia)) {
  console.log(`${k}: ${arr.length} leads | ${hhmm(arr[0]).slice(6)} → ${hhmm(arr[arr.length - 1]).slice(6)}`);
}

if (!COMMIT) { console.log('\n[SIMULAÇÃO — nada gravado. Rode com --commit pra valer.]'); process.exit(0); }

console.log('\n[COMMIT] gravando agendado_para...');
let ok = 0;
for (const u of updates) {
  const { error: e } = await supabase.from('agendamentos_disparos')
    .update({ agendado_para: u.quando.toISOString() }).eq('id', u.id);
  if (e) { console.error(`agendamento ${u.id} erro:`, e.message); continue; }
  ok++;
}
console.log(`Reagendados: ${ok}/${updates.length}`);
console.log('\nOutbound continua PAUSADO. Despause no dashboard quando o chip estiver ok.');
process.exit(0);
