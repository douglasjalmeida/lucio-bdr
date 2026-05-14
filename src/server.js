import 'dotenv/config';
import express from 'express';
import {
  supabaseEnabled,
  buscarLeadPorTelefone,
  criarLead,
  gravarMensagem,
  ultimasMensagensDoLead,
  devolverPraBot,
  atualizarLead,
  registrarEvento,
} from './supabase-client.js';
import { deveResponder, executarHandoff } from './handoff.js';
import { gerarRespostaInbound } from './lucio-agent.js';
import { avaliarQualificacao } from './qualifier.js';
import {
  chatwootEnabled,
  garantirLeadNoChatwoot,
  espelharMensagemConversa,
  aplicarLabelsAditivo,
  removerLabels,
  foiEspelhadoPeloBridge,
  addNotaPrivada,
  registrarOutboundDoBridge,
  jaEnviadoPeloBridge,
} from './chatwoot-client.js';
import { enfileirarMensagem, bufferSeconds, bufferEnabled } from './buffer.js';
import { revisarHandoffsAbandonados } from './watchdog.js';
import {
  puxarPendentes,
  formularToque,
  marcarEnviado,
  resetarCadenciaSeRespondeu,
} from './cadence-engine.js';
import { enviarTextoImediato, uazapiEnabled } from './uazapi-client.js';
import crypto from 'node:crypto';

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = parseInt(process.env.PORT || '8788', 10);
const N8N_OUT_WEBHOOK_URL = process.env.N8N_OUT_WEBHOOK_URL;

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    bridge: 'lucio',
    supabase: supabaseEnabled(),
    chatwoot: chatwootEnabled(),
    bufferSeconds: bufferEnabled() ? bufferSeconds() : 0,
    model: process.env.LUCIO_MODEL || 'claude-sonnet-4-6',
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /in — chamado pelo WF-Lucio-IN do n8n quando uma mensagem chega no WhatsApp.
// Body: { telefone, nome, mensagem, chatid, timestamp, autor }
//
// Estratégia: responde 200 imediato pro n8n (evita timeout) e processa
// a mensagem assíncrono. Mensagens autor=lead passam por buffer (agrupa
// rajadas em uma única chamada Claude). Mensagens autor=humano só gravam.
// ──────────────────────────────────────────────────────────────────────────
app.post('/in', async (req, res) => {
  const { telefone, nome, mensagem, chatid, timestamp, autor } = req.body || {};
  if (!telefone || !mensagem || !autor) {
    return res.status(400).json({ ok: false, erro: 'telefone, mensagem e autor são obrigatórios' });
  }

  res.json({ ok: true, recebido: true });

  if (autor === 'humano') {
    Promise.resolve(gravarHumano({ telefone, nome, mensagem, chatid })).catch(err => console.error('[bridge] erro humano:', err));
    return;
  }

  // Fast-path: se lead em modo mudo (humano/closer atendendo), pula buffer
  // e processa imediatamente — só grava + espelha no Chatwoot, sem LLM.
  Promise.resolve(processarSeLeadMudo({ telefone, nome, mensagem, chatid }))
    .then(ehMudo => {
      if (!ehMudo) enfileirarMensagem({ telefone, nome, mensagem, chatid, timestamp, autor }, processarBatch);
    })
    .catch(err => {
      console.error('[bridge] erro no fast-path mudo, caindo no buffer:', err.message);
      enfileirarMensagem({ telefone, nome, mensagem, chatid, timestamp, autor }, processarBatch);
    });
});

