// Motor de análise de temperatura de lead.
//
// Lê o histórico de mensagens de um lead e produz uma leitura estruturada
// (temperatura QUENTE/MORNO/FRIO + ICP + categoria + NOAT + estágio de cadência
// + justificativa + score 0-100 pra ordenação). Espelha o padrão do qualifier.js:
// system constante (cacheável) + user variável, Haiku via SDK puro.
//
// Decisões de projeto:
// - O LLM devolve SÓ categóricos. O SCORE é calculado AQUI, em JS — aritmética
//   não é confiável no modelo e o score precisa ser auditável/determinístico.
// - Pesos derivados da doc canônica A01 (02-doc-estruturado.md) + processo oficial
//   (bruno-vs-processo-oficial.md). Ver tabela PESOS_* abaixo, cada peso citando a regra.
// - Persistência em `eventos` (tipo='lead_temperatura'), SEM migração de schema.
//   Histórico temporal grátis (cada análise é uma linha nova).
// - Gate "só reanalisa se houver mensagem nova": compara a data da última mensagem
//   com criado_em do último evento. Sem mensagem nova → reusa (zero token).

import { gerarTexto, claudeEnabled } from './claude-client.js';
import {
  supabase,
  supabaseEnabled,
  registrarEvento,
  ultimasMensagensDoLead,
  listarLeadsPorIds,
} from './supabase-client.js';

const MODEL = process.env.LUCIO_TEMP_MODEL || 'claude-haiku-4-5-20251001';
const TIPO_EVENTO = 'lead_temperatura';

// ─── Pesos do score (0-100), ancorados na doc canônica ───────────────────────
// ICP: A01 l.263 "ICP Perfeito ou Bom → prioridade máxima"; l.19 "FORA é arquivado".
const PESO_ICP = { PERFEITO: 35, BOM: 25, MEDIANO: 10, RUIM: 0 };
// Temperatura: A01 l.264-265 "Quente ou Morno → mesmo dia útil, prioridade máxima".
const PESO_TEMP = { QUENTE: 35, MORNO: 25, FRIO: 5 };
// Prazo: A01 l.476 exemplo "prazo 30 dias → Quente".
const PESO_PRAZO = { imediato: 20, curto: 15, medio: 8, longo: 2, indefinido: 0 };
// Categoria: bruno-vs l.67 "Oportunidade Real · Nutrição · Descartado".
const MULT_CATEGORIA = { 'Oportunidade Real': 1.0, 'Nutrição': 0.6, 'Descartado': 0 };
// NOAT: A01 l.376 "noat_completo (bool)" — completude pontua até 10.
const PESO_NOAT = { 4: 10, 3: 7, 2: 4, 1: 0, 0: 0 };

// Mapa ICP dual (governança Bruno usa CORE/ADJACENTE/FORA; A01 usa PERFEITO/BOM/…).
const NORMALIZA_ICP = {
  CORE: 'PERFEITO', ADJACENTE: 'BOM', FORA: 'RUIM',
  PERFEITO: 'PERFEITO', BOM: 'BOM', MEDIANO: 'MEDIANO', RUIM: 'RUIM',
};

const SYSTEM = `Você é o analisador de temperatura de leads BDR da Luminus (geradores + MPaaS, energia crítica B2B).

Tarefa: ler uma conversa WhatsApp entre o BDR Lúcio e um lead e classificar o lead em eixos canônicos. Você NÃO calcula nota numérica — só classifica os eixos abaixo. Seja conservador: na dúvida, classifique pra baixo (FRIO/MEDIANO).

EIXOS:

1) temperatura — quão pronto pra avançar o lead está:
   - QUENTE: dor concreta + urgência clara (já caiu energia, prejuízo, prazo curto) OU pediu preço/proposta/visita/humano.
   - MORNO: interesse real mas sem urgência travada; conversa engajada, ainda avaliando.
   - FRIO: sem sinal de dor/urgência; monossílabos, curiosidade genérica, ou sem resposta.

2) classificacao_icp — aderência ao cliente ideal (porte, segmento crítico, ticket):
   - PERFEITO: segmento crítico (hospital, indústria, data center, porto, hotel) + porte M/G/estratégico.
   - BOM: aderente mas adjacente (comércio grande, condomínio grande, obra/construtora).
   - MEDIANO: pouco aderente (residencial, pequeno porte) mas plausível.
   - RUIM: fora do perfil (sem fit de produto/região/ticket).

3) categoria — destino do lead:
   - "Oportunidade Real": tem fit + sinal de avanço.
   - "Nutrição": fit mas sem timing; manter aquecendo.
   - "Descartado": sem interesse, pediu pra sair, ou fora total do perfil.

4) noat — extraia o que a conversa revelar (string curta; use "nao informado" se ausente):
   - necessidade: o que precisa (locação/venda/manutenção/obra + potência se disser).
   - orcamento: verba (aprovada/em aprovação/sem verba/nao informado).
   - autoridade: decisor/influenciador/usuario/nao informado.
   - tempo: prazo (imediato/curto/medio/longo + detalhe se houver).

5) faixa_prazo — normalize o tempo em UMA palavra: imediato (≤7d) | curto (≤30d) | medio (31-90d) | longo (>90d) | indefinido.

6) estagio_cadencia — onde está no ciclo: ACTIVE | WARMING | NURTURING | REENGAGED | ARCHIVED | WON | LOST.

7) justificativa — UMA frase curta explicando a classificação.

Responda APENAS JSON válido nesse formato exato (sem markdown, sem comentário):
{
  "temperatura": "QUENTE|MORNO|FRIO",
  "classificacao_icp": "PERFEITO|BOM|MEDIANO|RUIM",
  "categoria": "Oportunidade Real|Nutrição|Descartado",
  "noat": { "necessidade": "", "orcamento": "", "autoridade": "", "tempo": "" },
  "faixa_prazo": "imediato|curto|medio|longo|indefinido",
  "estagio_cadencia": "ACTIVE|WARMING|NURTURING|REENGAGED|ARCHIVED|WON|LOST",
  "justificativa": ""
}`;

