// Dados das abas Tráfego e Bruno do dashboard (F6).
//
// Lê do MESMO Supabase CMO (ebjeylhossntyeccmujn) que o resto da bridge, via
// service role (ignora RLS). A aba Lúcio é servida pelo metrics.js / endpoints
// já existentes — aqui ficam só as duas abas novas.
//
// Portado de claudio-dashboard/src/lib/queries-{trafego,bruno}.ts.

import { supabase } from './supabase-client.js';

// ─── Tráfego (dia a dia, agregado no período do seletor) ────────────────────
// Soma `trafego_diario` (Meta, gravado pelo worker) no intervalo [desde, ate] que
// o seletor global escolheu — igual às abas Bruno/Lúcio. Retorna null = "sem dado
// ainda" (estado, não erro). NÃO inventa número: só soma o que o worker gravou.
// Mantém o MESMO formato que o front (renderTrafego) espera. `fora_da_janela`
// sempre false agora — os dados sempre cobrem exatamente o período pedido.
const CONTA_TRAFEGO = process.env.META_AD_ACCOUNT_ID || 'act_211274648569722';

// Data de CALENDÁRIO em BR (UTC-3): o ISO cru fatiado vazaria o dia (23:59 BR = 02:59 UTC+1).
const dataBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const arred2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export async function getSnapshotTrafego({ desde = null, ate = null } = {}) {
  const ateData = dataBR(ate || new Date().toISOString());
  const desdeData = dataBR(desde || new Date(Date.now() - 30 * 86400_000).toISOString());

  const { data: diario, error: e1 } = await supabase
    .from('trafego_diario').select('*')
    .eq('conta_id', CONTA_TRAFEGO).gte('data', desdeData).lte('data', ateData);
  if (e1) throw e1;
  if (!diario || diario.length === 0) return null;

  const { data: regioesRaw, error: e2 } = await supabase
    .from('trafego_diario_regiao').select('*')
    .eq('conta_id', CONTA_TRAFEGO).gte('data', desdeData).lte('data', ateData);
  if (e2) throw e2;

  const { data: crits, error: e3 } = await supabase
    .from('trafego_criativo').select('*').eq('conta_id', CONTA_TRAFEGO);
  if (e3) throw e3;
  const metaCrit = new Map((crits || []).map((c) => [c.criativo_id, c]));

  // Totais + agregação por criativo
  let inv = 0, imp = 0, cli = 0, conv = 0, ultima = null;
  const porLabel = new Map();
  for (const r of diario) {
    inv += Number(r.spend || 0); imp += Number(r.impressoes || 0);
    cli += Number(r.cliques || 0); conv += Number(r.conversas || 0);
    if (!ultima || r.atualizado_em > ultima) ultima = r.atualizado_em;
    const a = porLabel.get(r.criativo_id) || { gasto: 0, impressoes: 0, cliques: 0, conversas: 0 };
    a.gasto += Number(r.spend || 0); a.impressoes += Number(r.impressoes || 0);
    a.cliques += Number(r.cliques || 0); a.conversas += Number(r.conversas || 0);
    porLabel.set(r.criativo_id, a);
  }
  const criativos = [...porLabel.entries()].map(([id, a]) => {
    const m = metaCrit.get(id) || {};
    return {
      id, nome: m.nome || `${id} - Geradores de Energia`, objetivo: m.objetivo || 'messaging_conversation',
      gasto: arred2(a.gasto), conversas: a.conversas,
      cpl: a.conversas ? arred2(a.gasto / a.conversas) : null,
      ctr: a.impressoes ? arred2((a.cliques / a.impressoes) * 100) : null,
      status: m.status || 'ativo', imagem_url: m.imagem_url || null,
    };
  }).filter((c) => c.gasto > 0 || c.conversas > 0);

  // Agregação por região
  const porReg = new Map();
  for (const r of regioesRaw || []) {
    const a = porReg.get(r.regiao) || { investimento: 0, conversas: 0, proxy: false };
    a.investimento += Number(r.spend || 0); a.conversas += Number(r.conversas || 0);
    if (r.proxy) a.proxy = true;
    porReg.set(r.regiao, a);
  }
  const por_regiao = [...porReg.entries()].map(([regiao, a]) => ({
    regiao, conversas: a.conversas, investimento: arred2(a.investimento),
    cpl: a.conversas ? arred2(a.investimento / a.conversas) : null, proxy: a.proxy,
  })).filter((r) => r.investimento > 0 || r.conversas > 0)
    .sort((x, y) => (x.cpl ?? Infinity) - (y.cpl ?? Infinity));

  const datas = diario.map((r) => r.data).sort();
  return {
    investimento: arred2(inv), impressoes: imp, conversas: conv,
    ctr: imp ? arred2((cli / imp) * 100) : null,
    cpc: cli ? arred2(inv / cli) : null,
    cpl: conv ? arred2(inv / conv) : null,
    criativos, por_regiao,
    janela_inicio: datas[0], janela_fim: datas[datas.length - 1],
    capturado_em: ultima, origem: 'meta-api', fora_da_janela: false,
  };
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
