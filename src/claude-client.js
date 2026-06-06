// Cliente Claude compartilhado do Lúcio (SDK puro @anthropic-ai/sdk).
//
// Por que não o Claude Agent SDK (`query()`): o agent SDK roda o Claude Code
// inteiro como subprocesso e injeta, em TODA chamada, as definições de todas as
// ferramentas built-in + system do Claude Code. O Lúcio gera só texto, sem usar
// ferramenta nenhuma (allowedTools sempre vazio). Medido em produção: a mesma
// conversa custava ~15k tokens de input pelo agent SDK contra ~2k pelo SDK puro.
// Os ~13k de diferença eram puro overhead de framework. Por isso resposta inbound,
// toque outbound e watchdog usam ESTE helper, não o `query()`.
//
// Extras: prompt caching no system (cache_control ephemeral) + telemetria de
// custo por chamada (tokens, cache read/write e custo USD estimado) logada no
// console — aparece nos logs do Easypanel, que é onde a gente audita gasto.

import Anthropic from '@anthropic-ai/sdk';

export const MODELO_PADRAO = process.env.LUCIO_MODEL || 'claude-haiku-4-5-20251001';

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export function claudeEnabled() {
  return !!client;
}

// Preços USD por 1M tokens. Cache write = janela de 5min (1.25x input).
// Cache read = 0.1x input. Mantém só os modelos que o Lúcio usa; default
// conservador cai no Haiku.
const PRECOS = {
  'claude-haiku-4-5': { in: 1.00, out: 5.00, cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-opus-4': { in: 15.00, out: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
};

function tabelaDePreco(model) {
  const m = String(model || '');
  if (m.includes('sonnet')) return PRECOS['claude-sonnet-4-6'];
  if (m.includes('opus')) return PRECOS['claude-opus-4'];
  return PRECOS['claude-haiku-4-5'];
}

/**
 * Custo USD estimado a partir do usage da API.
 * @param {string} model
 * @param {object} usage - resp.usage da API Anthropic.
 * @returns {number} custo em USD.
 */
export function custoUSD(model, usage) {
  if (!usage) return 0;
  const p = tabelaDePreco(model);
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheW = usage.cache_creation_input_tokens || 0;
  const cacheR = usage.cache_read_input_tokens || 0;
  return (
    (inTok * p.in + outTok * p.out + cacheW * p.cacheWrite + cacheR * p.cacheRead) / 1_000_000
  );
}

/**
 * Gera texto via Claude (SDK puro), com prompt caching no system e telemetria.
 *
 * @param {object} params
 * @param {string} params.system - System prompt (estável; vai com cache_control).
 * @param {string} params.user - Mensagem do usuário (conteúdo variável).
 * @param {string} [params.model] - Override do modelo. Default LUCIO_MODEL/Haiku.
 * @param {number} [params.maxTokens=1024]
 * @param {string} [params.label='claude'] - Rótulo pro log de custo.
 * @returns {Promise<{texto:string, tokensIn:number|null, tokensOut:number|null, cacheRead:number, cacheCreation:number, custoUsd:number, model:string}>}
 */
export async function gerarTexto({ system, user, model, maxTokens = 1024, label = 'claude' }) {
  if (!client) {
    return { texto: '', tokensIn: null, tokensOut: null, cacheRead: 0, cacheCreation: 0, custoUsd: 0, model: model || MODELO_PADRAO };
  }
  const modeloUsado = model || MODELO_PADRAO;

  const resp = await client.messages.create({
    model: modeloUsado,
    max_tokens: maxTokens,
    // System como bloco único com cache_control: o prefixo estável (firmware +
    // estilo) é cacheado por 5min. Chamadas em rajada (campanha, qualificação
    // em sequência) batem no cache e pagam 0.1x no input cacheado.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });

  const texto = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const u = resp.usage || {};
  const custo = custoUSD(modeloUsado, u);

  // Log estruturado de custo — auditável nos logs do Easypanel.
  const cacheR = u.cache_read_input_tokens || 0;
  const cacheW = u.cache_creation_input_tokens || 0;
  console.log(
    `[custo] ${label} model=${modeloUsado} in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} ` +
    `cacheW=${cacheW} cacheR=${cacheR} usd=${custo.toFixed(6)}`
  );

  return {
    texto,
    tokensIn: u.input_tokens ?? null,
    tokensOut: u.output_tokens ?? null,
    cacheRead: cacheR,
    cacheCreation: cacheW,
    custoUsd: custo,
    model: modeloUsado,
  };
}
