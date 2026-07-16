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
  getOutboundEstado,
  setOutboundEstado,
  listarMensagensEnviadas,
  espelharNotaNoCrm,
  encerrarLead,
  variantesTelefone,
  mensagemNossaComMessageId,
} from './supabase-client.js';
import { chaveTelefone } from './telefone.js';
import { deveResponder, executarHandoff } from './handoff.js';
import { gerarRespostaInbound, pareceVazamentoInterno, detectarSinalUra } from './lucio-agent.js';
import { avaliarQualificacao } from './qualifier.js';
import { classificarSqlSeAplicavel, normalizarLabelsSqlSeNecessario } from './sql-classifier.js';
import {
  chatwootEnabled,
  garantirLeadNoChatwoot,
  espelharMensagemConversa,
  aplicarLabelsAditivo,
  marcarRespondeuSeTriagem,
  removerLabels,
  foiEspelhadoPeloBridge,
  addNotaPrivada,
  registrarOutboundDoBridge,
  esquecerOutboundDoBridge,
  jaEnviadoPeloBridge,
  atribuirAgente,
  CLOSER_MAP,
} from './chatwoot-client.js';
import { crmEnabled } from './crm-client.js';
import { enfileirarMensagem, bufferSeconds, bufferEnabled } from './buffer.js';
import { revisarHandoffsAbandonados } from './watchdog.js';
import {
  puxarPendentes,
  formularToque,
  marcarEnviado,
  incrementarTentativa,
  marcarFalha,
  resetarCadenciaSeRespondeu,
} from './cadence-engine.js';
import { enviarTextoImediato, iaSolutionEnabled, baixarMidia, JanelaExpiradaError } from './iasolution-client.js';
import { transcreverAudio, transcricaoEnabled } from './transcricao.js';
import crypto from 'node:crypto';
import { montarMetricas, listarCadenciasParaSeletor } from './metrics.js';
import { resolverJanela } from './periodo.js';
import { getSnapshotTrafego, getFunilBruno, getBrunoDashboard, getSlaAlertas } from './dashboard-tabs.js';
import { iniciarColetaAutomatica } from './trafego-coletor.js';
import { listarTemperaturas } from './temperatura-analyzer.js';
import { construirEmailPayload, enviarEmailResend } from './resend-client.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
// Guarda o corpo cru: validar HMAC exige os bytes exatos que o provedor assinou,
// e depois do parse eles não existem mais. Precisa ser AQUI, no parser global —
// um express.json() por rota não reparseia (body-parser marca req._body e sai),
// então o `verify` dele nunca rodaria e o rawBody chegaria vazio.
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

const PORT = parseInt(process.env.PORT || '8788', 10);

// ──────────────────────────────────────────────────────────────────────────
// Dashboard (F6) — endpoint JSON + página estática.
// Auth: HTTP Basic. Browser pede usuário/senha nativo no primeiro acesso e
// cacheia até fechar a aba. Credenciais em DASHBOARD_USER/DASHBOARD_PASSWORD.
// ──────────────────────────────────────────────────────────────────────────
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function checarBasicAuth(req) {
  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) return { ok: false, reason: 'auth-nao-configurada' };
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return { ok: false, reason: 'sem-header' };
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch { return { ok: false, reason: 'base64-invalido' }; }
  const i = decoded.indexOf(':');
  if (i < 0) return { ok: false, reason: 'formato-invalido' };
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  // timingSafeEqual exige buffers do mesmo tamanho — comparamos os hashes.
  const expectedU = crypto.createHash('sha256').update(DASHBOARD_USER).digest();
  const expectedP = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest();
  const gotU = crypto.createHash('sha256').update(user).digest();
  const gotP = crypto.createHash('sha256').update(pass).digest();
  if (!crypto.timingSafeEqual(expectedU, gotU)) return { ok: false, reason: 'user-invalido' };
  if (!crypto.timingSafeEqual(expectedP, gotP)) return { ok: false, reason: 'pass-invalida' };
  return { ok: true };
}

function exigirAuth(req, res, next) {
  const r = checarBasicAuth(req);
  if (r.ok) return next();
  res.set('WWW-Authenticate', 'Basic realm="Lucio Dashboard", charset="UTF-8"');
  return res.status(401).send('Autenticação requerida.');
}

