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

// Busca contato por telefone. Retorna o primeiro match ou null.
export async function buscarContatoPorTelefone(telefone) {
  if (!enabled) return null;
  const phone = normalizaTelefone(telefone);
  const q = encodeURIComponent(phone);
  const res = await call('GET', `/contacts/search?q=${q}&include=contact_inboxes`);
  const matches = (res?.payload || []).filter(c => c.phone_number === phone);
  return matches[0] || null;
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
