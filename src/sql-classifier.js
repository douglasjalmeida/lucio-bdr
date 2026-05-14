// Classificador SQL contínuo (F5).
// Roda pós-handoff: a cada mensagem nova em conversa com label `humano-atendendo`,
// um Haiku barato olha o histórico recente e decide se a conv avançou pra
// sql-contato-feito → sql-proposta → sql-negociacao → sql-ganho/sql-perdido.
//
// Regras:
// - Só AVANÇA na hierarquia, nunca volta.
// - sql-ganho e sql-perdido são terminais (registra evento e não classifica mais).
// - Não mexe em lead.modo (continua mudo). Só atualiza pipeline no Chatwoot.
// - Debounce por conversationId pra não chamar Haiku a cada msg em rajada.

import Anthropic from '@anthropic-ai/sdk';
import {
  chatwootEnabled, aplicarLabelsAditivo, removerLabels, addNotaPrivada,
} from './chatwoot-client.js';
import { ultimasMensagensDoLead, registrarEvento, registrarTransicao } from './supabase-client.js';

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const MODEL = process.env.LUCIO_SQL_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';
const DEBOUNCE_MS = parseInt(process.env.SQL_CLASSIFIER_DEBOUNCE_MS || '30000', 10);

// Hierarquia de progressão. O classificador SÓ emite até sql-negociacao.
// Terminais (sql-ganho/sql-perdido) são aplicados manualmente pelo closer e,
// se presentes na conv, fazem o classificador parar de rodar.
const SQL_LABELS = ['sql-contato-feito', 'sql-proposta', 'sql-negociacao', 'sql-ganho', 'sql-perdido'];
const ETAPAS_AUTOMATIZADAS = new Set(['sql-contato-feito', 'sql-proposta', 'sql-negociacao']);
const TERMINAIS = new Set(['sql-ganho', 'sql-perdido']);

function rankDeLabel(label) {
  switch (label) {
    case 'sql-contato-feito': return 1;
    case 'sql-proposta':      return 2;
    case 'sql-negociacao':    return 3;
    case 'sql-ganho':         return 4;
    case 'sql-perdido':       return 4;
    default:                  return 0;
  }
}

function labelAtualMaisAvancada(labels) {
  let melhor = null;
  let melhorRank = 0;
  for (const l of labels) {
    if (!SQL_LABELS.includes(l)) continue;
    const r = rankDeLabel(l);
    if (r > melhorRank) { melhorRank = r; melhor = l; }
  }
  return { label: melhor, rank: melhorRank };
}

// Debounce: por convId, segura novas classificações até DEBOUNCE_MS desde a última.
const ultimaClassificacao = new Map(); // convId -> timestamp
function dentroDoDebounce(convId) {
  if (!convId) return false;
  const ts = ultimaClassificacao.get(String(convId));
  if (!ts) return false;
  return (Date.now() - ts) < DEBOUNCE_MS;
}
function marcarClassificado(convId) {
  if (!convId) return;
  const now = Date.now();
  // limpa entradas velhas (> 1h) pra não vazar
  for (const [k, ts] of ultimaClassificacao) if (now - ts > 3_600_000) ultimaClassificacao.delete(k);
  ultimaClassificacao.set(String(convId), now);
}

const SYSTEM = `Você é um classificador de pipeline SQL pra uma operação BDR B2B (Luminus — geradores + MPaaS).

Sua tarefa: olhar uma conversa WhatsApp entre um closer humano e um lead já qualificado (MQL), e dizer em que etapa do funil SQL essa conversa está agora.

Etapas (use exatamente esses nomes):
- "sql-contato-feito": closer e lead alinharam uma interação concreta FUTURA — call agendada, visita marcada, link de Meet/Zoom enviado, horário combinado. Ex: "te mando o link", "ficou pra quinta 14h", "passo aí dia 20", "vou te apresentar a proposta amanhã 14h". Promessa de apresentar/mandar proposta NÃO É sql-proposta — é sql-contato-feito.
- "sql-proposta": closer JÁ ENVIOU proposta/orçamento/valor/PDF formal (verbo no passado, ação concluída). Ex: "segue a proposta anexa", "valor da locação fica R$ X", "te mandei o PDF agora", "acabei de subir o orçamento". Verbo no futuro ("vou mandar", "te mando depois") NÃO conta.
- "sql-negociacao": lead questionou condições da proposta — parcelamento, desconto, prazo, aprovação interna. Ex: "consigo desconto?", "dá pra parcelar?", "preciso aprovar com a diretoria".
- "manter": nada disso aconteceu ainda — conversa só de aproximação, perguntas técnicas iniciais, alinhamento que não cravou nada.

IMPORTANTE: você NÃO classifica fechamento (sql-ganho) nem descarte (sql-perdido). Essas duas etapas são SEMPRE aplicadas manualmente pelo closer humano, porque são decisões caras demais pra automatizar. Mesmo se o lead disser "fechou, pode emitir" ou "vamos com outro fornecedor", você retorna "manter" — quem decide é o closer.

REGRAS:
1. Só classifique baseado em SINAIS EXPLÍCITOS na conversa. Sem inferência otimista.
2. Avança apenas. Se a conv está numa etapa avançada e o trecho recente é só small talk, retorne "manter".
3. Cite no campo "gatilho" o trecho EXATO (até 100 chars) que disparou.

Responda APENAS JSON válido nesse formato (sem markdown, sem comentário):
{
  "etapa": "sql-contato-feito" | "sql-proposta" | "sql-negociacao" | "manter",
  "confianca": "alta" | "media" | "baixa",
  "gatilho": "trecho curto da mensagem que disparou ou vazio se manter"
}`;

