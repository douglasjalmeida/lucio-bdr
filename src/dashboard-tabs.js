// Dados das abas Tráfego e Bruno do dashboard (F6).
//
// Lê do MESMO Supabase CMO (ebjeylhossntyeccmujn) que o resto da bridge, via
// service role (ignora RLS). A aba Lúcio é servida pelo metrics.js / endpoints
// já existentes — aqui ficam só as duas abas novas.
//
// Portado de claudio-dashboard/src/lib/queries-{trafego,bruno}.ts.

import { supabase } from './supabase-client.js';

// ─── Tráfego (snapshot da Meta) ─────────────────────────────────────────────
// Lê o snapshot de `trafego_snapshots` que melhor cobre a janela escolhida.
// snapshot === null => "sem dado de tráfego ainda" (estado, não erro).
//
// O snapshot é SEMANAL e manual, então a granularidade quase nunca bate com a
// janela do seletor. Regra (não inventa número): pega o snapshot mais recente
// cuja janela semanal cruza a janela escolhida; se nenhum cruzar, cai no mais
// recente de todos e marca `fora_da_janela` pro front avisar. Sem janela
// (desde=null) => snapshot mais recente (comportamento legado).
export async function getSnapshotTrafego({ desde = null, ate = null } = {}) {
  if (!desde) {
    const { data, error } = await supabase
      .from('trafego_snapshots')
      .select('*')
      .order('capturado_em', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? normalizarSnapshot(data, false) : null;
  }

  // janela_inicio / janela_fim são colunas `date`; comparo pela data de
  // CALENDÁRIO em BR (UTC-3). Não dá pra fatiar o ISO cru: 23:59 BR vira 02:59
  // UTC do dia seguinte e vazaria a data do fim pro próximo dia (casaria snapshot
  // fora da janela). Por isso desloco -3h antes de pegar a data.
  const dataBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const desdeData = dataBR(desde);
  const ateData = dataBR(ate || new Date().toISOString());

  // Overlap: janela_inicio <= ate E janela_fim >= desde. Mais recente captura.
  const { data: dentro, error: e1 } = await supabase
    .from('trafego_snapshots')
    .select('*')
    .lte('janela_inicio', ateData)
    .gte('janela_fim', desdeData)
    .order('capturado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (e1) throw e1;
  if (dentro) return normalizarSnapshot(dentro, false);

  // Nenhum snapshot cobre a janela => mostra o mais recente, marcado fora dela.
  const { data: ultimo, error: e2 } = await supabase
    .from('trafego_snapshots')
    .select('*')
    .order('capturado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (e2) throw e2;
  return ultimo ? normalizarSnapshot(ultimo, true) : null;
}

// `por_regiao` pode não existir ainda (coluna nova) => vira [] (estado vazio
// honesto no front, sem quebrar).
function normalizarSnapshot(data, foraDaJanela) {
  const criativos = Array.isArray(data.criativos) ? data.criativos : [];
  const por_regiao = Array.isArray(data.por_regiao) ? data.por_regiao : [];
  return { ...data, criativos, por_regiao, fora_da_janela: foraDaJanela };
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
// trazer linha. Respeita a janela do seletor global filtrando cada tabela pela
// SUA marca de tempo natural (bruno_leads/eventos por criado_em; followup
// enviado por enviado_em). "Follow-ups abertos" é estado atual (pendente AGORA),
// então não filtra por janela de propósito.
export async function getFunilBruno({ desde = null, ate = null } = {}) {
  const contar = async (tabela, coluna, filtro = null) => {
    let q = supabase.from(tabela).select('*', { count: 'exact', head: true });
    if (filtro) q = q.eq(filtro.coluna, filtro.valor);
    if (coluna && desde) q = q.gte(coluna, desde);
    if (coluna && ate) q = q.lte(coluna, ate);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  };

  const [leads, qualificados, handoffs, followupsAbertos, followupsEnviados, semResposta] =
    await Promise.all([
      contar('bruno_leads', 'criado_em'),
      contar('bruno_eventos', 'criado_em', { coluna: 'tipo', valor: 'qualificado' }),
      contar('bruno_eventos', 'criado_em', { coluna: 'tipo', valor: 'handoff_solicitado' }),
      contar('bruno_agendamentos_followup', null, { coluna: 'status', valor: 'pendente' }),
      contar('bruno_agendamentos_followup', 'enviado_em', { coluna: 'status', valor: 'enviado' }),
      contar('bruno_leads', 'criado_em', { coluna: 'stage', valor: 'no_response' }),
    ]);

  return { leads, qualificados, handoffs, followupsAbertos, followupsEnviados, semResposta };
}

// ─── Potência de gerador mais solicitada (Incremento C) ─────────────────────
// Normaliza kVA sujo: "180", "180kva", "180 KVA", "180 kVA" => 180.
// Faixas ("20-30", "15 a 25") e múltiplos ("50 e 100") viram rótulo próprio —
// NÃO inventa um número único. Sem dígito => null (= "não informado").
export function normalizaKva(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase()
    .replace(/kva|kw|kv/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const achados = s.match(/\d+(?:[.,]\d+)?/g);
  if (!achados) return null;
  const vals = achados
    .map((n) => Math.round(parseFloat(n.replace(',', '.'))))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!vals.length) return null;
  if (vals.length === 1) return { valor: vals[0], label: `${vals[0]} kVA`, faixa: false };
  // Faixa/múltiplo: rótulo próprio com "a" (sem travessão), ordena pelo menor.
  const ordenados = [...new Set(vals)].sort((a, b) => a - b);
  return { valor: ordenados[0], label: `${ordenados.join(' a ')} kVA`, faixa: true };
}

// Agrega a moda + ranking de potências a partir dos leads (já filtrados pela
// janela). Reporta % de preenchimento pra o front ser honesto com o buraco de
// dado (kVA não informado é fatia visível, não some).
function agregarPotencias(leads) {
  const total = leads.length;
  const buckets = new Map(); // label => { label, valor, faixa, n }
  let semKva = 0;
  for (const l of leads) {
    const norm = normalizaKva(l.kva);
    if (!norm) { semKva++; continue; }
    const cur = buckets.get(norm.label) || { label: norm.label, valor: norm.valor, faixa: norm.faixa, n: 0 };
    cur.n++;
    buckets.set(norm.label, cur);
  }
  const ranking = [...buckets.values()].sort(
    (a, b) => b.n - a.n || (a.valor ?? Infinity) - (b.valor ?? Infinity),
  );
  const comKva = total - semKva;
  return {
    ranking,
    moda: ranking[0] || null,
    total,
    comKva,
    semKva,
    pctPreenchido: total ? Math.round((comKva / total) * 100) : 0,
  };
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
export async function getBrunoDashboard({ desde = null, ate = null } = {}) {
  const agora = Date.now();

  // Leads e mensagens respeitam a janela; eventos/transições vêm completos
  // (servem de timeline só pros leads já filtrados). nomesRes é o mapa de
  // nome/telefone de TODOS os leads, pra join de mensagem não cair em "—".
  let leadsQ = supabase
    .from('bruno_leads')
    .select('id, nome, empresa, telefone, stage, kva, criado_em, atualizado_em');
  if (desde) leadsQ = leadsQ.gte('criado_em', desde);
  if (ate) leadsQ = leadsQ.lte('criado_em', ate);

  let msgsQ = supabase
    .from('bruno_mensagens')
    .select('lead_id, autor, texto, toque, enviada_em')
    .eq('direcao', 'out')
    .order('enviada_em', { ascending: false })
    .limit(80);
  if (desde) msgsQ = msgsQ.gte('enviada_em', desde);
  if (ate) msgsQ = msgsQ.lte('enviada_em', ate);

  const [leadsRes, eventosRes, transRes, msgsRes, nomesRes] = await Promise.all([
    leadsQ,
    supabase
      .from('bruno_eventos')
      .select('lead_id, tipo, criado_em')
      .order('criado_em', { ascending: true }),
    supabase
      .from('bruno_transicoes')
      .select('lead_id, etapa_de, etapa_para, criado_em')
      .order('criado_em', { ascending: true }),
    msgsQ,
    supabase.from('bruno_leads').select('id, nome, empresa, telefone'),
  ]);
  if (leadsRes.error) throw leadsRes.error;
  if (eventosRes.error) throw eventosRes.error;
  if (transRes.error) throw transRes.error;
  if (msgsRes.error) throw msgsRes.error;
  if (nomesRes.error) throw nomesRes.error;

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

  // Mensagens enviadas (toques) — join nome/telefone via mapa completo.
  const leadMap = new Map((nomesRes.data ?? []).map((l) => [l.id, l]));
  const mensagens = msgs.map((m) => ({
    nome: leadMap.get(m.lead_id)?.nome || '—',
    telefone: leadMap.get(m.lead_id)?.telefone || '',
    autor: m.autor,
    toque: m.toque,
    texto: m.texto,
    enviada_em: m.enviada_em,
  }));

  // Potência mais pedida + ranking de kVA (Incremento C), só dos leads da janela.
  const potencias = agregarPotencias(leads);

  return { distribuicao, leads: leadsDetalhe, mensagens, potencias };
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
