// Transcrição de PTT (áudio do lead) via Groq Whisper.
//
// Isso vivia no WF-Lucio-IN do n8n. Com o parse do inbound no bridge, precisa
// viver aqui: sem transcrever, áudio do lead chega como placeholder e o Lúcio
// responde no escuro (decisão D11 — áudio desde a F1).

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MODELO = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';
const TIMEOUT_MS = +(process.env.GROQ_TIMEOUT_MS || 30000);
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

export function transcricaoEnabled() { return !!GROQ_API_KEY; }

// O Whisper usa a extensão do arquivo pra escolher o decoder, então o mime do
// WhatsApp (audio/ogg; codecs=opus) precisa virar um nome de arquivo coerente.
function extensaoDoMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return {
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/amr': 'amr',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
  }[m] || 'ogg';
}

export async function transcreverAudio({ buffer, mimeType }) {
  if (!transcricaoEnabled()) throw new Error('transcrição desabilitada (GROQ_API_KEY ausente)');
  if (!buffer?.length) throw new Error('transcreverAudio: buffer vazio');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), `audio.${extensaoDoMime(mimeType)}`);
  form.append('model', MODELO);
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Groq Whisper ${r.status}: ${t.slice(0, 200)}`);

  let json = null;
  try { json = JSON.parse(t); } catch { throw new Error('Groq Whisper: resposta não-JSON'); }
  return String(json?.text || '').trim();
}