async function processarSeLeadMudo({ telefone, nome, mensagem, chatid }) {
  if (!supabaseEnabled()) return false;
  const lead = await buscarLeadPorTelefone(telefone);
  if (!lead || lead.modo !== 'mudo') return false;

  await gravarMensagem({
    lead_id: lead.id, chatid, direcao: 'in', autor: 'lead',
    texto: mensagem, modo_no_momento: lead.modo,
  });

  if (chatwootEnabled()) {
    try {
      const cw = await garantirLeadNoChatwoot({
        telefone, nome: lead.nome || nome,
        customAttrs: { empresa: lead.empresa || '' },
      });
      if (cw?.conversationId) {
        await espelharMensagemConversa({ conversationId: cw.conversationId, content: mensagem, direction: 'in' });
      }
    } catch (err) {
      console.error('[bridge] erro espelhando inbound (mudo) no Chatwoot:', err.message);
    }
  }
  console.log(`[bridge] msg do lead ${lead.id} entregue ao closer (modo mudo, sem buffer)`);
  return true;
}

async function gravarHumano({ telefone, nome, mensagem, chatid }) {
  if (!supabaseEnabled()) return;
  let lead = await buscarLeadPorTelefone(telefone);
  if (!lead) lead = await criarLead({ nome, telefone, origem: 'inbound' });
  await gravarMensagem({
    lead_id: lead.id,
    chatid,
    direcao: 'out',
    autor: 'humano',
    texto: mensagem,
    modo_no_momento: lead.modo,
  });

  // Modo mudo automático: humano respondeu pelo celular → Lúcio para de responder.
  // Idempotente: só dispara transição se ainda estava em bot.
  if (lead.modo !== 'mudo') {
    try {
      await atualizarLead(lead.id, { modo: 'mudo', status: 'handoff' });
      await registrarEvento(lead.id, 'handoff_humano_celular', { canal: 'whatsapp', via: 'fromMeYes+wasNotSentByApi' });
      console.log(`[bridge] lead ${lead.id} entrou em modo mudo (humano respondeu pelo celular)`);
    } catch (err) {
      console.error('[bridge] erro setando modo mudo:', err.message);
    }
  }

  if (chatwootEnabled()) {
    try {
      const cw = await garantirLeadNoChatwoot({
        telefone, nome: lead.nome || nome,
        customAttrs: { empresa: lead.empresa || '' },
      });
      if (cw?.conversationId) {
        await espelharMensagemConversa({ conversationId: cw.conversationId, content: mensagem, direction: 'out' });
        await aplicarLabelsAditivo(cw.conversationId, ['humano-atendendo']);
      }
    } catch (err) {
      console.error('[bridge] erro espelhando humano no Chatwoot:', err.message);
    }
  }
}

