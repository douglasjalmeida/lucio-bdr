// Cliente REST do Chatwoot da Luminus.
// Tolera ausência de config (CHATWOOT_BASE_URL vazio) — todas as funções viram no-op.
// Auth via user API access token (CHATWOOT_API_TOKEN).

const BASE_URL = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '';
const INBOX_ID = parseInt(process.env.CHATWOOT_INBOX_ID || '0', 10) || null;

const enabled = !!(BASE_URL && TOKEN && ACCOUNT_ID && INBOX_ID);

export function chatwootEnabled() {
  return enabled;
}

export function chatwootConfig() {
  return { enabled, base: BASE_URL, accountId: ACCOUNT_ID, inboxId: INBOX_ID };
}

function api(path) {
  return `${BASE_URL}/api/v1/accounts/${ACCOUNT_ID}${path}`;
}

async function call(method, path, body = null) {
  if (!enabled) return null;
  const opts = {
    method,
    headers: { 'api_access_token': TOKEN, 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const r = await fetch(api(path), opts);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* deixa null */ }
  if (!r.ok) {
    const snippet = text ? text.slice(0, 300) : '(vazio)';
    throw new Error(`Chatwoot ${method} ${path} -> ${r.status}: ${snippet}`);
  }
  return json;
}

// Normaliza telefone pro padrão E.164 que o Chatwoot espera (+5511...).
function normalizaTelefone(telefone) {
  if (!telefone) return telefone;
  const t = String(telefone).trim();
  if (t.startsWith('+')) return t;
  const digits = t.replace(/\D/g, '');
  return '+' + digits;
}

// Variantes BR com e SEM o 9º dígito de celular — o WhatsApp entrega o mesmo
// número ora com 13 dígitos, ora com 12. Sem reconciliar, vira contato duplicado.
function variantesTelefone(telefone) {
  const norm = normalizaTelefone(telefone);
  if (!norm || !norm.startsWith('+')) return [norm].filter(Boolean);
  const d = norm.slice(1);
  const set = new Set([norm]);
  if (d.startsWith('55')) {
    const ddd = d.slice(2, 4);
    const sub = d.slice(4);
    if (sub.length === 9 && sub[0] === '9') set.add('+55' + ddd + sub.slice(1));
    else if (sub.length === 8) set.add('+55' + ddd + '9' + sub);
  }
  return [...set];
}

// Busca contato por telefone, tolerante ao 9º dígito (casa 12 e 13 dígitos BR).
// Retorna o primeiro match ou null.
export async function buscarContatoPorTelefone(telefone) {
  if (!enabled) return null;
  const variantes = variantesTelefone(telefone);
  for (const v of variantes) {
    const res = await call('GET', `/contacts/search?q=${encodeURIComponent(v)}&include=contact_inboxes`);
    const matches = (res?.payload || []).filter(c => variantes.includes(c.phone_number));
    if (matches[0]) return matches[0];
  }
  return null;
}

// Cria contato + plugado no inbox API. Retorna { contact, sourceId }.
export async function criarContatoComInbox({ telefone, nome, customAttrs = {} }) {
  if (!enabled) return null;
  const phone = normalizaTelefone(telefone);
  const created = await call('POST', '/contacts', {
    inbox_id: INBOX_ID,
    name: nome || phone,
    phone_number: phone,
    custom_attributes: customAttrs,
  });
  // POST /contacts com inbox_id já retorna contact_inboxes preenchido.
  const contact = created?.payload?.contact || created?.contact || created?.payload || created;
  const ci = (contact?.contact_inboxes || []).find(x => x.inbox?.id === INBOX_ID || x.inbox_id === INBOX_ID);
  const sourceId = ci?.source_id || null;
  return { contact, sourceId };
}

// Retorna { contact, sourceId } — cria se não existir.
export async function garantirContato({ telefone, nome, customAttrs = {} }) {
  if (!enabled) return null;
  const existente = await buscarContatoPorTelefone(telefone);
  if (existente) {
    // pega source_id do inbox certo (se existir)
    const ci = (existente.contact_inboxes || []).find(x => (x.inbox?.id === INBOX_ID) || (x.inbox_id === INBOX_ID));
    let sourceId = ci?.source_id || null;
    if (!sourceId) {
      // pluga no inbox API agora
      const r = await call('POST', `/contacts/${existente.id}/contact_inboxes`, { inbox_id: INBOX_ID });
      sourceId = r?.source_id || r?.payload?.source_id || null;
    }
    return { contact: existente, sourceId };
  }
  return criarContatoComInbox({ telefone, nome, customAttrs });
}

// Lista conversas do contato (filtra open).
export async function conversaAbertaDoContato(contactId) {
  if (!enabled) return null;
  const res = await call('GET', `/contacts/${contactId}/conversations`);
  const lista = res?.payload || [];
  // tenta encontrar conversa no nosso inbox + status open
  const open = lista.find(c => (c.inbox_id === INBOX_ID || c.meta?.channel) && c.status === 'open');
  return open || null;
}

// Cria conversa. Precisa de sourceId (do contact_inbox).
export async function criarConversa({ contactId, sourceId }) {
  if (!enabled) return null;
  const res = await call('POST', '/conversations', {
    source_id: sourceId,
    inbox_id: INBOX_ID,
    contact_id: contactId,
    status: 'open',
  });
  return res?.payload || res;
}

export async function garantirConversa({ contactId, sourceId }) {
  if (!enabled) return null;
  const aberta = await conversaAbertaDoContato(contactId);
  if (aberta) return aberta;
  return criarConversa({ contactId, sourceId });
}

// Cache de IDs de mensagens que ACABAMOS de espelhar — pro /chatwoot-webhook
// ignorar e não cair em loop (Chatwoot dispara webhook outgoing pra toda msg
// criada via API, inclusive a que o próprio bridge postou como espelho).
// TTL ~120s e tamanho cap pra não vazar memória.
const mirroredIds = new Map(); // id -> expiresAt
const MIRRORED_TTL_MS = 120_000;
const MIRRORED_MAX = 5000;

function registrarIdEspelhado(id) {
  if (!id) return;
  const now = Date.now();
  // limpa expirados a cada inserção (barato)
  for (const [k, exp] of mirroredIds) if (exp <= now) mirroredIds.delete(k);
  if (mirroredIds.size >= MIRRORED_MAX) {
    const firstKey = mirroredIds.keys().next().value;
    if (firstKey !== undefined) mirroredIds.delete(firstKey);
  }
  mirroredIds.set(String(id), now + MIRRORED_TTL_MS);
}

export function foiEspelhadoPeloBridge(id) {
  if (!id) return false;
  const exp = mirroredIds.get(String(id));
  if (!exp) return false;
  if (exp <= Date.now()) { mirroredIds.delete(String(id)); return false; }
  return true;
}

// Segundo cache, baseado em (telefone + hash do conteúdo). É o cinto de
// segurança caso o filtro por ID falhe (formato diferente entre POST response
// e webhook payload, restart de processo, múltiplas réplicas, etc).
// Se o bridge enviou esse conteúdo pra esse telefone nos últimos 90s, qualquer
// webhook outgoing com o mesmo par é tratado como eco e ignorado.
const outboundByPhoneContent = new Map(); // key -> expiresAt
const OUTBOUND_TTL_MS = 90_000;
const OUTBOUND_MAX = 5000;

function hashConteudo(s) {
  // hash leve e estável; não precisa ser criptográfico
  const str = String(s || '');
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

function chaveOutbound(telefone, conteudo) {
  const tel = String(telefone || '').replace(/\D/g, '');
  return `${tel}|${hashConteudo(conteudo)}`;
}

export function registrarOutboundDoBridge({ telefone, conteudo }) {
  if (!telefone || !conteudo) return;
  const k = chaveOutbound(telefone, conteudo);
  const now = Date.now();
  for (const [key, exp] of outboundByPhoneContent) if (exp <= now) outboundByPhoneContent.delete(key);
  if (outboundByPhoneContent.size >= OUTBOUND_MAX) {
    const firstKey = outboundByPhoneContent.keys().next().value;
    if (firstKey !== undefined) outboundByPhoneContent.delete(firstKey);
  }
  outboundByPhoneContent.set(k, now + OUTBOUND_TTL_MS);
}

export function jaEnviadoPeloBridge({ telefone, conteudo }) {
  if (!telefone || !conteudo) return false;
  const k = chaveOutbound(telefone, conteudo);
  const exp = outboundByPhoneContent.get(k);
  if (!exp) return false;
  if (exp <= Date.now()) { outboundByPhoneContent.delete(k); return false; }
  return true;
}

// Espelha mensagem na conversa. direction: 'in' (lead) ou 'out' (Lúcio/humano).
export async function espelharMensagemConversa({ conversationId, content, direction, isPrivate = false }) {
  if (!enabled || !conversationId) return null;
  const message_type = direction === 'in' ? 'incoming' : 'outgoing';
  const res = await call('POST', `/conversations/${conversationId}/messages`, {
    content,
    message_type,
    private: isPrivate,
  });
  // Registra ID de tudo que o bridge POSTou (público OU privado). Notas
  // privadas também disparam webhook message_created — sem registrar, o
  // próprio bridge re-processaria a nota que ele acabou de postar.
  if (direction !== 'in') {
    const id = res?.id || res?.payload?.id;
    registrarIdEspelhado(id);
  }
  return res;
}

export async function addNotaPrivada(conversationId, content) {
  return espelharMensagemConversa({ conversationId, content, direction: 'out', isPrivate: true });
}

// Endpoint /labels é destrutivo (sobrescreve set). Mesclamos com labels atuais.
export async function aplicarLabelsAditivo(conversationId, novasLabels) {
  if (!enabled || !conversationId) return null;
  const cur = await call('GET', `/conversations/${conversationId}/labels`);
  const atuais = cur?.payload || [];
  const set = new Set([...atuais, ...novasLabels]);
  return call('POST', `/conversations/${conversationId}/labels`, { labels: Array.from(set) });
}

// Labels que indicam progresso além da triagem MQL inicial. Se qualquer
// uma estiver presente, NÃO devemos re-aplicar mql-respondeu quando o
// lead manda nova mensagem — ele já avançou no pipeline.
const LABELS_ALEM_DE_TRIAGEM = [
  'mql-qualificado',
  'mql-descartado',
  'humano-atendendo',
  'sql-contato-feito',
  'sql-proposta',
  'sql-negociacao',
  'sql-ganho',
  'sql-perdido',
];

export async function marcarRespondeuSeTriagem(conversationId) {
  if (!enabled || !conversationId) return null;
  const cur = await call('GET', `/conversations/${conversationId}/labels`);
  const atuais = cur?.payload || [];
  if (atuais.some(l => LABELS_ALEM_DE_TRIAGEM.includes(l))) {
    return { skipped: true, reason: 'conversa-alem-da-triagem', atuais };
  }
  if (atuais.includes('mql-respondeu')) return { skipped: true, reason: 'ja-aplicada' };
  const set = new Set([...atuais, 'mql-respondeu']);
  return call('POST', `/conversations/${conversationId}/labels`, { labels: Array.from(set) });
}

// Remove labels específicas mantendo as outras.
export async function removerLabels(conversationId, labelsRemover) {
  if (!enabled || !conversationId) return null;
  const cur = await call('GET', `/conversations/${conversationId}/labels`);
  const atuais = cur?.payload || [];
  const restante = atuais.filter(l => !labelsRemover.includes(l));
  return call('POST', `/conversations/${conversationId}/labels`, { labels: restante });
}

export async function atribuirTeam(conversationId, teamId) {
  if (!enabled || !conversationId || !teamId) return null;
  return call('POST', `/conversations/${conversationId}/assignments`, { team_id: teamId });
}

export async function atualizarAtributosContato(contactId, customAttrs) {
  if (!enabled || !contactId) return null;
  return call('PATCH', `/contacts/${contactId}`, { custom_attributes: customAttrs });
}

// Helper de alto nível: garante contato + conversa de um lead e devolve { contactId, conversationId, sourceId }.
export async function garantirLeadNoChatwoot({ telefone, nome, customAttrs = {} }) {
  if (!enabled) return null;
  const { contact, sourceId } = await garantirContato({ telefone, nome, customAttrs });
  if (!contact?.id) return null;
  const conv = await garantirConversa({ contactId: contact.id, sourceId });
  return {
    contactId: contact.id,
    conversationId: conv?.id || null,
    sourceId,
  };
}
