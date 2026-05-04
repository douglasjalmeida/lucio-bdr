import 'dotenv/config';
import express from 'express';
import {
  supabaseEnabled,
  buscarLeadPorTelefone,
  criarLead,
  gravarMensagem,
  ultimasMensagensDoLead,
  devolverPraBot,
} from './supabase-client.js';
import { deveResponder } from './handoff.js';
import { gerarRespostaInbound } from './lucio-agent.js';
import { chatwootEnabled } from './mcps.js';
import { enfileirarMensagem, bufferSeconds, bufferEnabled } from './buffer.js';

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

  enfileirarMensagem({ telefone, nome, mensagem, chatid, timestamp, autor }, processarBatch);
});

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

  console.log(`[bridge] respondeu telefone=${telefone} tokensIn=${tokensIn} tokensOut=${tokensOut}`);
}

// ──────────────────────────────────────────────────────────────────────────
// /outbound-batch — chamado pelo agendador-claudio (cron 08h) ou manual.
// F2: implementação pendente.
// ──────────────────────────────────────────────────────────────────────────
app.post('/outbound-batch', async (_req, res) => {
  res.status(501).json({ ok: false, erro: 'implementação F2 — ainda não pronto' });
});

// ──────────────────────────────────────────────────────────────────────────
// /handoff-return — webhook do Chatwoot quando label `devolver-lucio` é aplicada.
// Body: { lead_id } ou { telefone }.
// ──────────────────────────────────────────────────────────────────────────
app.post('/handoff-return', async (req, res) => {
  const { lead_id, telefone } = req.body || {};
  try {
    let id = lead_id;
    if (!id && telefone && supabaseEnabled()) {
      const lead = await buscarLeadPorTelefone(telefone);
      id = lead?.id;
    }
    if (!id) return res.status(400).json({ ok: false, erro: 'lead_id ou telefone necessário' });
    if (supabaseEnabled()) await devolverPraBot(id);
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