async function processarBatch(items) {
  if (!items.length) return;
  const { telefone, nome, chatid } = items[0];
  const mensagemAgrupada = items.map(i => i.mensagem).join('\n');
  console.log(`[bridge] processando batch (telefone=${telefone} items=${items.length})`);

  let lead = supabaseEnabled() ? await buscarLeadPorTelefone(telefone) : null;
  if (!lead && supabaseEnabled()) {
    lead = await criarLead({ nome, telefone, origem: 'inbound' });
  }

  if (supabaseEnabled() && lead) {
    for (const it of items) {
      await gravarMensagem({
        lead_id: lead.id,
        chatid,
        direcao: 'in',
        autor: 'lead',
        texto: it.mensagem,
        modo_no_momento: lead.modo,
      });
    }
    try {
      await resetarCadenciaSeRespondeu(lead.id);
    } catch (err) {
      console.error('[bridge] erro resetando cadência:', err);
    }
  }

  let cwCtx = null;
  if (chatwootEnabled() && lead) {
    try {
      cwCtx = await garantirLeadNoChatwoot({
        telefone, nome: lead.nome || nome,
        customAttrs: { empresa: lead.empresa || '' },
      });
      if (cwCtx?.conversationId) {
        for (const it of items) {
          await espelharMensagemConversa({ conversationId: cwCtx.conversationId, content: it.mensagem, direction: 'in' });
        }
        await aplicarLabelsAditivo(cwCtx.conversationId, ['mql-respondeu']);
      }
    } catch (err) {
      console.error('[bridge] erro espelhando inbound no Chatwoot:', err.message);
    }
  }

  if (!deveResponder({ lead, autor: 'lead' })) {
    console.log(`[bridge] não responde (modo mudo ou sem lead) telefone=${telefone}`);
    return;
  }

  const historico = (supabaseEnabled() && lead)
    ? await ultimasMensagensDoLead(lead.id, 30)
    : [];

  const { resposta, tokensIn, tokensOut } = await gerarRespostaInbound({
    lead,
    historico,
    mensagemAtual: mensagemAgrupada,
  });

  if (!resposta) {
    console.log(`[bridge] SDK retornou resposta vazia, telefone=${telefone}`);
    return;
  }

  if (N8N_OUT_WEBHOOK_URL) {
    // Registra ANTES de enviar pra cobrir webhook que volta antes da response.
    registrarOutboundDoBridge({ telefone, conteudo: resposta });
    const payload = { telefone, resposta, lead_id: lead?.id ?? null, chatid, passo: null, modo_no_momento: lead?.modo ?? 'bot' };
    try {
      const r = await fetch(N8N_OUT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) console.error(`[bridge] WF-Lucio-OUT respondeu ${r.status}`);
    } catch (err) {
      console.error('[bridge] erro chamando WF-Lucio-OUT:', err);
    }
  } else {
    console.warn('[bridge] N8N_OUT_WEBHOOK_URL não configurada — resposta não saiu pro WhatsApp');
  }

  if (supabaseEnabled() && lead) {
    await gravarMensagem({
      lead_id: lead.id,
      chatid,
      direcao: 'out',
      autor: 'ia',
      texto: resposta,
      modo_no_momento: lead.modo,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    });
  }

  if (cwCtx?.conversationId) {
    try {
      await espelharMensagemConversa({ conversationId: cwCtx.conversationId, content: resposta, direction: 'out' });
    } catch (err) {
      console.error('[bridge] erro espelhando resposta Lúcio no Chatwoot:', err.message);
    }
  }

  console.log(`[bridge] respondeu telefone=${telefone} tokensIn=${tokensIn} tokensOut=${tokensOut}`);

  // Qualificador post-resposta: decide se vira MQL qualificado → handoff.
  // Pula se lead já está em handoff (modo=mudo) ou já foi qualificado.
  if (lead && lead.modo !== 'mudo' && lead.status !== 'qualificado' && lead.status !== 'handoff') {
    try {
      const historicoCompleto = supabaseEnabled()
        ? await ultimasMensagensDoLead(lead.id, 30)
        : historico;
      const q = await avaliarQualificacao({ lead, historico: historicoCompleto, ultimaRespostaLucio: resposta });
      if (q.qualified) {
        console.log(`[bridge] lead ${lead.id} qualificado → handoff (urgencia=${q.urgencia})`);
        await executarHandoff({ lead, qualificacao: q, chatwootCtx: cwCtx });
      }
    } catch (err) {
      console.error('[bridge] erro no qualifier:', err.message);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// /outbound-batch — chamado pelo agendador-claudio (cron 08h) ou manual.
// 1) puxa pendentes elegíveis 2) formula toque via Claude SDK
// 3) POST WF-Lucio-Outbound 4) marca enviado.
// Body opcional: { limite, dryRun }
// ──────────────────────────────────────────────────────────────────────────
const N8N_OUTBOUND_WEBHOOK_URL = process.env.N8N_OUTBOUND_WEBHOOK_URL;

async function processarOutboundBatch({ limite = 50, dryRun = false } = {}) {
  const pendentes = await puxarPendentes(limite);
  console.log(`[bridge] outbound-batch puxou ${pendentes.length} pendentes (dryRun=${dryRun})`);
  const resultados = [];
  for (const p of pendentes) {
    try {
      const historico = await ultimasMensagensDoLead(p.lead.id, 10);
      const { texto, tokensIn, tokensOut } = await formularToque({
        lead: p.lead,
        passo: p.passo,
        promptOrientacao: p.promptOrientacao,
        historico,
      });
      if (!texto) {
        resultados.push({ agendamentoId: p.agendamentoId, status: 'sem_texto' });
        continue;
      }
      if (dryRun) {
        resultados.push({ agendamentoId: p.agendamentoId, status: 'dry', texto });
        continue;
      }

      let uazapiCampaignId = null;
      if (N8N_OUTBOUND_WEBHOOK_URL) {
        registrarOutboundDoBridge({ telefone: p.lead.telefone, conteudo: texto });
        const r = await fetch(N8N_OUTBOUND_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            telefone: p.lead.telefone,
            nome: p.lead.nome,
            empresa: p.lead.empresa,
            mensagem: texto,
            lead_id: p.lead.id,
            passo: p.passo,
            agendamento_id: p.agendamentoId,
          }),
        });
        if (!r.ok) {
          console.error(`[bridge] WF-Lucio-Outbound respondeu ${r.status}`);
          resultados.push({ agendamentoId: p.agendamentoId, status: 'falha_n8n', http: r.status });
          continue;
        }
        try {
          const j = await r.json();
          uazapiCampaignId = j?.campaignId || j?.campanha_uazapi_id || null;
        } catch { /* sem corpo, ok */ }
      } else {
        console.warn('[bridge] N8N_OUTBOUND_WEBHOOK_URL não configurada — registrando enviado mesmo assim em modo local');
      }

      await marcarEnviado(p.agendamentoId, {
        texto, leadId: p.lead.id, passo: p.passo,
        uazapiCampaignId, tokensIn, tokensOut,
      });

      if (chatwootEnabled()) {
        try {
          const cw = await garantirLeadNoChatwoot({
            telefone: p.lead.telefone,
            nome: p.lead.nome,
            customAttrs: {
              empresa: p.lead.empresa || '',
              setor: p.lead.segmento || '',
              cadencia: p.lead.cadencia_id || '',
            },
          });
          if (cw?.conversationId) {
            await espelharMensagemConversa({ conversationId: cw.conversationId, content: texto, direction: 'out' });
            const label = p.passo === 1 ? 'mql-em-cadencia' : 'mql-em-cadencia';
            await aplicarLabelsAditivo(cw.conversationId, [label]);
          }
        } catch (err) {
          console.error(`[bridge] erro espelhando outbound ${p.agendamentoId} no Chatwoot:`, err.message);
        }
      }

      resultados.push({ agendamentoId: p.agendamentoId, status: 'enviado', leadId: p.lead.id, passo: p.passo });
    } catch (err) {
      console.error(`[bridge] erro em agendamento ${p.agendamentoId}:`, err);
      resultados.push({ agendamentoId: p.agendamentoId, status: 'erro', erro: err.message });
    }
  }
  return { total: pendentes.length, resultados };
}

