// Buffer in-memory por chatid: agrupa mensagens chegando em rajada
// e dispara processamento depois de N segundos sem nova mensagem.
//
// Por quê: lead no WhatsApp manda 2-3 mensagens curtas seguidas ("oi",
// "vc atende?", "preciso de gerador"). Sem buffer o Lúcio responde 3
// vezes — feio. Com buffer, espera o lead terminar de digitar e
// responde uma vez só com contexto agrupado.
//
// Limites do MVP: in-memory (perde em restart), single-process. Quando
// virar multi-réplica ou exigir persistência cross-restart, migrar pra
// fila Supabase/Redis.

const BUFFER_SECONDS = parseInt(process.env.LUCIO_BUFFER_SECONDS || '10', 10);
const BUFFER_MS = BUFFER_SECONDS * 1000;

const buffers = new Map();

export function bufferEnabled() {
  return BUFFER_MS > 0;
}

export function bufferSeconds() {
  return BUFFER_SECONDS;
}

/**
 * Enfileira uma mensagem. Quando o timer estourar (sem novas mensagens
 * pro mesmo chatid), chama `processador(items)` com a fila acumulada.
 */
export function enfileirarMensagem(item, processador) {
  const key = item.chatid || item.telefone;
  if (!key) {
    console.error('[buffer] item sem chatid/telefone, ignorando');
    return;
  }

  if (BUFFER_MS <= 0) {
    Promise.resolve(processador([item])).catch(err => console.error('[buffer] erro:', err));
    return;
  }

  const existente = buffers.get(key) || { items: [] };
  existente.items.push(item);

  if (existente.timer) clearTimeout(existente.timer);

  existente.timer = setTimeout(async () => {
    buffers.delete(key);
    console.log(`[buffer] disparando processador (chatid=${key} items=${existente.items.length})`);
    try { await processador(existente.items); }
    catch (err) { console.error('[buffer] erro processando:', err); }
  }, BUFFER_MS);

  buffers.set(key, existente);
  console.log(`[buffer] enfileirada (chatid=${key} queue=${existente.items.length} aguardando ${BUFFER_SECONDS}s)`);
}