function montarHistorico(mensagens) {
  return (mensagens || [])
    .slice(-15)
    .map(m => {
      const autor = m.autor === 'lead' ? 'LEAD'
        : m.autor === 'humano' ? 'CLOSER'
        : m.autor === 'nota_interna' ? 'NOTA-INTERNA'
        : 'LÚCIO';
      return `[${autor}]: ${m.texto}`;
    })
    .join('\n') || '(vazio)';
}

async function classificarComHaiku({ lead, historico }) {
  if (!client) return { etapa: 'manter', motivo_skip: 'ANTHROPIC_API_KEY ausente' };
  const userMsg = `Lead: ${lead?.nome || '?'} | Empresa: ${lead?.empresa || '?'}

Histórico recente da conversa (já em handoff humano):
${historico}

Classifique a etapa atual.`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content?.find(c => c.type === 'text')?.text || '';
    const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      etapa: parsed.etapa || 'manter',
      confianca: parsed.confianca || 'baixa',
      gatilho: parsed.gatilho || '',
      tokensIn: resp.usage?.input_tokens ?? null,
      tokensOut: resp.usage?.output_tokens ?? null,
    };
  } catch (err) {
    console.error('[sql-classifier] erro Haiku:', err.message);
    return { etapa: 'manter', motivo_skip: err.message };
  }
}