app.get('/dashboard', exigirAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.get('/api/metrics', exigirAuth, async (req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  const periodo = req.query.periodo || '7d';
  const de = req.query.de || null;
  const ate = req.query.ate || null;
  const cadenciaId = req.query.cadencia ? parseInt(req.query.cadencia, 10) : null;
  try {
    const m = await montarMetricas({ periodo, de, ate, cadenciaId });
    res.json({ ok: true, ...m });
  } catch (err) {
    console.error('[bridge] erro /api/metrics:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/api/cadencias', exigirAuth, async (req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  try {
    const lista = await listarCadenciasParaSeletor();
    res.json({ ok: true, cadencias: lista });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/api/mensagens', exigirAuth, async (req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  const cadenciaId = req.query.cadencia ? parseInt(req.query.cadencia, 10) : null;
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
  const janela = resolverJanela({ periodo: req.query.periodo || '7d', de: req.query.de, ate: req.query.ate });
  try {
    const mensagens = await listarMensagensEnviadas({ desde: janela.desde, ate: janela.ate, cadenciaId, limit });
    res.json({ ok: true, mensagens });
  } catch (err) {
    console.error('[bridge] erro /api/mensagens:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Estado global do envio outbound: ler e alterar (pausar/retomar/encerrar).
app.get('/api/outbound-estado', exigirAuth, async (_req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  try {
    const e = await getOutboundEstado();
    res.json({ ok: true, ...e });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/api/outbound-estado', exigirAuth, async (req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  const acao = req.body?.acao;
  const mapa = { pausar: 'pausado', retomar: 'ativo', encerrar: 'encerrado' };
  const estado = mapa[acao];
  if (!estado) return res.status(400).json({ ok: false, erro: 'acao inválida (pausar|retomar|encerrar)' });
  try {
    const e = await setOutboundEstado(estado, 'dashboard');
    console.log(`[bridge] outbound ${acao} → estado=${estado} (via dashboard)`);
    res.json({ ok: true, ...e });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Aba Tráfego: snapshot mais recente da Meta (tabela trafego_snapshots) ──
// snapshot:null => "sem dado ainda" (estado, não erro). Erro de fonte => 500.
app.get('/api/trafego', exigirAuth, async (req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  const janela = resolverJanela({ periodo: req.query.periodo || '7d', de: req.query.de, ate: req.query.ate });
  try {
    const snapshot = await getSnapshotTrafego({ desde: janela.desde, ate: janela.ate });
    res.json({ ok: true, snapshot, janela });
  } catch (err) {
    console.error('[bridge] erro /api/trafego:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Card SLA: leads qualificados que estouraram 2h e viraram lembrete ──
// Conta sla_alertas (espelho da datatable n8n) por hoje / 7d / total.
app.get('/api/sla', exigirAuth, async (_req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  try {
    const sla = await getSlaAlertas();
    res.json({ ok: true, sla });
  } catch (err) {
    console.error('[bridge] erro /api/sla:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Aba Bruno: funil inbound + atividade recente (tabelas bruno_*) ──
app.get('/api/bruno', exigirAuth, async (req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  const janela = resolverJanela({ periodo: req.query.periodo || '7d', de: req.query.de, ate: req.query.ate });
  try {
    const [funil, painel] = await Promise.all([
      getFunilBruno({ desde: janela.desde, ate: janela.ate }),
      getBrunoDashboard({ desde: janela.desde, ate: janela.ate }),
    ]);
    res.json({ ok: true, funil, ...painel });
  } catch (err) {
    console.error('[bridge] erro /api/bruno:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Aba Temperatura: leads ordenados por score (mais quente no topo) ──
// Read-only: lê a última análise persistida por lead (eventos tipo=lead_temperatura)
// e devolve ordenado por score desc. NUNCA dispara análise (isso é on-demand via
// scripts/analisar-temperatura.js, 1 lead por vez, fora do request HTTP).
app.get('/api/leads-temperatura', exigirAuth, async (_req, res) => {
  if (!supabaseEnabled()) return res.status(503).json({ ok: false, erro: 'supabase desconfigurado' });
  try {
    const leads = await listarTemperaturas();
    res.json({ ok: true, leads });
  } catch (err) {
    console.error('[bridge] erro /api/leads-temperatura:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    bridge: 'lucio',
    supabase: supabaseEnabled(),
    chatwoot: chatwootEnabled(),
    crm: crmEnabled(),
    // Sem transporte o Lúcio fica mudo sem erro aparente, e o .env do repo NÃO
    // vai pro container (as vars vêm do painel). Expor aqui deixa o deploy
    // verificável de fora, sem precisar abrir log.
    whatsapp_oficial: iaSolutionEnabled(),
    transcricao: transcricaoEnabled(),
    webhook_protegido: !!IASOLUTION_WEBHOOK_SECRET,
    allowlist_teste: IASOLUTION_ALLOWLIST.length || 0,
    build: 'iasolution-inbound',
    bufferSeconds: bufferEnabled() ? bufferSeconds() : 0,
    model: process.env.LUCIO_MODEL || 'claude-haiku-4-5-20251001',
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /in — entrada normalizada de mensagem do WhatsApp.
// Body: { telefone, nome, mensagem, chatid, timestamp, autor }
//
// Continua exposto pra teste manual (scripts/simular-conversa.js) e como
// contrato interno: o webhook da API oficial abaixo faz o parse e cai aqui.
//
// Estratégia: responde 200 imediato (evita timeout do provedor) e processa
// a mensagem assíncrono. Mensagens autor=lead passam por buffer (agrupa
// rajadas em uma única chamada Claude). Mensagens autor=humano só gravam.
// ──────────────────────────────────────────────────────────────────────────
app.post('/in', async (req, res) => {
  const { telefone, mensagem, autor } = req.body || {};
  if (!telefone || !mensagem || !autor) {
    return res.status(400).json({ ok: false, erro: 'telefone, mensagem e autor são obrigatórios' });
  }

  res.json({ ok: true, recebido: true });
  rotearEntrada(req.body);
});

// Decide o destino de uma mensagem já normalizada. Fire-and-forget: quem chama
// já respondeu 200 pro provedor.
function rotearEntrada({ telefone, nome, mensagem, chatid, timestamp, autor }) {
  if (autor === 'humano') {
    Promise.resolve(gravarHumano({ telefone, nome, mensagem, chatid }))
      .catch(err => console.error('[bridge] erro humano:', err));
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
}

// ──────────────────────────────────────────────────────────────────────────
// /webhook/iasolution — entrada da API oficial (Meta Cloud API via iaSolution).
// Portado do WF-Lucio-IN-iaSolution: o bridge recebe o webhook direto, sem n8n.
//
// Allowlist (IASOLUTION_ALLOWLIST, CSV): filtro de teste. VAZIA = passa todo
// mundo, que é o estado de produção. Preencher só enquanto valida E2E.
// ──────────────────────────────────────────────────────────────────────────
const IASOLUTION_ALLOWLIST = (process.env.IASOLUTION_ALLOWLIST || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function permitidoPelaAllowlist(telefone) {
  if (!IASOLUTION_ALLOWLIST.length) return true;
  // Casa as duas formas do celular BR (com e sem o 9º dígito) — senão o número
  // de teste entra por uma forma e é barrado na outra.
  const variantes = new Set(variantesTelefone(telefone).map(v => String(v).replace(/\D/g, '')));
  return IASOLUTION_ALLOWLIST.some(a => variantes.has(a.replace(/\D/g, '')));
}

// Número do próprio canal (o WhatsApp da Luminus), E.164 sem +. Serve de trava:
// nenhum evento cujo remetente seja a gente mesmo pode virar lead ou fala de
// humano. Protege contra envelope em que o eco traz `from` = número do negócio.
const IASOLUTION_NUMERO_NEGOCIO = String(process.env.IASOLUTION_NUMERO_NEGOCIO || '').replace(/\D/g, '');

// Secret do webhook. Vazio = endpoint aberto (o n8n era o front door antes).
//
// A iaSolution assina o payload com HMAC SHA-256 e manda em X-Hub-Signature-256
// (padrão Meta), no formato `sha256=<hex>`. Não existe header customizado no
// painel dela — então é assinatura ou nada. Mesmo esquema do /chatwoot-webhook.
const IASOLUTION_WEBHOOK_SECRET = process.env.IASOLUTION_WEBHOOK_SECRET || '';

function assinaturaConfere(req, rawBody) {
  if (!IASOLUTION_WEBHOOK_SECRET) return true;
  const recebido = String(req.get('x-hub-signature-256') || '');
  if (!recebido) return false;
  const calculado = 'sha256=' + crypto
    .createHmac('sha256', IASOLUTION_WEBHOOK_SECRET)
    .update(rawBody || '')
    .digest('hex');
  // timingSafeEqual exige mesmo tamanho: compara hash dos dois lados.
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(calculado).digest();
  return crypto.timingSafeEqual(a, b);
}

// Acha o contato correspondente à mensagem. Num lote com leads diferentes,
// assumir contacts[0] pra todas atribuiria a mensagem ao lead errado (nome
// trocado no inbound; no eco, mudo no lead errado).
function contatoDaMensagem(m, contatos) {
  if (!contatos.length) return {};
  if (contatos.length === 1) return contatos[0];
  const alvos = [m?.from, m?.to, m?.recipient_id].filter(Boolean).map(t => chaveTelefone(t));
  return contatos.find(c => c?.wa_id && alvos.includes(chaveTelefone(c.wa_id))) || contatos[0];
}

// Parse de UMA mensagem do payload Meta Cloud API. Devolve null pro que não dá
// pra rotear.
function parseMensagemIaSolution(m, contato) {
  // Num eco outbound o envelope da Meta traz `from` = número do NEGÓCIO e o
  // interlocutor em `to`/`recipient_id`. Envelope normalizado por BSP costuma
  // trazer `from` = lead nos dois sentidos. `to`/`recipient_id` são explícitos
  // sobre quem é o destinatário, então valem mais que o contacts[] pareado.
  const ehEco = (m.direction || 'inbound') !== 'inbound';
  const telefone = String(
    (ehEco ? (m.to || m.recipient_id || contato.wa_id || m.from) : (m.from || contato.wa_id)) || ''
  );
  if (!telefone) return null;

  const tipo = m.type || 'text';
  let texto = '';
  if (tipo === 'text') texto = m.text?.body || m.normalized_text || '';
  else if (m.normalized_text) texto = m.normalized_text;
  else if (tipo !== 'audio') texto = m.caption || `[${tipo} recebido]`;

  return {
    telefone,
    nome: contato.profile?.name || '',
    chatid: telefone,
    mensagem: texto,
    tipo,
    messageId: m.id || '',
    audioId: tipo === 'audio' ? (m.audio?.id || '') : '',
    // O webhook entrega a url de download já montada (é o caminho que a doc
    // recomenda); o id fica de reserva pra montar o /media/{id}/download.
    downloadUrl: m.download_url || '',
    timestamp: String(m.timestamp || ''),
    // Na coexistência, o eco do celular do dono chega como outbound → é o humano
    // atendendo pelo aparelho, mesmo sinal do antigo fromMeYes+wasNotSentByApi.
    autor: ehEco ? 'humano' : 'lead',
  };
}

app.post('/webhook/iasolution', async (req, res) => {
  if (!assinaturaConfere(req, req.rawBody)) {
    console.warn('[bridge] iasolution: webhook com assinatura HMAC inválida — rejeitado');
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });

  const body = req.body || {};
  try {
    // Ping de validação e evento só-de-status não são mensagem: saem quietos.
    if (body.test === true || Array.isArray(body.statuses)) return;

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      // Modo de falha mais provável do dia 1: envelope diferente do esperado
      // (a Cloud API crua aninha em entry[].changes[].value). Sem este log, o
      // inbound inteiro morre em silêncio com 200 OK.
      console.warn(`[bridge] iasolution: payload sem messages[] na raiz — chaves=${Object.keys(body).join(',') || '(vazio)'}`);
      return;
    }

    const contatos = Array.isArray(body.contacts) ? body.contacts : [];
    // A Meta batcheia: processar só a [0] perderia mensagem sem deixar rastro.
    for (const m of body.messages) {
      // Uma falha numa mensagem não pode descartar as outras do lote.
      try {
        await processarMensagemIaSolution(m, contatoDaMensagem(m, contatos));
      } catch (err) {
        console.error(`[bridge] iasolution: erro processando msg id=${m?.id || '-'}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[bridge] erro no webhook iasolution:', err.message);
  }
});

async function processarMensagemIaSolution(m, contato) {
  const evento = parseMensagemIaSolution(m || {}, contato || {});
  if (!evento) return;

  if (IASOLUTION_NUMERO_NEGOCIO && chaveTelefone(evento.telefone) === chaveTelefone(IASOLUTION_NUMERO_NEGOCIO)) {
    console.warn(`[bridge] iasolution: evento com remetente = nosso próprio número (${evento.telefone}) — ignorado. Confira o mapeamento de from/to do envelope.`);
    return;
  }

  if (!permitidoPelaAllowlist(evento.telefone)) {
    console.log(`[bridge] iasolution: ${evento.telefone} fora da allowlist de teste — ignorado`);
    return;
  }

  // Anti-loop, duas camadas. A API oficial ecoa o que sai por ela, e tratar o
  // eco como fala de humano colocaria o Lúcio em modo mudo sozinho — falha
  // silenciosa e cara de diagnosticar.
  if (evento.autor === 'humano') {
    // 1) Por id da mensagem: sobrevive a restart de deploy e a réplica extra.
    if (evento.messageId && supabaseEnabled() && await mensagemNossaComMessageId(evento.messageId)) {
      console.log(`[bridge] iasolution: eco do próprio bridge ignorado por message_id=${evento.messageId}`);
      return;
    }
    // 2) Por (telefone + conteúdo): cobre o envio que ainda não foi gravado.
    if (jaEnviadoPeloBridge({ telefone: evento.telefone, conteudo: evento.mensagem, canal: 'whatsapp' })) {
      console.log(`[bridge] iasolution: eco do próprio bridge ignorado tel=${evento.telefone}`);
      return;
    }
  }

  if (evento.tipo === 'audio') evento.mensagem = await transcreverPtt(evento);
  if (!evento.mensagem) {
    console.warn(`[bridge] iasolution: mensagem vazia (tipo=${evento.tipo}) tel=${evento.telefone} — ignorada`);
    return;
  }

  rotearEntrada(evento);
}

// Baixa e transcreve o PTT. Nunca lança: áudio que não transcreve vira aviso
// pro Lúcio pedir texto, o que é melhor do que a conversa morrer em silêncio.
async function transcreverPtt({ audioId, downloadUrl }) {
  const FALLBACK = '[o lead mandou um áudio que não consegui ouvir]';
  if (!transcricaoEnabled()) {
    console.warn('[bridge] GROQ_API_KEY ausente — áudio não transcrito');
    return FALLBACK;
  }
  try {
    const { buffer, mimeType } = await baixarMidia({ mediaId: audioId, downloadUrl });
    const texto = await transcreverAudio({ buffer, mimeType });
    if (!texto) return FALLBACK;
    console.log(`[bridge] áudio transcrito (${texto.length} chars)`);
    return texto;
  } catch (err) {
    console.error('[bridge] falha transcrevendo áudio:', err.message);
    return FALLBACK;
  }
}

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
        // F5: classificador SQL contínuo — fire and forget
        classificarSqlSeAplicavel({ lead, conversationId: cw.conversationId })
          .catch(err => console.error('[bridge] erro sql-classifier (lead mudo):', err.message));
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

  // Número já identificado como central automática / URA: a mensagem fica
  // registrada no Supabase (acima), mas o Lúcio não espelha, não chama o LLM e
  // não responde — qualquer texto só realimentaria o loop do bot do outro lado.
  if (lead?.status === 'encerrado' && lead?.motivo_encerramento === 'central_automatica') {
    console.log(`[bridge] lead ${lead.id} é central automática — não responde telefone=${telefone}`);
    return;
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
        const r = await marcarRespondeuSeTriagem(cwCtx.conversationId);
        if (r?.skipped) {
          console.log(`[bridge] mql-respondeu não aplicada convId=${cwCtx.conversationId} motivo=${r.reason}`);
        } else if (lead?.id) {
          // Aplicou a label de fato — registra transição pro dashboard
          const { registrarTransicao } = await import('./supabase-client.js');
          registrarTransicao(lead.id, 'em-cadencia', 'mql-respondeu', 'auto').catch(err =>
            console.error('[bridge] erro registrando transição mql-respondeu:', err.message));
        }
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

  // Central automática / URA: o agente emitiu o token interno em vez de uma
  // resposta de venda. NÃO envia nada pro WhatsApp — só anota e descarta.
  const sinalUra = detectarSinalUra(resposta);
  if (sinalUra.ura) {
    await tratarCentralAutomatica({ lead, telefone, cwCtx, justificativa: sinalUra.justificativa, conteudoRecebido: mensagemAgrupada });
    return;
  }

  // Rede de segurança: nunca deixar narração de estado interno chegar ao lead.
  if (pareceVazamentoInterno(resposta)) {
    console.error(`[bridge] BLOQUEADO: resposta parece estado interno, NÃO enviada ao lead=${lead?.id} telefone=${telefone} :: "${resposta.slice(0, 200)}"`);
    if (supabaseEnabled() && lead) {
      try { await registrarEvento(lead.id, 'resposta_bloqueada_vazamento', { trecho: resposta.slice(0, 300) }); } catch (e) { /* não falha o fluxo */ }
    }
    return;
  }

  let messageId = null;
  // Só grava/espelha o que o lead realmente recebeu. Gravar uma fala não
  // entregue faria o histórico do próximo prompt afirmar que o Lúcio já disse
  // aquilo, e o closer veria no Chatwoot uma mensagem que nunca chegou.
  // A qualificação lá embaixo NÃO depende disso: ela julga o que o LEAD disse.
  let entregue = true;
  if (iaSolutionEnabled()) {
    // Registra ANTES de enviar pra cobrir eco que volta antes da response.
    // Sai pela API oficial E é espelhada no Chatwoot: eco pelos dois lados.
    registrarOutboundDoBridge({ telefone, conteudo: resposta, canais: ['whatsapp', 'chatwoot'] });
    try {
      const r = await enviarTextoImediato({ telefone, texto: resposta });
      messageId = r.messageId;
      console.log(`[bridge] resposta enviada (msg=${messageId}) telefone=${telefone}`);
    } catch (err) {
      entregue = false;
      // Sem envio não há eco: solta a marca pra não bloquear um reenvio igual.
      esquecerOutboundDoBridge({ telefone, conteudo: resposta });
      // Janela de 24h: o lead escreveu, então ela deveria estar aberta. Se
      // estourou, é sinal de relógio/estado divergente — vira evento pra
      // aparecer no diagnóstico em vez de sumir no log.
      if (err instanceof JanelaExpiradaError) {
        console.error(`[bridge] janela de 24h fechada respondendo lead ${lead?.id}: ${err.message}`);
        if (supabaseEnabled() && lead) {
          await registrarEvento(lead.id, 'envio_bloqueado_janela', { origem: 'inbound', detalhe: err.message }).catch(() => {});
        }
      } else {
        console.error('[bridge] erro enviando resposta pela iaSolution:', err.message);
        if (supabaseEnabled() && lead) {
          await registrarEvento(lead.id, 'envio_falhou', { origem: 'inbound', detalhe: err.message?.slice(0, 300) }).catch(() => {});
        }
      }
    }
  } else {
    // Sem transporte (dev/simulação): segue gravando pra conversa local fluir.
    console.warn('[bridge] iaSolution não configurada — resposta não saiu pro WhatsApp');
  }

  if (entregue && supabaseEnabled() && lead) {
    await gravarMensagem({
      lead_id: lead.id,
      chatid,
      direcao: 'out',
      autor: 'ia',
      texto: resposta,
      modo_no_momento: lead.modo,
      // Guarda o id do WhatsApp: é o que deixa o anti-loop reconhecer o eco
      // desta mensagem mesmo depois de um restart (o cache em memória morre no
      // deploy, e deploy é justo quando há mensagem recém-enviada em trânsito).
      uazapi_message_id: messageId,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    });
  }

  if (entregue && cwCtx?.conversationId) {
    try {
      await espelharMensagemConversa({ conversationId: cwCtx.conversationId, content: resposta, direction: 'out' });
    } catch (err) {
      console.error('[bridge] erro espelhando resposta Lúcio no Chatwoot:', err.message);
    }
  }

  if (entregue) console.log(`[bridge] respondeu telefone=${telefone} tokensIn=${tokensIn} tokensOut=${tokensOut}`);

  // Qualificador post-resposta: decide se vira MQL qualificado → handoff.
  // Roda MESMO se o envio falhou: o handoff julga o que o lead disse e só mexe
  // em Supabase/Chatwoot (não fala com o lead). Pular por causa de um 500 no
  // envio deixaria o lead mais quente da fila sem etiqueta e sem closer.
  // Pula se lead já está em handoff (modo=mudo) ou já foi qualificado.
  if (lead && lead.modo !== 'mudo' && lead.status !== 'qualificado' && lead.status !== 'handoff') {
    try {
      const historicoCompleto = supabaseEnabled()
        ? await ultimasMensagensDoLead(lead.id, 30)
        : historico;
      // Se o envio falhou, o lead nunca viu essa resposta: não pode entrar como
      // contexto de qualificação.
      const q = await avaliarQualificacao({ lead, historico: historicoCompleto, ultimaRespostaLucio: entregue ? resposta : null });
      if (q.qualified) {
        console.log(`[bridge] lead ${lead.id} qualificado → handoff (urgencia=${q.urgencia})`);
        await executarHandoff({ lead, qualificacao: q, chatwootCtx: cwCtx });
      }
    } catch (err) {
      console.error('[bridge] erro no qualifier:', err.message);
    }
  }
}

// Número identificado como central automática / URA. Não envia NADA pro lead:
// só registra a evidência (nota privada no Chatwoot + espelho no CRM), descarta
// o número (encerra → corta cadência) e marca a etiqueta `mql-descartado`.
async function tratarCentralAutomatica({ lead, telefone, cwCtx, justificativa, conteudoRecebido }) {
  const evidencia = (justificativa || '').slice(0, 400) || '(sem detalhe)';
  console.log(`[bridge] central automática detectada telefone=${telefone} lead=${lead?.id ?? '-'} :: ${evidencia}`);

  if (supabaseEnabled() && lead?.id) {
    try {
      await registrarEvento(lead.id, 'central_automatica_detectada', {
        telefone, evidencia, conteudo_recebido: (conteudoRecebido || '').slice(0, 500),
      });
    } catch (e) { console.error('[bridge] erro registrando evento central:', e.message); }
    // Só encerra se ainda não estava encerrado por esse motivo (idempotente).
    if (!(lead.status === 'encerrado' && lead.motivo_encerramento === 'central_automatica')) {
      try {
        await encerrarLead(lead.id, 'central_automatica');
      } catch (e) { console.error('[bridge] erro encerrando lead central:', e.message); }
    }
  }

  const nota = `🤖 *Número identificado como central automática / URA* — não é o contato de uma pessoa.\n`
    + `Evidência: ${evidencia}\n`
    + `O Lúcio NÃO respondeu (qualquer texto só realimentaria o bot do outro lado). `
    + `Número descartado e cadência suspensa.\n`
    + `Ação sugerida: buscar o contato direto por outra via (LinkedIn, site, indicação).`;

  if (cwCtx?.conversationId) {
    try {
      await removerLabels(cwCtx.conversationId, ['mql-em-cadencia', 'mql-respondeu', 'mql-qualificado']);
      await aplicarLabelsAditivo(cwCtx.conversationId, ['mql-descartado']);
      await addNotaPrivada(cwCtx.conversationId, nota);
    } catch (e) { console.error('[bridge] erro anotando central no Chatwoot:', e.message); }
  }
  if (supabaseEnabled() && lead?.id) {
    espelharNotaNoCrm(lead.id, nota)
      .catch(e => console.warn('[bridge] espelho nota CRM (central) falhou:', e.message));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// /outbound-batch — chamado pelo agendador-claudio (cron 08h) ou manual.
// 1) puxa pendentes elegíveis 2) formula toque via Claude SDK
// 3) POST WF-Lucio-Outbound 4) marca enviado.
// Body opcional: { limite, dryRun }
//
// AINDA NO TRILHO ANTIGO (n8n → uazapi). O inbound já migrou pra API oficial,
// este caminho não. Migrar exige template aprovado pela Meta: o 1º toque vai
// pra lead frio, fora da janela de 24h, e lá texto livre não passa.
// A fila está vazia hoje, então nada dispara por aqui — mas enrolar lead antes
// de migrar reativa o trilho não-oficial sem querer.
// ──────────────────────────────────────────────────────────────────────────
const N8N_OUTBOUND_WEBHOOK_URL = process.env.N8N_OUTBOUND_WEBHOOK_URL;
// Teto de tentativas por disparo. Acima disso, marca 'falha' e NAO gera mais
// (protege contra loop de regeneracao no Claude quando o envio falha).
const OUTBOUND_MAX_TENTATIVAS = parseInt(process.env.OUTBOUND_MAX_TENTATIVAS || '3', 10);

async function processarOutboundBatch({ limite = 50, dryRun = false } = {}) {
  // Controle global do dashboard: pausado/encerrado bloqueia o envio.
  // Não cancela agendamentos — só não dispara enquanto estiver fora de 'ativo'.
  try {
    const { estado } = await getOutboundEstado();
    if (estado !== 'ativo') {
      console.log(`[bridge] outbound-batch ignorado (estado=${estado})`);
      return { total: 0, resultados: [], pausado: estado };
    }
  } catch (err) {
    console.error('[bridge] erro lendo estado outbound (segue como ativo):', err.message);
  }

  const pendentes = await puxarPendentes(limite);
  console.log(`[bridge] outbound-batch puxou ${pendentes.length} pendentes (dryRun=${dryRun})`);
  const resultados = [];
  for (const p of pendentes) {
    try {
      // Teto de tentativas: conta ANTES de gerar (a chamada Claude e o custo).
      // Se ja estourou, marca falha e sai sem gerar — corta o loop de regeneracao.
      const tentativa = await incrementarTentativa(p.agendamentoId, p.tentativas);
      if (tentativa > OUTBOUND_MAX_TENTATIVAS) {
        await marcarFalha(p.agendamentoId, `max tentativas (${OUTBOUND_MAX_TENTATIVAS})`);
        resultados.push({ agendamentoId: p.agendamentoId, status: 'falha_max', tentativa });
        continue;
      }

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

      // Email de campanha (Resend) — mesmo gatilho do toque WhatsApp, mesmo lead.
      // Build puro (sem rede). O envio respeita o dryRun do batch + RESEND_DRY_RUN.
      const emailPayload = construirEmailPayload({ lead: p.lead, texto, passo: p.passo });

      if (dryRun) {
        // Mostra o que email E WhatsApp fariam, sem disparar nada.
        const emailDry = await enviarEmailResend(emailPayload, { dryRun: true });
        resultados.push({ agendamentoId: p.agendamentoId, status: 'dry', texto, email: emailDry });
        continue;
      }

      // Email é INDEPENDENTE do WhatsApp (canais paralelos, mesmo gatilho):
      // disparado ANTES do webhook pra não ser cortado pelo `continue` de falha
      // do n8n. enviarEmailResend nunca lança; o try/catch é cinto-e-suspensório.
      try {
        const emailRes = await enviarEmailResend(emailPayload, { dryRun: false });
        // Audita só envios reais (ok/erro) — skip/dry não viram evento (evita ruído).
        if (emailRes?.status === 'enviado' || emailRes?.status === 'erro') {
          await registrarEvento(p.lead.id, emailRes.ok ? 'email_enviado' : 'email_falha',
            { passo: p.passo, ...emailRes }).catch(() => {});
        }
      } catch (err) {
        console.error(`[bridge] email Resend falhou (segue WhatsApp) lead ${p.lead.id}:`, err.message);
      }

      let uazapiCampaignId = null;
      if (N8N_OUTBOUND_WEBHOOK_URL) {
        // Só 'chatwoot': este caminho sai por n8n → uazapi, não pela API
        // oficial, então não volta eco pelo /webhook/iasolution.
        registrarOutboundDoBridge({ telefone: p.lead.telefone, conteudo: texto, canais: ['chatwoot'] });
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
    if (eventName === 'conversation_updated') {
      const labels = ev.labels || ev.conversation?.labels || ev.messages?.[0]?.conversation?.labels || [];
      const convId = ev.id || ev.conversation?.id;
      const telefone = ev.meta?.sender?.phone_number
        || ev.contact_inbox?.contact?.phone_number
        || ev.messages?.[0]?.conversation?.meta?.sender?.phone_number
        || ev.conversation?.meta?.sender?.phone_number;

      // Caso A: devolver-lucio → devolve lead pro bot
      if (Array.isArray(labels) && labels.includes('devolver-lucio')) {
        if (!telefone) {
          console.warn('[bridge] conversation_updated com label devolver-lucio mas sem telefone identificável');
          return;
        }
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
              await removerLabels(convId, ['devolver-lucio', 'humano-atendendo', 'mql-qualificado']);
              await aplicarLabelsAditivo(convId, ['mql-em-cadencia']);
              await addNotaPrivada(convId, nota);
              espelharNotaNoCrm(lead.id, nota)
                .catch(e => console.warn('[bridge] espelho nota CRM (devolução) falhou:', e.message));
            }
          } catch (err) { console.error('[bridge] erro escrevendo feedback de devolução:', err.message); }
        } catch (err) {
          console.error('[bridge] erro processando devolver-lucio:', err.message);
          try { if (convId) await addNotaPrivada(convId, `⚠️ Falha ao devolver pro Lúcio: ${err.message}`); } catch {}
        }
        return;
      }

      // Caso C: closer reivindica o lead pra si via etiqueta (gerson/viviane).
      // Aplicou a label do próprio nome → atribui a conversa àquele agent.
      // Não silencia o Lúcio aqui (decisão: label manual não muta); o modo mudo
      // entra quando o closer mandar a 1ª mensagem, como já acontece hoje.
      if (Array.isArray(labels) && convId) {
        const labelCloser = labels.find(l => CLOSER_MAP[String(l).toLowerCase()]);
        if (labelCloser) {
          const agentId = CLOSER_MAP[String(labelCloser).toLowerCase()];
          try {
            await atribuirAgente(convId, agentId);
            console.log(`[bridge] etiqueta '${labelCloser}' → conversa ${convId} atribuída ao agent ${agentId}`);
          } catch (err) {
            console.error(`[bridge] erro atribuindo agent por etiqueta '${labelCloser}':`, err.message);
          }
        }
      }

      // Caso B: aplicação manual de label SQL pelo closer. Dois sub-casos:
      // (1) 2+ sql-* presentes → normaliza (mantém só a mais avançada).
      // (2) 1 sql-* presente → só registra transição (helper é idempotente).
      const sqlLabels = ['sql-contato-feito', 'sql-proposta', 'sql-negociacao', 'sql-ganho', 'sql-perdido'];
      const sqlPresentes = Array.isArray(labels) ? labels.filter(l => sqlLabels.includes(l)) : [];
      if (sqlPresentes.length >= 1 && convId) {
        let leadId = null;
        if (telefone) {
          try {
            const lead = await buscarLeadPorTelefone(telefone);
            leadId = lead?.id || null;
          } catch { /* tolerante */ }
        }
        if (sqlPresentes.length >= 2) {
          normalizarLabelsSqlSeNecessario({ conversationId: convId, leadId })
            .catch(err => console.error('[bridge] erro normalizando SQL labels:', err.message));
        } else if (leadId) {
          // Registra a transição com a única label SQL presente. Helper dedupica
          // automaticamente se já foi registrada (anti-loop via última etapa).
          const { registrarTransicao } = await import('./supabase-client.js');
          registrarTransicao(leadId, null, sqlPresentes[0], 'manual')
            .catch(err => console.error('[bridge] erro registrando transição SQL manual:', err.message));
        }
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

    // Dispara pela API oficial
    if (!iaSolutionEnabled()) {
      console.error('[bridge] iaSolution desabilitada — msg do closer não saiu');
      return;
    }
    let messageId = null;
    try {
      // Registra ANTES de enviar: a API oficial ecoa o que sai por ela, e sem
      // isso o eco da própria mensagem do closer volta como "humano no celular".
      // Só no canal 'whatsapp': esta mensagem já nasceu no Chatwoot, e marcá-la
      // lá faria o bridge engolir a repetição legítima do closer e o retry.
      registrarOutboundDoBridge({ telefone, conteudo, canais: ['whatsapp'] });
      const r = await enviarTextoImediato({ telefone, texto: conteudo });
      messageId = r.messageId;
      console.log(`[bridge] msg do closer enviada (msg=${messageId}) telefone=${telefone}`);
    } catch (err) {
      // Sem envio não há eco: solta a marca pra não engolir o retry que a nota
      // abaixo manda o closer fazer.
      esquecerOutboundDoBridge({ telefone, conteudo });
      // O closer precisa saber DENTRO do Chatwoot que a mensagem não saiu. Sem
      // aviso ele vê a própria fala postada na conversa e assume que o lead
      // recebeu — vale pra janela de 24h e pra qualquer outra falha.
      const aviso = err instanceof JanelaExpiradaError
        ? '⚠️ Mensagem NÃO entregue: passaram mais de 24h desde a última mensagem do lead. A Meta só permite retomar com template aprovado. Aguarde o lead escrever de novo.'
        : `⚠️ Mensagem NÃO entregue (falha no envio: ${String(err.message).slice(0, 120)}). Tente de novo em instantes; se persistir, avise o time.`;
      console.error(`[bridge] envio do closer falhou tel=${telefone}: ${err.message}`);
      const convId = ev.conversation?.id;
      if (convId) {
        await addNotaPrivada(convId, aviso)
          .catch(e => console.error('[bridge] erro avisando closer da falha:', e.message));
      }
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
          // Mesmo motivo do inbound: sem o id gravado, o eco desta mensagem
          // depois de um restart volta como fala nova do humano e duplica.
          uazapi_message_id: messageId,
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
    const convId = ev.conversation?.id
      || ev.conversation_id
      || ev.message?.conversation_id
      || ev.messages?.[0]?.conversation_id;
    console.log(`[bridge] chatwoot-webhook closer convId=${convId} (keys=${Object.keys(ev).join(',')}, conv_keys=${ev.conversation ? Object.keys(ev.conversation).join(',') : 'no_conv'})`);
    if (convId) {
      try {
        await aplicarLabelsAditivo(convId, ['humano-atendendo']);
        console.log(`[bridge] label humano-atendendo aplicada convId=${convId}`);
      } catch (err) {
        console.error('[bridge] erro aplicando label humano-atendendo:', err.message);
      }

      // F5: classificador SQL contínuo após msg do closer
      try {
        const lead = await buscarLeadPorTelefone(telefone);
        if (lead) {
          classificarSqlSeAplicavel({ lead, conversationId: convId })
            .catch(err => console.error('[bridge] erro sql-classifier (closer):', err.message));
        }
      } catch (err) {
        console.error('[bridge] erro carregando lead pro sql-classifier:', err.message);
      }
    } else {
      console.warn(`[bridge] chatwoot-webhook closer: não achou convId no payload`);
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
  console.log(`  supabase=${supabaseEnabled()} chatwoot=${chatwootEnabled()} crm=${crmEnabled()} whatsapp_oficial=${iaSolutionEnabled()} transcricao=${transcricaoEnabled()} buffer=${bufferEnabled() ? bufferSeconds()+'s' : 'off'}`);
  if (IASOLUTION_ALLOWLIST.length) console.warn(`  ATENÇÃO: allowlist de teste ativa (${IASOLUTION_ALLOWLIST.length} número(s)) — lead fora dela é ignorado`);
  if (iaSolutionEnabled() && !IASOLUTION_WEBHOOK_SECRET) console.warn('  ATENÇÃO: /webhook/iasolution SEM secret — endpoint aberto (defina IASOLUTION_WEBHOOK_SECRET)');
  if (iaSolutionEnabled() && !IASOLUTION_NUMERO_NEGOCIO) console.warn('  ATENÇÃO: IASOLUTION_NUMERO_NEGOCIO vazio — sem trava contra eco vindo do nosso próprio número');
  // Mantém a aba Tráfego fresca sozinha (Meta → trafego_diario a cada ~30min).
  iniciarColetaAutomatica();
});
