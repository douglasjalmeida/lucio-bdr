// Cliente uazapi pra disparos imediatos (não-cadenciados).
// Usado pelo /chatwoot-webhook quando closer humano envia msg pelo Chatwoot.
// Cadência em batch continua via n8n WF-Lucio-Outbound (jitter + agendamento).

const BASE = (process.env.UAZAPI_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.UAZAPI_INSTANCE_TOKEN || '';
const enabled = !!(BASE && TOKEN);

export function uazapiEnabled() { return enabled; }

function normalizaTelefoneE164SemMais(telefone) {
  if (!telefone) return telefone;
  return String(telefone).replace(/\D/g, '');
}

// Envio imediato de texto. Usa /sender/advanced com delays zerados
// (não-bloqueante, sem jitter — closer espera resposta na hora).
export async function enviarTextoImediato({ telefone, texto }) {
  if (!enabled) throw new Error('uazapi desabilitado (UAZAPI_BASE_URL/TOKEN ausentes)');
  const number = normalizaTelefoneE164SemMais(telefone);
  const body = {
    delayMin: 0,
    delayMax: 0,
    info: 'closer-chatwoot',
    messages: [{ number, type: 'text', text: texto }],
  };
  const r = await fetch(`${BASE}/sender/advanced`, {
    method: 'POST',
    headers: { 'token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let json = null; try { json = t ? JSON.parse(t) : null; } catch {}
  if (!r.ok) throw new Error(`uazapi ${r.status}: ${t.slice(0, 200)}`);
  return { folderId: json?.folder_id || null, raw: json };
}