// ─── Score em JS (determinístico, auditável) ─────────────────────────────────

function noatPreenchidos(noat) {
  if (!noat || typeof noat !== 'object') return 0;
  const vazio = v => !v || /^(nao informado|não informado|n\/a|-|)$/i.test(String(v).trim());
  return ['necessidade', 'orcamento', 'autoridade', 'tempo'].filter(k => !vazio(noat[k])).length;
}

/**
 * Calcula o score 0-100 a partir dos categóricos.
 * score = (ICP + TEMP + PRAZO + NOAT) × MULT_CATEGORIA. Clampa 0-100.
 */
export function calcularScore({ temperatura, classificacao_icp, faixa_prazo, categoria, noat } = {}) {
  const icp = NORMALIZA_ICP[String(classificacao_icp || '').toUpperCase()] || 'RUIM';
  const temp = String(temperatura || '').toUpperCase();
  const prazo = String(faixa_prazo || 'indefinido').toLowerCase();
  const base =
    (PESO_ICP[icp] ?? 0) +
    (PESO_TEMP[temp] ?? 5) +
    (PESO_PRAZO[prazo] ?? 0) +
    (PESO_NOAT[noatPreenchidos(noat)] ?? 0);
  const mult = MULT_CATEGORIA[categoria] ?? 0.6;
  const score = Math.round(base * mult);
  return Math.max(0, Math.min(100, score));
}

// Normaliza/valida a saída do LLM pros enums conhecidos (guards defensivos).
function normalizarSaida(parsed) {
  const temp = String(parsed?.temperatura || '').toUpperCase();
  const icp = String(parsed?.classificacao_icp || '').toUpperCase();
  const noat = {
    necessidade: parsed?.noat?.necessidade || 'nao informado',
    orcamento: parsed?.noat?.orcamento || 'nao informado',
    autoridade: parsed?.noat?.autoridade || 'nao informado',
    tempo: parsed?.noat?.tempo || 'nao informado',
  };
  const out = {
    temperatura: PESO_TEMP[temp] !== undefined ? temp : 'FRIO',
    classificacao_icp: NORMALIZA_ICP[icp] || 'RUIM',
    categoria: MULT_CATEGORIA[parsed?.categoria] !== undefined ? parsed.categoria : 'Nutrição',
    noat,
    faixa_prazo: PESO_PRAZO[String(parsed?.faixa_prazo || '').toLowerCase()] !== undefined
      ? String(parsed.faixa_prazo).toLowerCase() : 'indefinido',
    estagio_cadencia: parsed?.estagio_cadencia || 'ACTIVE',
    justificativa: parsed?.justificativa || '',
  };
  out.score = calcularScore(out);
  return out;
}

function histToTexto(historico) {
  return (historico || [])
    .slice(-30)
    .map(m => `[${m.autor === 'lead' ? 'LEAD' : (m.autor === 'humano' ? 'HUMANO' : 'LÚCIO')}]: ${m.texto}`)
    .join('\n') || '(vazio)';
}

// ─── Leitura de eventos persistidos (read-only) ──────────────────────────────

/**
 * Último evento de temperatura de um lead (ou null). Retorna o payload + criado_em.
 */
export async function lerUltimaTemperatura(lead_id) {
  if (!supabaseEnabled()) return null;
  const { data, error } = await supabase
    .from('eventos')
    .select('payload_json, criado_em')
    .eq('tipo', TIPO_EVENTO)
    .eq('lead_id', lead_id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.error('[temperatura] lerUltima erro:', error.message); return null; }
  if (!data) return null;
  return { ...(data.payload_json || {}), criado_em: data.criado_em };
}

