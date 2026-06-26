// Dados das abas Tráfego e Bruno do dashboard (F6).
//
// Lê do MESMO Supabase CMO (ebjeylhossntyeccmujn) que o resto da bridge, via
// service role (ignora RLS). A aba Lúcio é servida pelo metrics.js / endpoints
// já existentes — aqui ficam só as duas abas novas.
//
// Portado de claudio-dashboard/src/lib/queries-{trafego,bruno}.ts.

import { supabase } from './supabase-client.js';

// ─── Tráfego (snapshot da Meta) ─────────────────────────────────────────────
// Lê o snapshot mais recente de `trafego_snapshots`. snapshot === null =>
// "sem dado de tráfego ainda" (estado, não erro). Erro real => lança.
export async function getSnapshotTrafego() {
  const { data, error } = await supabase
    .from('trafego_snapshots')
    .select('*')
    .order('capturado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const criativos = Array.isArray(data.criativos) ? data.criativos : [];
  return { ...data, criativos };
}

// ─── SLA 2h (leads qualificados que estouraram e viraram lembrete) ──────────
// Conta `sla_alertas` (espelho da datatable n8n sla_leads_notificados) por
// janela: hoje (00:00 America/Sao_Paulo), últimos 7 dias e total acumulado.
// Fonte = o que o WF de SLA realmente notificou (não recalcula do Chatwoot).
function inicioDoDiaSaoPauloISO(agora = new Date()) {
  // BR é UTC-3 fixo (sem horário de verão desde 2019). 00:00 BR = 03:00 UTC.
  const br = new Date(agora.getTime() - 3 * 3600 * 1000);
  const y = br.getUTCFullYear();
  const m = String(br.getUTCMonth() + 1).padStart(2, '0');
  const d = String(br.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T03:00:00.000Z`;
}

export async function getSlaAlertas() {
  const agora = new Date();
  const inicioHoje = inicioDoDiaSaoPauloISO(agora);
  const seteDias = new Date(agora.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  const contar = async (desde) => {
    let q = supabase.from('sla_alertas').select('*', { count: 'exact', head: true });
    if (desde) q = q.gte('notificado_em', desde);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  };

  const [hoje, ultimos7d, total] = await Promise.all([
    contar(inicioHoje),
    contar(seteDias),
    contar(null),
  ]);
  return { hoje, ultimos7d, total };
}

// ─── Bruno (funil inbound) ──────────────────────────────────────────────────
// Funil derivado de eventos (verdade do que aconteceu), via count exato sem
// trazer linha.
export async function getFunilBruno() {
  const contar = async (tabela, filtro) => {
    let q = supabase.from(tabela).select('*', { count: 'exact', head: true });
    if (filtro) q = q.eq(filtro.coluna, filtro.valor);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  };

  const [leads, qualificados, handoffs, followupsAbertos, followupsEnviados, semResposta] =
    await Promise.all([
      contar('bruno_leads'),
      contar('bruno_eventos', { coluna: 'tipo', valor: 'qualificado' }),
      contar('bruno_eventos', { coluna: 'tipo', valor: 'handoff_solicitado' }),
      contar('bruno_agendamentos_followup', { coluna: 'status', valor: 'pendente' }),
      contar('bruno_agendamentos_followup', { coluna: 'status', valor: 'enviado' }),
      contar('bruno_leads', { coluna: 'stage', valor: 'no_response' }),
    ]);

  return { leads, qualificados, handoffs, followupsAbertos, followupsEnviados, semResposta };
}

// Ordem canônica do funil do Bruno (inbound). Stages fora dessa lista entram no
// fim, na ordem que aparecerem.
const BRUNO_STAGES = [
  'novo', 'aguardando_followup', 'reengajando', 'qualificado', 'handoff',
  'no_response', 'devolvido_bot', 'encerrado',
];

const BRUNO_STAGE_LABEL = {
  novo: 'Novo', aguardando_followup: 'Aguardando follow-up', reengajando: 'Reengajando',
  qualificado: 'Qualificado', handoff: 'Handoff', no_response: 'Sem resposta',
  devolvido_bot: 'Devolvido ao bot', encerrado: 'Encerrado',
};
const stageLabel = (s) => (s ? BRUNO_STAGE_LABEL[s] || s : null);

// Dados ricos da aba Bruno (espelham o painel do Lúcio):
// - distribuicao: leads por etapa + tempo médio parado (SLA)
// - leads: cada lead com tempo na etapa atual + timeline de eventos, desc por tempo
// - mensagens: toques enviados (mais recentes primeiro)
//
// "Tempo na etapa atual" usa atualizado_em (marca a última mudança de etapa do
// lead) como entrada na etapa. Não há tabela de transições no Bruno como no
// Lúcio; a timeline detalhada vem de bruno_eventos.
export async function getBrunoDashboard() {
  const agora = Date.now();
  const [leadsRes, eventosRes, transRes, msgsRes] = await Promise.all([
    supabase
      .from('bruno_leads')
      .select('id, nome, empresa, telefone, stage, criado_em, atualizado_em'),
    supabase
      .from('bruno_eventos')
      .select('lead_id, tipo, criado_em')
      .order('criado_em', { ascending: true }),
    supabase
      .from('bruno_transicoes')
      .select('lead_id, etapa_de, etapa_para, criado_em')
      .order('criado_em', { ascending: true }),
    supabase
      .from('bruno_mensagens')
      .select('lead_id, autor, texto, toque, enviada_em')
      .eq('direcao', 'out')
      .order('enviada_em', { ascending: false })
      .limit(80),
  ]);
  if (leadsRes.error) throw leadsRes.error;
  if (eventosRes.error) throw eventosRes.error;
  if (transRes.error) throw transRes.error;
  if (msgsRes.error) throw msgsRes.error;

  const leads = leadsRes.data ?? [];
  const eventos = eventosRes.data ?? [];
  const transicoes = transRes.data ?? [];
  const msgs = msgsRes.data ?? [];

  // Timeline de eventos por lead (fallback pros leads sem transições).
  const evPorLead = new Map();
  for (const e of eventos) {
    if (!evPorLead.has(e.lead_id)) evPorLead.set(e.lead_id, []);
    evPorLead.get(e.lead_id).push({ resumo: rotuloEvento(e.tipo), em: e.criado_em });
  }

  // Transições de etapa por lead (verdade do "entrou na etapa X às Y").
  const transPorLead = new Map();
  for (const t of transicoes) {
    if (!transPorLead.has(t.lead_id)) transPorLead.set(t.lead_id, []);
    transPorLead.get(t.lead_id).push(t);
  }

  // Leads detalhados, ordenados por tempo na etapa (mais parado primeiro = SLA).
  // Quando há transições (leads novos), o tempo na etapa e a timeline vêm delas
  // (precisas); senão cai no fallback atualizado_em + eventos (leads antigos).
  const leadsDetalhe = leads
    .map((l) => {
      const trs = transPorLead.get(l.id) || [];
      let entrou;
      let timeline;
      if (trs.length) {
        entrou = trs[trs.length - 1].criado_em;
        timeline = trs.map((t) => ({
          resumo: `${stageLabel(t.etapa_de) || 'entrada'} → ${stageLabel(t.etapa_para)}`,
          em: t.criado_em,
        }));
      } else {
        entrou = l.atualizado_em || l.criado_em;
        timeline = evPorLead.get(l.id) ?? [];
      }
      return {
        nome: l.nome,
        empresa: l.empresa,
        telefone: l.telefone,
        stage: l.stage,
        entrou_em: entrou,
        tempo_no_estagio_ms: agora - new Date(entrou).getTime(),
        eventos: timeline,
      };
    })
    .sort((a, b) => b.tempo_no_estagio_ms - a.tempo_no_estagio_ms);

  // Distribuição por etapa + tempo médio parado (SLA agregado).
  const porStage = new Map();
  for (const l of leadsDetalhe) {
    if (!porStage.has(l.stage)) porStage.set(l.stage, []);
    porStage.get(l.stage).push(l.tempo_no_estagio_ms);
  }
  const extras = [...porStage.keys()].filter((s) => !BRUNO_STAGES.includes(s));
  const distribuicao = [...BRUNO_STAGES, ...extras]
    .filter((s) => porStage.has(s))
    .map((stage) => {
      const arr = porStage.get(stage);
      return {
        stage,
        n: arr.length,
        tempo_medio_ms: Math.round(arr.reduce((s, x) => s + x, 0) / arr.length),
      };
    });

  // Mensagens enviadas (toques) — join nome/telefone do lead.
  const leadMap = new Map(leads.map((l) => [l.id, l]));
  const mensagens = msgs.map((m) => ({
    nome: leadMap.get(m.lead_id)?.nome || '—',
    telefone: leadMap.get(m.lead_id)?.telefone || '',
    autor: m.autor,
    toque: m.toque,
    texto: m.texto,
    enviada_em: m.enviada_em,
  }));

  return { distribuicao, leads: leadsDetalhe, mensagens };
}

function rotuloEvento(tipo) {
  const mapa = {
    lead_novo: 'Lead novo',
    qualificado: 'Lead qualificado',
    handoff_solicitado: 'Handoff pro humano',
    followup_agendado: 'Follow-up agendado',
    followup_enviado: 'Follow-up enviado',
    reengajou: 'Lead reengajou',
    devolvido_bot: 'Devolvido ao bot',
    no_response: 'Sem resposta',
  };
  return mapa[tipo] ?? tipo;
}
