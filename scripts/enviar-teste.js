// Disparo de teste do Lúcio — SEMPRE pela bridge (skill envio-pela-bridge).
// Enrola os leads na cadência (cria card no CRM Marketing via transição em-cadencia)
// e dispara via <BRIDGE_PUBLIC_URL>/outbound-batch — que manda no WhatsApp E espelha
// no Chatwoot. NUNCA usa uazapi direta (isso entregaria só no zap, sem Chatwoot/CRM).
//
//   node scripts/enviar-teste.js          → PREVIEW (dryRun: formula, não envia)
//   node scripts/enviar-teste.js --send   → DISPARA de verdade
//
// Bypass de janela ligado (CADENCE_IGNORAR_JANELA=1) só pra o agendamento ficar
// elegível agora; a entrega no zap ainda depende do WF-Lucio-Outbound.
//
// ⚠️ /outbound-batch é GLOBAL: processa TODOS os agendamentos pendentes/devidos,
// não só os destes leads. Rodar só quando não houver outros leads devidos.

process.env.CADENCE_IGNORAR_JANELA = '1';

import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';
import { enrolarLead } from '../src/cadence-engine.js';

const IDS = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const ALVOS = IDS.length ? IDS : [395, 396]; // Douglas, Fernando
const ENVIAR = process.argv.includes('--send');
const CADENCIA = 'geradores-b2b-v1';
const BRIDGE = (process.env.BRIDGE_PUBLIC_URL || '').replace(/\/+$/, '');

async function main() {
  if (!BRIDGE) { console.error('✗ BRIDGE_PUBLIC_URL não setado no .env.'); process.exit(1); }

  console.log(`→ Enrolando ${ALVOS.length} lead(s) em "${CADENCIA}" (cria card no CRM Marketing)...`);
  for (const id of ALVOS) {
    const { data: lead } = await supabase.from('leads').select('id, nome, telefone').eq('id', id).maybeSingle();
    if (!lead) { console.log(`  ! lead ${id} não existe — pulando`); continue; }
    await enrolarLead(id, CADENCIA);
    console.log(`  ✓ ${lead.nome} (${lead.telefone}) enrolado`);
  }

  // dryRun → preview; senão → dispara. SEMPRE pela bridge.
  console.log(`\n→ POST ${BRIDGE}/outbound-batch  (dryRun=${!ENVIAR})`);
  const r = await fetch(`${BRIDGE}/outbound-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limite: 50, dryRun: !ENVIAR }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('✗ bridge respondeu', r.status, JSON.stringify(j)); process.exit(1); }

  console.log(`\n=== resultado (${j.total} pendente(s) processado(s)) ===`);
  for (const res of j.resultados || []) {
    if (res.status === 'dry') {
      console.log(`\n──────── agendamento ${res.agendamentoId} (PREVIEW) ────────`);
      console.log(res.texto);
    } else {
      console.log(`  ${res.status.padEnd(10)} agendamento=${res.agendamentoId} lead=${res.leadId ?? '?'} passo=${res.passo ?? '?'}`);
    }
  }
  console.log(ENVIAR
    ? '\n✓ Disparado pela bridge. Confira: WhatsApp + conversa no Chatwoot + card no CRM Marketing.'
    : '\n→ PREVIEW (nada enviado). Revise o texto e rode com --send pra disparar.');
}

main().catch(e => { console.error('✗ Falhou:', e.message); process.exit(1); });