app.post('/outbound-batch', async (req, res) => {
  if (!supabaseEnabled()) {
    return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  }
  const limite = parseInt(req.body?.limite ?? '50', 10);
  const dryRun = req.body?.dryRun === true;
  const out = await processarOutboundBatch({ limite, dryRun });
  res.json({ ok: true, ...out });
});

// Scheduler interno (modo teste). Liga com OUTBOUND_TICK_SECONDS=N (>0) no .env.
// Em produção, usar agendador externo (cron remoto) e deixar OUTBOUND_TICK_SECONDS=0.
const TICK = parseInt(process.env.OUTBOUND_TICK_SECONDS || '0', 10);
if (TICK > 0) {
  let rodando = false;
  setInterval(async () => {
    if (rodando) return;
    rodando = true;
    try {
      const out = await processarOutboundBatch({ limite: 50, dryRun: false });
      if (out.total > 0) console.log(`[bridge] tick: enviou ${out.resultados.filter(r => r.status === 'enviado').length}/${out.total}`);
    } catch (err) {
      console.error('[bridge] erro no tick scheduler:', err);
    } finally {
      rodando = false;
    }
  }, TICK * 1000);
  console.log(`[bridge] scheduler interno ligado (tick=${TICK}s)`);
}

// Watchdog de handoff abandonado: a cada WATCHDOG_TICK_SECONDS varre leads em mudo
// cuja última msg do lead está parada há > WATCHDOG_HANDOFF_TIMEOUT_MIN minutos.
const WATCHDOG_TICK = parseInt(process.env.WATCHDOG_TICK_SECONDS || '300', 10);
if (WATCHDOG_TICK > 0) {
  let rodando = false;
  setInterval(async () => {
    if (rodando) return;
    rodando = true;
    try {
      const out = await revisarHandoffsAbandonados();
      if (out?.processados > 0) console.log(`[bridge] watchdog: ${out.processados} lead(s) retomado(s)`);
    } catch (err) {
      console.error('[bridge] erro no watchdog:', err);
    } finally {
      rodando = false;
    }
  }, WATCHDOG_TICK * 1000);
  console.log(`[bridge] watchdog handoff ligado (tick=${WATCHDOG_TICK}s, timeout=${process.env.WATCHDOG_HANDOFF_TIMEOUT_MIN || 60}min)`);
}

