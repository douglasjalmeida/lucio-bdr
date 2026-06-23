// Cliente de email transacional/campanha via Resend (https://resend.com/docs).
//
// Acoplado ao disparo de campanha do Lúcio: mesmo gatilho do toque WhatsApp,
// destinatário = o lead. Canais INDEPENDENTES — falha de email não derruba o
// WhatsApp e vice-versa (esta função NUNCA lança; só loga).
//
// Segurança:
// - RESEND_API_KEY vem do ambiente (nunca hardcoded).
// - DRY-RUN POR DEFAULT: só envia de verdade com RESEND_DRY_RUN=false explícito.
//   Variável ausente, vazia ou qualquer outro valor ⇒ dry-run (só loga o payload).
// - Conteúdo parametrizável: remetente (RESEND_FROM), assunto
//   (RESEND_SUBJECT_TEMPLATE com {nome}/{empresa}) e corpo (o texto do toque).
//
// Estado atual: os leads não têm campo de email, então `to` fica vazio e o envio
// é pulado (skip:sem-destinatario). Quando existir fonte de email por lead, o
// caminho real passa a funcionar sem mudar este módulo.

const RESEND_API_URL = 'https://api.resend.com/emails';
const API_KEY = process.env.RESEND_API_KEY || '';
// Default seguro: só sai do dry-run com a flag EXPLICITAMENTE 'false'.
const DRY_DEFAULT = process.env.RESEND_DRY_RUN !== 'false';
const FROM = process.env.RESEND_FROM || '';
const SUBJECT_TEMPLATE = process.env.RESEND_SUBJECT_TEMPLATE || 'Luminus — sobre o seu contato';
const TIMEOUT_MS = parseInt(process.env.RESEND_TIMEOUT_MS || '8000', 10);

export function resendEnabled() {
  return !!API_KEY;
}

function preencherTemplate(tpl, { nome, empresa } = {}) {
  return String(tpl)
    .replaceAll('{nome}', nome || '')
    .replaceAll('{empresa}', empresa || '')
    .trim();
}

// Corpo HTML mínimo a partir do texto do toque (parametrizável: o conteúdo é o
// próprio toque gerado pela campanha, não fixo no código).
function corpoHtml(texto) {
  const safe = String(texto || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${safe}</div>`;
}

/**
 * Monta o payload de email da campanha pro lead. `to` vem de lead.email (hoje
 * inexistente → null → será pulado). NÃO envia; só constrói (puro, sem rede).
 *
 * @param {object} params
 * @param {object} params.lead - {nome, empresa, email?, ...}
 * @param {string} params.texto - texto do toque (corpo do email).
 * @param {number} [params.passo]
 * @returns {{to:string|null, from:string, subject:string, html:string, text:string, lead_id:any, passo:any}}
 */
export function construirEmailPayload({ lead, texto, passo = null }) {
  return {
    to: lead?.email || null,
    from: FROM,
    subject: preencherTemplate(SUBJECT_TEMPLATE, { nome: lead?.nome, empresa: lead?.empresa }),
    html: corpoHtml(texto),
    text: String(texto || ''),
    lead_id: lead?.id ?? null,
    passo,
  };
}

/**
 * Envia (ou simula) o email via Resend. NUNCA lança — retorna um objeto-status.
 * Gate final de envio real: !dryRun && !DRY_DEFAULT && resendEnabled() && payload.to.
 *
 * @param {object} payload - saída de construirEmailPayload.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - dry-run do batch (soma ao DRY_DEFAULT).
 * @returns {Promise<{status:string, ok?:boolean, dry?:boolean, skip?:string, erro?:string, http?:number}>}
 */
export async function enviarEmailResend(payload, { dryRun = false } = {}) {
  const efetivoDry = dryRun || DRY_DEFAULT;

  if (!payload?.to) {
    console.log(`[resend] skip:sem-destinatario lead=${payload?.lead_id ?? '?'} (lead sem email)`);
    return { status: 'skip', skip: 'sem-destinatario' };
  }
  if (!payload.from) {
    console.log('[resend] skip:sem-remetente (RESEND_FROM vazio)');
    return { status: 'skip', skip: 'sem-remetente' };
  }
  if (efetivoDry || !resendEnabled()) {
    const motivo = !resendEnabled() ? 'sem-api-key' : 'dry-run';
    console.log(`[resend][dry] (${motivo}) payload`, JSON.stringify({
      to: payload.to, from: payload.from, subject: payload.subject, lead_id: payload.lead_id, passo: payload.passo,
    }));
    return { status: 'dry', dry: true, motivo };
  }

  // Envio real (só chega aqui com RESEND_DRY_RUN=false + API key + destinatário).
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: payload.from, to: payload.to, subject: payload.subject, html: payload.html, text: payload.text }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const corpo = await r.text().catch(() => '');
      console.error(`[resend] envio falhou http=${r.status} ${corpo.slice(0, 200)}`);
      return { status: 'erro', erro: `http ${r.status}`, http: r.status };
    }
    const j = await r.json().catch(() => ({}));
    console.log(`[resend] enviado lead=${payload.lead_id ?? '?'} id=${j?.id || '?'}`);
    return { status: 'enviado', ok: true, id: j?.id || null };
  } catch (err) {
    console.error('[resend] erro de rede/timeout (segue sem derrubar WhatsApp):', err.message);
    return { status: 'erro', erro: err.message };
  } finally {
    clearTimeout(t);
  }
}
