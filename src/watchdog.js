// Watchdog: leads em handoff (modo=mudo) cuja última msg é do lead e está parada
// há mais de WATCHDOG_HANDOFF_TIMEOUT_MIN minutos → Lúcio retoma automaticamente,
// gera resposta com histórico completo (inclui notas privadas do closer) e envia.
//
// Idempotência: registra evento `lucio_retomou_auto` referenciando o id da última
// msg do lead. Se já existe esse evento depois dessa msg, pula.
//
// Janela: respeita 09–17h seg-sex America/Sao_Paulo (reusa proximoSlotUtil do
// cadence-engine). CADENCE_IGNORAR_JANELA=1 ignora.

import {
  supabase, supabaseEnabled, devolverPraBot, gravarMensagem, registrarEvento,
  espelharNotaNoCrm,
} from './supabase-client.js';
import {
  chatwootEnabled, garantirLeadNoChatwoot, espelharMensagemConversa,
  addNotaPrivada, removerLabels, registrarOutboundDoBridge,
} from './chatwoot-client.js';
import { gerarRespostaInbound, pareceVazamentoInterno } from './lucio-agent.js';
import { enviarTextoImediato, uazapiEnabled } from './uazapi-client.js';
import { proximoSlotUtil } from './cadence-engine.js';

const TIMEOUT_MIN = +(process.env.WATCHDOG_HANDOFF_TIMEOUT_MIN || 60);

function dentroDaJanela() {
  if (process.env.CADENCE_IGNORAR_JANELA === '1') return true;
  const now = new Date();
  const slot = proximoSlotUtil(now);
  return Math.abs(slot.getTime() - now.getTime()) < 60_000;
}

export async function revisarHandoffsAbandonados() {
  if (!supabaseEnabled() || !uazapiEnabled()) return { processados: 0, motivo: 'deps off' };
  if (!dentroDaJanela()) return { processados: 0, motivo: 'fora-janela' };

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, telefone, nome, empresa, segmento, modo, status, origem, cadencia_id, passo_atual')
    .eq('modo', 'mudo')
    .not('status', 'in', '("encerrado","qualificado","descartado")');
  if (error) { console.error('[watchdog] erro buscando leads:', error.message); return { processados: 0 }; }

  let processados = 0;
  for (const lead of leads || []) {
    try {
      const { data: msgs } = await supabase
        .from('mensagens')
        .select('id, direcao, autor, texto, enviada_em')
        .eq('lead_id', lead.id)
        .order('enviada_em', { ascending: false })
        .limit(30);
      if (!msgs?.length) continue;

      const ultima = msgs[0];
      if (ultima.direcao !== 'in' || ultima.autor !== 'lead') continue;

      const idadeMin = (Date.now() - new Date(ultima.enviada_em).getTime()) / 60000;
      if (idadeMin < TIMEOUT_MIN) continue;

      const { data: evs } = await supabase
        .from('eventos')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('tipo', 'lucio_retomou_auto')
        .gt('criado_em', ultima.enviada_em)
        .limit(1);
      if (evs?.length) continue;

      await registrarEvento(lead.id, 'lucio_retomou_auto', {
        minutos_parado: Math.round(idadeMin), ultima_msg_id: ultima.id,
      });
      await devolverPraBot(lead.id);

      const historico = msgs.slice().reverse();
      const { resposta, tokensIn, tokensOut } = await gerarRespostaInbound({
        lead, historico, mensagemAtual: ultima.texto,
      });
      if (!resposta) { console.warn(`[watchdog] lead ${lead.id}: SDK vazio`); continue; }
      if (pareceVazamentoInterno(resposta)) {
        console.error(`[watchdog] BLOQUEADO: resposta parece estado interno, NÃO enviada ao lead ${lead.id} :: "${resposta.slice(0, 200)}"`);
        await registrarEvento(lead.id, 'resposta_bloqueada_vazamento', { origem: 'watchdog', trecho: resposta.slice(0, 300) });
        continue;
      }

      registrarOutboundDoBridge({ telefone: lead.telefone, conteudo: resposta });
      await enviarTextoImediato({ telefone: lead.telefone, texto: resposta });

      await gravarMensagem({
        lead_id: lead.id, chatid: null, direcao: 'out', autor: 'ia',
        texto: resposta, modo_no_momento: 'bot',
        tokens_in: tokensIn, tokens_out: tokensOut,
      });

      if (chatwootEnabled()) {
        try {
          const cw = await garantirLeadNoChatwoot({
            telefone: lead.telefone, nome: lead.nome,
            customAttrs: { empresa: lead.empresa || '' },
          });
          if (cw?.conversationId) {
            const notaWatchdog = `⏰ Lúcio retomou automaticamente — humano sem resposta há ${Math.round(idadeMin)}min.`;
            await addNotaPrivada(cw.conversationId, notaWatchdog);
            espelharNotaNoCrm(lead.id, notaWatchdog)
              .catch(e => console.warn('[watchdog] espelho nota CRM falhou:', e.message));
            await espelharMensagemConversa({
              conversationId: cw.conversationId, content: resposta, direction: 'out',
            });
            await removerLabels(cw.conversationId, ['humano-atendendo']);
          }
        } catch (err) {
          console.error('[watchdog] erro Chatwoot:', err.message);
        }
      }

      processados++;
      console.log(`[watchdog] lead ${lead.id} retomado automaticamente (${Math.round(idadeMin)}min sem humano)`);
    } catch (err) {
      console.error(`[watchdog] erro processando lead ${lead.id}:`, err.message);
    }
  }

  return { processados };
}
