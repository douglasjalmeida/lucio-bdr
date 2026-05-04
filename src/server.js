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
    model: process.env.LUCIO_MODEL || 'claude-sonnet-4-6',
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// /in — chamado pelo WF-Lucio-IN do n8n quando uma mensagem chega no WhatsApp.
// Body: { telefone, nome, mensagem, chatid, timestamp, autor }
// ──────────────────────────────────────────────────────────────────────────
app.post('/in', async (req, res) => {
  const { telefone, nome, mensagem, chatid, timestamp, autor } = req.body || {};
  if (!telefone || !mensagem || !autor) {
    return res.status(400).json({ ok: false, erro: 'telefone, mensagem e autor são obrigatórios' });
  }

  try {
    let lead = supabaseEnabled() ? await buscarLeadPorTelefone(telefone) : null;
    if (!lead && supabaseEnabled()) {
      lead = await criarLead({ nome, telefone, origem: 'inbound' });
    }

    // Grava a mensagem que chegou (autor pode ser 'lead' ou 'humano').
    if (supabaseEnabled() && lead) {
      const direcao = autor === 'humano' ? 'out' : 'in';
      await gravarMensagem({
        lead_id: lead.id,
        chatid,
        direcao,
        autor,
        texto: mensagem,
        modo_no_momento: lead.modo,
      });
    }

    if (!deveResponder({ lead, autor })) {
      return res.json({ ok: true, respondeu: false, motivo: autor === 'humano' ? 'humano_conduzindo' : 'modo_mudo' });
    }

    const historico = (supabaseEnabled() && lead)
      ? await ultimasMensagensDoLead(lead.id, 30)
      : [];

    const { resposta, tokensIn, tokensOut } = await gerarRespostaInbound({
      lead,
      historico,
      mensagemAtual: mensagem,
    });

    if (!resposta) {
      return res.json({ ok: true, respondeu: false, motivo: 'sem_resposta_gerada' });
    }

    // Posta no WF-Lucio-OUT (n8n manda pro uazapi /send/text).
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

    res.json({ ok: true, respondeu: true, resposta, tokensIn, tokensOut });
  } catch (err) {
    console.error('[bridge] erro em /in:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// /outbound-batch — chamado pelo agendador-claudio (cron 08h) ou manual.
// Body: { leads: [{ telefone, lead_id, passo }], cadencia_id }
// F2: implementar formulação de mensagens via Claude e POST WF-Lucio-Outbound.
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
  console.log(`  supabase=${supabaseEnabled()} chatwoot=${chatwootEnabled()} n8n_out=${!!N8N_OUT_WEBHOOK_URL}`);
});
