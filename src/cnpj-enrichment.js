// Enriquecimento de CNPJ via BrasilAPI (Receita Federal pública, free).
// Classifica tipo_empresa por CNAE primário conforme decisão Cláudio (2026-05-13):
//   - CNAE 4120-4/* (Construção de edifícios)  → "construtora"
//   - CNAE divisões 41-43 (Construção em geral)→ "construtora"
//   - CNAE 6810-2/02 (Incorporação imobiliária)→ "incorporadora"
//   - CNAE 6810-2/01 (Compra/venda imóveis)    → "incorporadora"
//   - Outros                                    → "indefinido"
//
// Fallback heurístico por razão social/nome fantasia quando CNAE for ambíguo
// (ex: "Construtora X Incorporadora Y SA"): se tem "incorporadora" no nome
// E tem CNAE de construção, marca "ambos".

const BRASILAPI_BASE = 'https://brasilapi.com.br/api/cnpj/v1';

function limpaCnpj(cnpj) {
  if (!cnpj) return null;
  const s = String(cnpj).replace(/\D/g, '');
  return s.length === 14 ? s : null;
}

function classificaPorCnae(cnaeCode) {
  if (!cnaeCode) return null;
  const c = String(cnaeCode).replace(/\D/g, '');                 // "4120400" pra "4120-4/00"
  // CNAEs de construção em geral: divisões 41, 42, 43
  if (/^4[123]\d{5}$/.test(c)) return 'construtora';
  // CNAE 6810-2/01 (compra/venda imóveis próprios) e 6810-2/02 (incorporação imobiliária)
  if (/^681020[12]$/.test(c)) return 'incorporadora';
  return 'indefinido';
}

function reforcaPorTexto(razao, fantasia) {
  const txt = `${razao || ''} ${fantasia || ''}`.toLowerCase();
  const temConstr = /\bconstrutora\b|\bconstru[çc][aã]o\b|\bconstru[çc][oõ]es\b|\bobras?\b|\bengenharia\b/.test(txt);
  const temIncorp = /\bincorporadora\b|\bincorpora[çc][aã]o\b|\bempreendimentos?\b|\bimobili[áa]ria\b|\brealty\b|\burbanismo\b|\bdesenvolvimento imobili[áa]rio\b|\bholding\b/.test(txt);
  if (temConstr && temIncorp) return 'ambos';
  if (temIncorp) return 'incorporadora';
  if (temConstr) return 'construtora';
  return null;
}

/**
 * Combina CNAE (forte) + texto (fallback/reforço).
 */
export function classificaTipoEmpresa({ cnaePrimario, razaoSocial, nomeFantasia }) {
  const porCnae = classificaPorCnae(cnaePrimario);
  const porTexto = reforcaPorTexto(razaoSocial, nomeFantasia);

  // CNAE de construção + texto de incorporadora → "ambos"
  if (porCnae === 'construtora' && porTexto === 'incorporadora') return 'ambos';
  if (porCnae === 'incorporadora' && porTexto === 'construtora') return 'ambos';
  if (porCnae && porCnae !== 'indefinido') return porCnae;
  if (porTexto) return porTexto;
  return 'indefinido';
}

/**
 * Consulta BrasilAPI e devolve campos normalizados pra inserir em leads.
 * Retorna null se CNPJ inválido ou se a API falhar.
 */
export async function enriquecerCnpj(cnpjRaw, { timeoutMs = 8000 } = {}) {
  const cnpj = limpaCnpj(cnpjRaw);
  if (!cnpj) return null;

  const url = `${BRASILAPI_BASE}/${cnpj}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      if (r.status === 404) return { cnpj, situacao_cadastral: 'NAO_ENCONTRADO' };
      console.warn(`[cnpj-enrichment] BrasilAPI ${r.status} pra ${cnpj}`);
      return null;
    }
    const data = await r.json();

    // BrasilAPI normaliza CNAE como `cnae_fiscal` (número) + `cnae_fiscal_descricao`.
    // Formato bonito: "4120-4/00" — vamos reconstruir só se precisar; pro classifier
    // basta a sequência numérica.
    const cnaeFiscal = data.cnae_fiscal != null ? String(data.cnae_fiscal) : null;
    const razaoSocial = data.razao_social || null;
    const nomeFantasia = data.nome_fantasia || null;

    const tipo = classificaTipoEmpresa({
      cnaePrimario: cnaeFiscal,
      razaoSocial,
      nomeFantasia,
    });

    return {
      cnpj,
      razao_social: razaoSocial,
      nome_fantasia: nomeFantasia,
      cnae_primario: cnaeFiscal,
      cnae_descricao: data.cnae_fiscal_descricao || null,
      capital_social: data.capital_social != null ? Number(data.capital_social) : null,
      situacao_cadastral: data.descricao_situacao_cadastral || null,
      data_abertura_empresa: data.data_inicio_atividade || null,
      tipo_empresa: tipo,
    };
  } catch (err) {
    if (err.name === 'AbortError') console.warn(`[cnpj-enrichment] timeout em ${cnpj}`);
    else console.error(`[cnpj-enrichment] erro pra ${cnpj}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tag derivada — sinais úteis pra cadência ou handoff.
 * Não decide elegibilidade real (isso é do comitê de crédito).
 */
export function derivaTagsPreToque({ enriquecimento, obra }) {
  const tags = [];
  if (!enriquecimento) { tags.push('sem_enriquecimento'); return tags; }

  if (enriquecimento.situacao_cadastral !== 'ATIVA') tags.push('empresa_inativa');
  if (enriquecimento.tipo_empresa === 'construtora') tags.push('alvo_canteiro');
  if (enriquecimento.tipo_empresa === 'incorporadora') tags.push('alvo_definitivo');
  if (enriquecimento.tipo_empresa === 'ambos') tags.push('alvo_canteiro', 'alvo_definitivo');

  // Proxy de porte: capital social grande sugere empresa de porte médio/grande
  const cap = enriquecimento.capital_social;
  if (cap != null) {
    if (cap >= 10_000_000) tags.push('porte_grande');
    else if (cap >= 1_000_000) tags.push('porte_medio');
    else if (cap > 0) tags.push('porte_pequeno');
  }

  // Proxy via valor da obra
  const v = obra?.valor_investimento;
  if (v != null) {
    if (v >= 100_000_000) tags.push('obra_alto_valor');
    else if (v >= 30_000_000) tags.push('obra_medio_valor');
    else if (v > 0) tags.push('obra_baixo_valor');
  }

  return tags;
}
