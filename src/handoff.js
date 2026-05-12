// Handoff = transição MQL→SQL: Lúcio para de responder, closer humano assume.
// Executa: Supabase (marca qualificado + modo mudo), Chatwoot (label + nota + atribui team),
// e notifica Douglas/closer via webhook n8n (opcional).

import {
  marcarLeadQualificado, marcarHandoff, atualizarLead,
} from './supabase-client.js';
import {
  chatwootEnabled, aplicarLabelsAditivo, removerLabels,
  addNotaPrivada, atribuirTeam, atualizarAtributosContato,
} from './chatwoot-client.js';

const TEAM_ID = parseInt(process.env.CHATWOOT_CLOSERS_TEAM_ID || '0', 10) || null;
const NOTIFY_URL = process.env.N8N_HANDOFF_NOTIFY_URL || '';
const NOTIFY_NUMERO = process.env.HANDOFF_NOTIFY_NUMERO || '';

// Detector de modo do lead (mantido do stub original).
// - lead.modo === 'mudo' → bridge grava mas NÃO responde.
// - autor === 'humano' → grava direcao=out, NÃO responde.
// - lead.modo === 'bot' && autor === 'lead' → roda SDK e responde.
export function deveResponder({ lead, autor }) {
  if (autor === 'humano') return false;
  if (lead?.modo === 'mudo') return false;
  return true;
}

export function direcaoDaMensagem(autor) {
  if (autor === 'humano' || autor === 'ia') return 'out';
  return 'in';
}

function montarNotaPrivada({ lead, qualificacao }) {
  return [
    `🚨 MQL qualificado por Lúcio — handoff`,
    ``,
    `*Lead:* ${lead.nome || '?'} ${lead.empresa ? `(${lead.empresa})` : ''}`,
    `*Telefone:* ${lead.telefone}`,
    `*Urgência:* ${qualificacao.urgencia || '-'}`,
    `*Dor:* ${qualificacao.dor_identificada || '-'}`,
    ``,
    `*Sinais que dispararam:* ${qualificacao.sinais || '-'}`,
    `*Resumo pro closer:* ${qualificacao.motivo_handoff || '-'}`,
    ``,
    `Lúcio entrou em modo mudo. Aplicar label \`devolver-lucio\` se quiser devolver o atendimento ao bot.`,
  ].join('\n');
}

function montarNotificacaoWhats({ lead, qualificacao }) {
  return [
    `🚨 Lead MQL qualificado pelo Lúcio:`,
    ``,
    `${lead.nome || '?'} ${lead.empresa ? `(${lead.empresa})` : ''}`,
    `Tel: ${lead.telefone}`,
    `Urgência: ${qualificacao.urgencia}`,
    `Dor: ${qualificacao.dor_identificada || '-'}`,
    ``,
    `${qualificacao.motivo_handoff || ''}`,
    ``,
    `Chatwoot: conversa aberta pro time Closers.`,
  ].join('\n');
}

export async function executarHandoff({ lead, qualificacao, chatwootCtx }) {
  const resultado = { lead_id: lead.id, supabase: false, chatwoot: false, notify: false };

  // 1. Supabase: marcar qualificado + handoff (modo=mudo)
  try {
    await marcarLeadQualificado(lead.id, qualificacao.motivo_handoff || qualificacao.sinais);
    await marcarHandoff(lead.id, {
      urgencia: qualificacao.urgencia,
      dor: qualificacao.dor_identificada,
      sinais: qualificacao.sinais,
    });
    resultado.supabase = true;
  } catch (err) {
    console.error('[handoff] erro Supabase:', err.message);
  }

  // 2. Chatwoot: label + nota privada + atribui team + atributos do contato
  if (chatwootEnabled() && chatwootCtx?.conversationId) {
    try {
      await removerLabels(chatwootCtx.conversationId, ['mql-em-cadencia', 'mql-respondeu']);
      await aplicarLabelsAditivo(chatwootCtx.conversationId, ['mql-qualificado']);
      await addNotaPrivada(chatwootCtx.conversationId, montarNotaPrivada({ lead, qualificacao }));
      if (TEAM_ID) await atribuirTeam(chatwootCtx.conversationId, TEAM_ID);
      if (chatwootCtx.contactId) {
        await atualizarAtributosContato(chatwootCtx.contactId, {
          dor_identificada: qualificacao.dor_identificada || '',
          urgencia: qualificacao.urgencia || 'sem-prazo',
        });
      }
      resultado.chatwoot = true;
    } catch (err) {
      console.error('[handoff] erro Chatwoot:', err.message);
    }
  }

  // 3. Notificação WhatsApp pessoal (via webhook n8n existente) — opcional
  if (NOTIFY_URL && NOTIFY_NUMERO) {
    try {
      const r = await fetch(NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numero: NOTIFY_NUMERO,
          mensagem: montarNotificacaoWhats({ lead, qualificacao }),
          tipo: 'texto',
        }),
      });
      resultado.notify = r.ok;
      if (!r.ok) console.error('[handoff] notify http', r.status);
    } catch (err) {
      console.error('[handoff] erro notify:', err.message);
    }
  }

  console.log(`[handoff] lead=${lead.id} supabase=${resultado.supabase} chatwoot=${resultado.chatwoot} notify=${resultado.notify}`);
  return resultado;
}