// ──────────────────────────────────────────────────────────────────────────
// /handoff-return — webhook do Chatwoot quando label `devolver-lucio` é aplicada.
// Body: { lead_id } ou { telefone }.
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// /chatwoot-webhook — Chatwoot dispara aqui quando msg é criada na conta.
// Filtra: só outgoing, não-privada, de agente humano (não bot Lúcio).
// Pega telefone do contato, dispara via uazapi (chip Luminus) e grava no Supabase
// como autor=humano (também garante que lead.modo='mudo' pra Lúcio não interferir).
// ──────────────────────────────────────────────────────────────────────────
const CHATWOOT_WEBHOOK_SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || '';

function verificarHmacChatwoot(req, rawBody) {
  if (!CHATWOOT_WEBHOOK_SECRET) return true; // opcional
  const recv = req.headers['x-chatwoot-hmac-sha256'];
  if (!recv) return false;
  const calc = crypto.createHmac('sha256', CHATWOOT_WEBHOOK_SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(recv), Buffer.from(calc)); } catch { return false; }
}

app.post('/chatwoot-webhook', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  limit: '5mb',
}), async (req, res) => {
  res.json({ ok: true }); // responde rápido — processa async

  try {
    if (!verificarHmacChatwoot(req, req.rawBody || '')) {
      console.warn('[bridge] HMAC do Chatwoot inválido');
      return;
    }

    const ev = req.body || {};
    const eventName = ev.event;

    // conversation_updated: Chatwoot dispara quando labels mudam.
    // Se a label `devolver-lucio` está presente → devolve lead pro bot.
    if (eventName === 'conversation_updated') {
      const labels = ev.labels || ev.conversation?.labels || ev.messages?.[0]?.conversation?.labels || [];
      if (!Array.isArray(labels) || !labels.includes('devolver-lucio')) return;
      const telefone = ev.meta?.sender?.phone_number
        || ev.contact_inbox?.contact?.phone_number
        || ev.messages?.[0]?.conversation?.meta?.sender?.phone_number
        || ev.conversation?.meta?.sender?.phone_number;
      if (!telefone) {
        console.warn('[bridge] conversation_updated com label devolver-lucio mas sem telefone identificável');
        return;
      }
      const convId = ev.id || ev.conversation?.id;
      try {
        const lead = await buscarLeadPorTelefone(telefone);
        if (!lead) { console.warn(`[bridge] devolver-lucio: lead não encontrado tel=${telefone}`); return; }
        let nota;
        if (lead.modo === 'bot') {
          console.log(`[bridge] devolver-lucio: lead ${lead.id} já está em bot — nada a fazer`);
          nota = `ℹ️ Lead já estava com o Lúcio. Label removida.`;
        } else {
          await devolverPraBot(lead.id);
          console.log(`[bridge] devolver-lucio: lead ${lead.id} voltou pra bot`);
          const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          nota = `✅ Lúcio retomou o atendimento às ${hora}.`;
        }
        try {
          if (convId) {
            await removerLabels(convId, ['devolver-lucio', 'humano-atendendo']);
            await addNotaPrivada(convId, nota);
          }
        } catch (err) { console.error('[bridge] erro escrevendo feedback de devolução:', err.message); }
      } catch (err) {
        console.error('[bridge] erro processando devolver-lucio:', err.message);
        try { if (convId) await addNotaPrivada(convId, `⚠️ Falha ao devolver pro Lúcio: ${err.message}`); } catch {}
      }
      return;
    }

    if (eventName !== 'message_created') return;
    if (ev.message_type !== 'outgoing') return;

    // Anti-loop: se foi o próprio bridge que espelhou essa msg (público ou
    // nota privada de handoff), Chatwoot redispara o webhook — ignora.
    const msgId = ev.id || ev.message?.id;
    const matched = foiEspelhadoPeloBridge(msgId);
    console.log(`[bridge] chatwoot-webhook msg outgoing id=${msgId} mirror_match=${matched} keys=${Object.keys(ev).join(',')}`);
    if (matched) {
      console.log(`[bridge] chatwoot-webhook ignora msg id=${msgId} (espelho do próprio bridge)`);
      return;
    }

    // Nota privada do closer humano: grava no Supabase como autor='nota_interna'.
    // Lúcio vai ler quando voltar a responder (após devolver-lucio).
    // NÃO envia via uazapi, não muda modo do lead.
    if (ev.private === true) {
      const telefoneNota = ev.conversation?.meta?.sender?.phone_number
        || ev.contact?.phone_number
        || ev.conversation?.contact_inbox?.source_id;
      const textoNota = ev.content || '';
      if (!telefoneNota || !textoNota) return;
      if (supabaseEnabled()) {
        try {
          const lead = await buscarLeadPorTelefone(telefoneNota);
          if (lead) {
            await gravarMensagem({
              lead_id: lead.id, chatid: null, direcao: 'nota',
              autor: 'nota_interna', texto: textoNota, modo_no_momento: lead.modo,
            });
            console.log(`[bridge] nota interna gravada lead=${lead.id} (${textoNota.length} chars)`);
          }
        } catch (err) {
          console.error('[bridge] erro gravando nota interna:', err.message);
        }
      }
      return;
    }

    // sender pode vir como ev.sender = { type: 'user', name: ... }; bot/automation = type 'agent_bot'
    const senderType = ev.sender?.type;
    if (senderType && !['user', 'User', 'AgentBot'].includes(senderType) && senderType !== 'agent') {
      console.log(`[bridge] chatwoot-webhook ignora sender.type=${senderType}`);
      return;
    }

    const telefone = ev.conversation?.meta?.sender?.phone_number
      || ev.contact?.phone_number
      || ev.conversation?.contact_inbox?.source_id;
    const conteudo = ev.content || '';
    if (!telefone || !conteudo) {
      console.warn('[bridge] chatwoot-webhook sem telefone/conteúdo:', { telefone, len: conteudo.length });
      return;
    }

    // Cinto de segurança independente do ID: se o bridge ENVIOU esse conteúdo
    // pra esse telefone nos últimos 90s, o webhook é eco — não reenvia.
    if (jaEnviadoPeloBridge({ telefone, conteudo })) {
      console.log(`[bridge] chatwoot-webhook ignora eco por (telefone+conteúdo) id=${msgId} tel=${telefone}`);
      return;
    }

    // Dispara via uazapi
    if (!uazapiEnabled()) {
      console.error('[bridge] uazapi desabilitada — msg do closer não saiu');
      return;
    }
    try {
      const r = await enviarTextoImediato({ telefone, texto: conteudo });
      console.log(`[bridge] msg do closer enviada via uazapi (folder=${r.folderId}) telefone=${telefone}`);
    } catch (err) {
      console.error('[bridge] uazapi falhou:', err.message);
      return;
    }

    // Grava no Supabase + garante modo=mudo
    if (supabaseEnabled()) {
      try {
        let lead = await buscarLeadPorTelefone(telefone);
        if (!lead) lead = await criarLead({ nome: ev.conversation?.meta?.sender?.name, telefone, origem: 'chatwoot-closer' });
        await gravarMensagem({
          lead_id: lead.id,
          chatid: null,
          direcao: 'out',
          autor: 'humano',
          texto: conteudo,
          modo_no_momento: lead.modo,
        });
        if (lead.modo !== 'mudo') {
          await atualizarLead(lead.id, { modo: 'mudo', status: 'handoff' });
          await registrarEvento(lead.id, 'handoff_humano_chatwoot', { agente: ev.sender?.name || ev.sender?.email || null });
          console.log(`[bridge] lead ${lead.id} entrou em modo mudo (closer via Chatwoot)`);
        }
      } catch (err) {
        console.error('[bridge] erro gravando msg do closer:', err.message);
      }
    }

    // Coerência com o caminho "humano respondeu pelo celular": aplica a
    // mesma label `humano-atendendo` quando o closer responde pelo Chatwoot.
    // Pipeline (custom view "MQL · 3 · Respondeu" / etc) reflete que tem
    // humano dentro da conversa, e o watchdog usa essa label como sinal.
    const convId = ev.conversation?.id;
    if (convId) {
      try {
        await aplicarLabelsAditivo(convId, ['humano-atendendo']);
      } catch (err) {
        console.error('[bridge] erro aplicando label humano-atendendo:', err.message);
      }
    }
  } catch (err) {
    console.error('[bridge] erro em /chatwoot-webhook:', err);
  }
});

