// Detector de modo do lead.
// Regras (spec §3.1):
// - lead.modo === 'mudo' → bridge grava mensagem mas NÃO responde (humano tá conduzindo).
// - autor === 'humano' (humano respondeu pelo celular do número Luminus) → grava direcao=out, NÃO responde.
// - lead.modo === 'bot' && autor === 'lead' → roda Claude SDK e responde.

export function deveResponder({ lead, autor }) {
  if (autor === 'humano') return false;
  if (lead?.modo === 'mudo') return false;
  return true;
}

export function direcaoDaMensagem(autor) {
  if (autor === 'humano' || autor === 'ia') return 'out';
  return 'in';
}