async function labelsAtuais(conversationId) {
  // Reaproveita aplicarLabelsAditivo de forma "passiva": GET direto via fetch
  // não exposto; usamos um truque — chamar com [] não funciona (sobrescreve).
  // Então fazemos GET manual via call interno do chatwoot-client? Não exposto.
  // Workaround: aplicar [] resetaria. Em vez disso, exportei nada de GET de labels.
  // Vou usar o endpoint /labels via fetch direto aqui.
  const BASE_URL = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
  const TOKEN = process.env.CHATWOOT_API_TOKEN || '';
  const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '';
  if (!BASE_URL || !TOKEN || !ACCOUNT_ID || !conversationId) return [];
  const r = await fetch(`${BASE_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/labels`, {
    headers: { 'api_access_token': TOKEN },
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  return j?.payload || [];
}

// Aplica a transição: remove labels SQL anteriores, aplica a nova, escreve nota privada.
async function aplicarTransicao({ conversationId, labelAtual, labelNova, gatilho, confianca }) {
  const aRemover = SQL_LABELS.filter(l => l !== labelNova && l !== labelAtual);
  // Se labelAtual existe e é diferente da nova, também remove
  if (labelAtual && labelAtual !== labelNova) aRemover.push(labelAtual);
  if (aRemover.length) {
    try { await removerLabels(conversationId, aRemover); }
    catch (err) { console.error('[sql-classifier] erro removendo labels antigas:', err.message); }
  }
  try { await aplicarLabelsAditivo(conversationId, [labelNova]); }
  catch (err) { console.error('[sql-classifier] erro aplicando label nova:', err.message); }

  const nota = [
    `📈 Pipeline avançado: \`${labelNova}\``,
    labelAtual ? `_de \`${labelAtual}\`_` : `_de \`mql-qualificado\`_`,
    ``,
    `*Gatilho:* "${gatilho || '(sem trecho citado)'}"`,
    `*Confiança:* ${confianca || '-'}`,
    `_classificador automático (Haiku)_`,
  ].join('\n');
  try { await addNotaPrivada(conversationId, nota); }
  catch (err) { console.error('[sql-classifier] erro escrevendo nota:', err.message); }
}

// Normaliza labels SQL: dado que a conv tem N labels sql-* aplicadas, mantém só
// a mais avançada (rank maior) e remove as anteriores. Idempotente — se já está
// normalizada, no-op. Chamado quando closer aplica label manualmente no Chatwoot
// (ex: mandou proposta por email e aplica sql-proposta na mão, queremos que
// sql-contato-feito saia automaticamente).
//
// Também marca terminal (ganho/perdido) como label mais avançada se presente,
// porque closer venceu/perdeu a venda e queremos limpar o caminho.
export async function normalizarLabelsSqlSeNecessario({ conversationId, leadId = null }) {
  if (!chatwootEnabled() || !conversationId) return { skipped: true, reason: 'sem-contexto' };

  let labels;
  try { labels = await labelsAtuais(conversationId); }
  catch (err) { return { skipped: true, reason: 'erro-labels', erro: err.message }; }

  const sqlPresentes = labels.filter(l => SQL_LABELS.includes(l));
  if (sqlPresentes.length < 2) return { skipped: true, reason: 'nada-a-normalizar', sqlPresentes };

  // Mais avançada por rank. Empate terminal (ganho/perdido) é descartado — não
  // tratamos, closer deve aplicar só uma das duas.
  let melhor = sqlPresentes[0];
  for (const l of sqlPresentes) if (rankDeLabel(l) > rankDeLabel(melhor)) melhor = l;

  const aRemover = sqlPresentes.filter(l => l !== melhor);
  if (!aRemover.length) return { skipped: true, reason: 'ja-normalizado' };

  try {
    await removerLabels(conversationId, aRemover);
    console.log(`[sql-classifier] normalização: convId=${conversationId} mantém ${melhor}, remove ${aRemover.join(',')}`);
  } catch (err) {
    console.error('[sql-classifier] erro normalizando labels:', err.message);
    return { skipped: true, reason: 'erro-remove', erro: err.message };
  }

  // Registra evento + transição pra rastreabilidade (manual ou automático).
  if (leadId) {
    try {
      await registrarEvento(leadId, 'sql_pipeline_normalizado', {
        mantida: melhor,
        removidas: aRemover,
        origem: 'manual-ou-auto',
      });
      // A label "melhor" pode ser sql-ganho ou sql-perdido aplicada manual pelo
      // closer — esse é o único caminho pra essas etapas entrarem no dashboard.
      await registrarTransicao(leadId, aRemover[aRemover.length - 1] || null, melhor, 'manual');
    } catch (err) {
      console.error('[sql-classifier] erro registrando evento/transição:', err.message);
    }
  }

  return { ok: true, mantida: melhor, removidas: aRemover };
}

// Entry point. Chamado pelo server após mensagem do lead OU do closer em conv pós-handoff.
// Idempotente, com debounce. Não bloqueia o fluxo do bridge — chamar sem await.
export async function classificarSqlSeAplicavel({ lead, conversationId }) {
  if (!chatwootEnabled() || !conversationId || !lead) return { skipped: true, reason: 'sem-contexto' };
  if (lead.modo !== 'mudo') return { skipped: true, reason: 'lead-nao-em-handoff' };
  if (dentroDoDebounce(conversationId)) return { skipped: true, reason: 'debounce' };

  let labels;
  try { labels = await labelsAtuais(conversationId); }
  catch (err) { return { skipped: true, reason: 'erro-labels', erro: err.message }; }

  // Já terminal — não classifica mais.
  if (labels.some(l => TERMINAIS.has(l))) {
    return { skipped: true, reason: 'ja-terminal', terminal: labels.find(l => TERMINAIS.has(l)) };
  }
  // Só roda se humano-atendendo está presente (defesa adicional).
  if (!labels.includes('humano-atendendo')) {
    return { skipped: true, reason: 'sem-label-humano-atendendo' };
  }

  marcarClassificado(conversationId);

  const historico = await ultimasMensagensDoLead(lead.id, 20).catch(() => []);
  const histTexto = montarHistorico(historico);

  const cls = await classificarComHaiku({ lead, historico: histTexto });
  if (cls.etapa === 'manter') return { skipped: true, reason: 'manter', cls };

  // Guard rail: classificador NUNCA aplica terminais (ganho/perdido). Closer faz manual.
  if (!ETAPAS_AUTOMATIZADAS.has(cls.etapa)) {
    return { skipped: true, reason: 'etapa-nao-automatizada', proposta: cls.etapa };
  }

  const novaLabel = cls.etapa;
  const novoRank = rankDeLabel(novaLabel);
  const { label: labelAtual, rank: rankAtual } = labelAtualMaisAvancada(labels);

  // Monotonicidade: só avança. Empate (mesmo rank) ignora.
  if (novoRank <= rankAtual) {
    return { skipped: true, reason: 'nao-avanca', proposta: novaLabel, atual: labelAtual };
  }
  if (cls.confianca === 'baixa') {
    return { skipped: true, reason: 'confianca-baixa', proposta: novaLabel };
  }

  await aplicarTransicao({
    conversationId, labelAtual, labelNova: novaLabel,
    gatilho: cls.gatilho, confianca: cls.confianca,
  });

  // Registra evento no Supabase.
  try {
    await registrarEvento(lead.id, 'sql_pipeline_avancado', {
      de: labelAtual || 'mql-qualificado',
      para: novaLabel,
      gatilho: cls.gatilho,
      confianca: cls.confianca,
      tokensIn: cls.tokensIn,
      tokensOut: cls.tokensOut,
    });
    await registrarTransicao(lead.id, labelAtual || 'humano-atendendo', novaLabel, 'auto', {
      gatilho: cls.gatilho, confianca: cls.confianca,
    });
  } catch (err) {
    console.error('[sql-classifier] erro registrando evento/transição:', err.message);
  }

  console.log(`[sql-classifier] lead=${lead.id} ${labelAtual || 'mql-qualificado'} → ${novaLabel} (conf=${cls.confianca})`);
  return { ok: true, de: labelAtual, para: novaLabel, cls };
}
