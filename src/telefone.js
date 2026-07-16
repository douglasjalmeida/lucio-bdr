// Normalização de telefone BR. Mora sozinho porque supabase-client e
// chatwoot-client precisam do mesmo helper e um importar o outro fecharia
// ciclo (chatwoot → supabase → crm → chatwoot).

// Persistimos sempre em E.164 com `+` na frente. A API do WhatsApp entrega sem
// `+`, Chatwoot entrega com `+` — sem normalizar, mesmo número vira 2 leads.
export function normalizaTelefone(telefone) {
  if (!telefone) return telefone;
  const t = String(telefone).trim();
  if (t.startsWith('+')) return t;
  const digits = t.replace(/\D/g, '');
  return digits ? '+' + digits : t;
}

// Gera as variantes BR de um número (com e SEM o 9º dígito de celular).
// O WhatsApp entrega o mesmo celular ora com 13 dígitos (+55 DD 9 XXXXXXXX),
// ora com 12 (+55 DD XXXXXXXX). Sem reconciliar, cada forma vira um lead/contato
// distinto. Esta função devolve todas as formas equivalentes pra casar no lookup.
export function variantesTelefone(telefone) {
  const norm = normalizaTelefone(telefone);
  if (!norm || !norm.startsWith('+')) return [norm].filter(Boolean);
  const d = norm.slice(1);
  const set = new Set([norm]);
  if (d.startsWith('55')) {
    const ddd = d.slice(2, 4);
    const sub = d.slice(4);
    if (sub.length === 9 && sub[0] === '9') set.add('+55' + ddd + sub.slice(1)); // tem 9 → sem 9
    else if (sub.length === 8) set.add('+55' + ddd + '9' + sub);                  // sem 9 → com 9
  }
  return [...set];
}

// Forma canônica pra usar como chave: só dígitos, sempre COM o 9º dígito.
// Duas grafias do mesmo celular colapsam na mesma string.
export function chaveTelefone(telefone) {
  const variantes = variantesTelefone(telefone).map(v => String(v).replace(/\D/g, ''));
  if (!variantes.length) return String(telefone || '').replace(/\D/g, '');
  // A variante mais longa é a que tem o 9; sem 9 disponível, sobra a única forma.
  return variantes.sort((a, b) => b.length - a.length)[0];
}