app.post('/handoff-return', async (req, res) => {
  const { lead_id, telefone } = req.body || {};
  try {
    let id = lead_id, tel = telefone;
    if (!id && telefone && supabaseEnabled()) {
      const lead = await buscarLeadPorTelefone(telefone);
      id = lead?.id;
      tel = tel || lead?.telefone;
    } else if (id && !tel && supabaseEnabled()) {
      // fallback: tenta achar telefone pelo id (não tem busca direta, ignora se não der)
    }
    if (!id) return res.status(400).json({ ok: false, erro: 'lead_id ou telefone necessário' });
    if (supabaseEnabled()) await devolverPraBot(id);
    if (chatwootEnabled() && tel) {
      try {
        const cw = await garantirLeadNoChatwoot({ telefone: tel, nome: '', customAttrs: {} });
        if (cw?.conversationId) {
          await removerLabels(cw.conversationId, ['humano-atendendo', 'mql-qualificado']);
          await aplicarLabelsAditivo(cw.conversationId, ['mql-em-cadencia']);
        }
      } catch (err) {
        console.error('[bridge] erro limpando labels handoff-return:', err.message);
      }
    }
    res.json({ ok: true, lead_id: id, modo: 'bot' });
  } catch (err) {
    console.error('[bridge] erro em /handoff-return:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[lucio-bridge] escutando em http://localhost:${PORT}`);
  console.log(`  supabase=${supabaseEnabled()} chatwoot=${chatwootEnabled()} n8n_out=${!!N8N_OUT_WEBHOOK_URL} buffer=${bufferEnabled() ? bufferSeconds()+'s' : 'off'}`);
});
