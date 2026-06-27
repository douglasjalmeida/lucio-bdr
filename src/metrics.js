// F6 — agregador de métricas pro dashboard.
// Lê transicoes_pipeline + leads + agendamentos_disparos e devolve estrutura
// pronta pra renderizar (KPIs, tempo médio entre etapas, lista detalhada).

import {
  transicoesPorLead,
  listarCadencias,
  listarLeadsPorIds,
} from './supabase-client.js';
import { resolverJanela } from './periodo.js';

// Ordem canônica do funil. Usada pra calcular "etapa atual" do lead (última
// transição com maior rank ou simplesmente a mais recente).
export const FUNIL_ORDEM = [
  'em-cadencia',
  'mql-respondeu',
  'mql-qualificado',
  'humano-atendendo',
  'sql-contato-feito',
  'sql-proposta',
  'sql-negociacao',
  'sql-ganho',
  'sql-perdido',
  'encerrado',
];

// Pra cada lead, agrupa as transições e calcula:
// - etapa_atual (última transição registrada)
// - entrou_etapa_atual_em (criado_em dessa última transição)
// - tempo_no_estagio_atual_ms
// - duracoes: array de { etapa, ms } com tempo passado em cada etapa anterior
function consolidarPorLead(transicoes, agora) {
  const porLead = new Map();
  for (const t of transicoes) {
    if (!porLead.has(t.lead_id)) porLead.set(t.lead_id, []);
    porLead.get(t.lead_id).push(t);
  }

  const consolidados = [];
  for (const [leadId, lista] of porLead) {
    // já vem ordenado asc do supabase-client, mas reforça
    lista.sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
    const duracoes = [];
    for (let i = 0; i < lista.length - 1; i++) {
      const ini = new Date(lista[i].criado_em).getTime();
      const fim = new Date(lista[i + 1].criado_em).getTime();
      duracoes.push({ etapa: lista[i].etapa_para, ms: fim - ini });
    }
    const ultima = lista[lista.length - 1];
    const tempoAtualMs = agora.getTime() - new Date(ultima.criado_em).getTime();
    consolidados.push({
      lead_id: leadId,
      cadencia_id: ultima.cadencia_id,
      etapa_atual: ultima.etapa_para,
      entrou_etapa_atual_em: ultima.criado_em,
      tempo_no_estagio_atual_ms: tempoAtualMs,
      transicoes: lista.map(t => ({
        de: t.etapa_de, para: t.etapa_para, origem: t.origem, em: t.criado_em,
      })),
      duracoes,
    });
  }
  return consolidados;
}

// Agrega tempo médio por etapa (em ms) — média das durações que cada lead
// passou em cada etapa antes de avançar. Etapa terminal (a mais recente do
// lead) NÃO entra na média porque ele ainda está nela.
function tempoMedioPorEtapa(leadsConsolidados) {
  const buckets = new Map(); // etapa → array de ms
  for (const l of leadsConsolidados) {
    for (const d of l.duracoes) {
      if (!buckets.has(d.etapa)) buckets.set(d.etapa, []);
      buckets.get(d.etapa).push(d.ms);
    }
  }
  const out = {};
  for (const [etapa, durs] of buckets) {
    durs.sort((a, b) => a - b);
    const soma = durs.reduce((s, x) => s + x, 0);
    out[etapa] = {
      media_ms: Math.round(soma / durs.length),
      mediana_ms: durs[Math.floor(durs.length / 2)],
      n: durs.length,
    };
  }
  return out;
}

// Distribuição: quantos leads estão atualmente em cada etapa.
function distribuicaoAtual(leadsConsolidados) {
  const out = {};
  for (const etapa of FUNIL_ORDEM) out[etapa] = 0;
  for (const l of leadsConsolidados) {
    out[l.etapa_atual] = (out[l.etapa_atual] || 0) + 1;
  }
  return out;
}

export async function montarMetricas({ periodo = '7d', de = null, ate = null, cadenciaId = null } = {}) {
  const janela = resolverJanela({ periodo, de, ate });
  const agora = new Date();

  // Puxa todas as transições da janela. Pra mostrar etapa_atual de leads que
  // entraram antes da janela mas continuam ativos, também puxamos transições
  // anteriores deles via segunda query — simplificação inicial: só janela.
  // (Trade-off aceitável; dashboard sempre vai mostrar a janela escolhida.)
  const transicoes = await transicoesPorLead({ desde: janela.desde, ate: janela.ate, cadenciaId });
  const leadsConsolidados = consolidarPorLead(transicoes, agora);
  const leadIds = leadsConsolidados.map(l => l.lead_id);
  const leadsInfo = await listarLeadsPorIds(leadIds);
  const leadMap = new Map(leadsInfo.map(l => [l.id, l]));

  const detalhe = leadsConsolidados.map(l => ({
    ...l,
    nome: leadMap.get(l.lead_id)?.nome || '?',
    empresa: leadMap.get(l.lead_id)?.empresa || '',
    telefone: leadMap.get(l.lead_id)?.telefone || '',
    status: leadMap.get(l.lead_id)?.status || '',
    modo: leadMap.get(l.lead_id)?.modo || '',
  }));

  const dist = distribuicaoAtual(leadsConsolidados);
  const tempoMedio = tempoMedioPorEtapa(leadsConsolidados);

  // KPIs no topo
  const totalContatosNaCampanha = leadsConsolidados.length;
  const totalQualificados = leadsConsolidados.filter(l =>
    ['mql-qualificado', 'humano-atendendo', 'sql-contato-feito', 'sql-proposta',
     'sql-negociacao', 'sql-ganho', 'sql-perdido'].includes(l.etapa_atual)
  ).length;
  const totalGanhos = leadsConsolidados.filter(l => l.etapa_atual === 'sql-ganho').length;
  const totalPerdidos = leadsConsolidados.filter(l => l.etapa_atual === 'sql-perdido').length;

  return {
    geradoEm: agora.toISOString(),
    periodo: janela.periodo,
    cadenciaId,
    kpis: {
      total_contatos: totalContatosNaCampanha,
      total_qualificados: totalQualificados,
      total_ganhos: totalGanhos,
      total_perdidos: totalPerdidos,
      taxa_qualificacao_pct: totalContatosNaCampanha
        ? +(totalQualificados / totalContatosNaCampanha * 100).toFixed(1) : 0,
      taxa_conversao_pct: totalContatosNaCampanha
        ? +(totalGanhos / totalContatosNaCampanha * 100).toFixed(1) : 0,
    },
    distribuicao_etapa_atual: dist,
    tempo_medio_por_etapa: tempoMedio,
    leads: detalhe,
  };
}

export async function listarCadenciasParaSeletor() {
  return listarCadencias();
}