/**
 * Lista a temperatura mais recente de cada lead, ordenada por score desc.
 * Read-only: lê eventos existentes e faz dedupe por lead em JS (first-wins =
 * mais recente, graças ao order criado_em desc). Nunca dispara análise.
 * @returns {Promise<Array>} linhas prontas pro dashboard.
 */
export async function listarTemperaturas({ limite = 500 } = {}) {
  if (!supabaseEnabled()) return [];
  const { data, error } = await supabase
    .from('eventos')
    .select('lead_id, payload_json, criado_em')
    .eq('tipo', TIPO_EVENTO)
    .order('criado_em', { ascending: false })
    .limit(limite);
  if (error) { console.error('[temperatura] listar erro:', error.message); return []; }

  // Dedupe por lead_id (first-wins = mais recente).
  const porLead = new Map();
  for (const ev of data || []) {
    if (ev.lead_id == null || porLead.has(ev.lead_id)) continue;
    porLead.set(ev.lead_id, ev);
  }

  // Join com leads pra nome/empresa/telefone.
  const ids = [...porLead.keys()];
  const leads = await listarLeadsPorIds(ids);
  const leadById = new Map(leads.map(l => [l.id, l]));

  const linhas = [...porLead.values()].map(ev => {
    const p = ev.payload_json || {};
    const l = leadById.get(ev.lead_id) || {};
    return {
      lead_id: ev.lead_id,
      nome: l.nome || '',
      empresa: l.empresa || '',
      telefone: l.telefone || '',
      status: l.status || '',
      cadencia_id: l.cadencia_id || null,
      temperatura: p.temperatura || 'FRIO',
      classificacao_icp: p.classificacao_icp || 'RUIM',
      categoria: p.categoria || '',
      estagio_cadencia: p.estagio_cadencia || '',
      justificativa: p.justificativa || '',
      noat: p.noat || null,
      faixa_prazo: p.faixa_prazo || 'indefinido',
      score: Number(p.score) || 0,
      analisado_em: ev.criado_em,
    };
  });

  linhas.sort((a, b) => b.score - a.score);
  return linhas;
}

// ─── Análise (escrita) ───────────────────────────────────────────────────────

/**
 * Analisa a temperatura de UM lead. On-demand, 1 lead por vez (nunca num loop
 * de request HTTP — isso seria N+1 de custo). Persiste em `eventos`.
 *
 * @param {object} lead - {id, nome, empresa, segmento, cadencia_id, ...}
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - reanalisa mesmo sem mensagem nova.
 * @returns {Promise<object>} a leitura (com score) + flags reused/persisted.
 */
export async function analisarTemperatura(lead, { force = false } = {}) {
  if (!lead?.id) return { erro: 'lead sem id' };

  const historico = await ultimasMensagensDoLead(lead.id, 30).catch(err => {
    console.error('[temperatura] erro lendo histórico:', err.message);
    return [];
  });
  const maxMsgTs = historico.length ? historico[historico.length - 1].enviada_em : null;
  const ultimoEvento = await lerUltimaTemperatura(lead.id);

  // Gate: sem mensagem nova desde a última análise → reusa (zero token/custo).
  const semNovidade = ultimoEvento && (!maxMsgTs || new Date(maxMsgTs) <= new Date(ultimoEvento.criado_em));
  if (!force && semNovidade) {
    return { ...ultimoEvento, reused: true, persisted: false };
  }

  // Sem histórico: curto-circuita sem LLM (FRIO, score baixo).
  if (!historico.length) {
    const resultado = normalizarSaida({
      temperatura: 'FRIO', classificacao_icp: 'RUIM', categoria: 'Nutrição',
      faixa_prazo: 'indefinido', estagio_cadencia: 'ACTIVE',
      justificativa: 'Sem histórico de mensagens.',
    });
    await registrarEvento(lead.id, TIPO_EVENTO, resultado).catch(e => console.error('[temperatura] persist erro:', e.message));
    return { ...resultado, reused: false, persisted: true, sem_historico: true };
  }

  if (!claudeEnabled()) {
    return { erro: 'ANTHROPIC_API_KEY ausente', reused: false, persisted: false };
  }

  const userMsg = `Lead: ${lead?.nome || '?'} | Empresa: ${lead?.empresa || '?'} | Segmento: ${lead?.segmento || '?'} | Cadência: ${lead?.cadencia_id || '?'}

Histórico (cronológico):
${histToTexto(historico)}

Classifique agora.`;

  try {
    const { texto, custoUsd, cacheRead } = await gerarTexto({
      system: SYSTEM,
      user: userMsg,
      model: MODEL,
      maxTokens: 500,
      label: 'temperatura',
    });
    const cleaned = texto.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const resultado = normalizarSaida(parsed);
    await registrarEvento(lead.id, TIPO_EVENTO, resultado).catch(e => console.error('[temperatura] persist erro:', e.message));
    return { ...resultado, reused: false, persisted: true, custoUsd, cacheRead };
  } catch (err) {
    console.error('[temperatura] erro:', err.message);
    return { erro: err.message, reused: false, persisted: false };
  }
}
