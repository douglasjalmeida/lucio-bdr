// Cliente da API oficial do WhatsApp (Meta Cloud API) via BSP iaSolution.
// Substitui o uazapi-client.js: mesmo contrato de envio, transporte oficial.
//
// Regra que a uazapi não tinha: a Meta só aceita texto livre dentro da janela
// de 24h desde a última mensagem do lead. Fora dela o envio falha e só template
// aprovado (HSM) passa. Por isso o erro de janela é tipado — quem chama precisa
// distinguir "falhou" de "não pode falar agora".

const BASE = (process.env.IASOLUTION_BASE_URL || 'https://apihub.iasolution.app/api/v1').replace(/\/+$/, '');
const TOKEN = process.env.IASOLUTION_TOKEN || '';
const TIMEOUT_MS = +(process.env.IASOLUTION_TIMEOUT_MS || 15000);

const enabled = !!(BASE && TOKEN);

export function iaSolutionEnabled() { return enabled; }

// Códigos da Cloud API pra "conversa fora da janela de 24h / precisa template".
// 131047 = Re-engagement message; 470 = mesma coisa no código legado.
// NÃO incluir 131026 (Message Undeliverable): é número sem WhatsApp, não janela.
const CODIGOS_JANELA = new Set([131047, 470]);

export class JanelaExpiradaError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'JanelaExpiradaError';
  }
}

function normalizaTelefoneE164SemMais(telefone) {
  if (!telefone) return telefone;
  return String(telefone).replace(/\D/g, '');
}

async function chamar(caminho, { method = 'POST', body = null } = {}) {
  if (!enabled) throw new Error('iaSolution desabilitada (IASOLUTION_BASE_URL/IASOLUTION_TOKEN ausentes)');
  const r = await fetch(`${BASE}${caminho}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const t = await r.text();
  let json = null;
  try { json = t ? JSON.parse(t) : null; } catch { /* resposta não-JSON cai no erro abaixo */ }
  if (!r.ok) {
    const erro = json?.error || {};
    const codigo = Number(erro.code ?? json?.code);
    const detalhe = erro.message || t.slice(0, 200);
    if (CODIGOS_JANELA.has(codigo)) throw new JanelaExpiradaError(`janela de 24h expirada (code=${codigo}): ${detalhe}`);
    throw new Error(`iaSolution ${r.status}: ${detalhe}`);
  }
  return json;
}

// Envio de texto livre. Mesma assinatura do antigo uazapi-client pra troca ser
// drop-in nos pontos de saída (resposta do Lúcio, closer no Chatwoot, watchdog).
export async function enviarTextoImediato({ telefone, texto }) {
  const to = normalizaTelefoneE164SemMais(telefone);
  const json = await chamar('/messages/text', { body: { to, text: texto } });
  const messageId = json?.messages?.[0]?.id || json?.message_id || json?.id || null;
  return { messageId, raw: json };
}

// Baixa mídia (PTT do lead) pra transcrever. O download é direto, em UMA
// requisição: não existe passo de metadata devolvendo url temporária.
//
// A doc (apihub.iasolution.app/docs) dá dois caminhos e recomenda o primeiro:
//   1. `messages[].download_url`, que o webhook já entrega montado;
//   2. GET /media/{media_id}/download, montado a partir do id.
// Os dois exigem o mesmo Bearer do canal.
export async function baixarMidia({ mediaId, downloadUrl } = {}) {
  if (!enabled) throw new Error('iaSolution desabilitada');
  if (!downloadUrl && !mediaId) throw new Error('baixarMidia: sem downloadUrl nem mediaId');

  const url = downloadUrl || `${BASE}/media/${encodeURIComponent(mediaId)}/download`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`iaSolution: download de mídia ${r.status} (id=${mediaId || '-'})`);

  return {
    buffer: Buffer.from(await r.arrayBuffer()),
    mimeType: r.headers.get('content-type') || 'audio/ogg',
  };
}
