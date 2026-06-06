// Lúcio — motor de cadência outbound.
// Lê cadencias/passos_cadencia, agenda em agendamentos_disparos respeitando janela
// 09–17h seg-sex (America/Sao_Paulo), formula toques via Claude SDK e marca enviados.
//
// Uso típico:
//   - enrolarLead(leadId, 'geradores-b2b-v1-teste')   → cria agendamentos do lead
//   - puxarPendentes(50)                              → batch que o /outbound-batch consome
//   - formularToque({ lead, passo, historico })       → texto pronto pra disparar
//   - marcarEnviado(agendamentoId, uazapiCampaignId)  → registra envio
//   - resetarCadenciaSeRespondeu(leadId)              → chamado pelo handler de inbound
//
// Janela e jitter de DISPARO ficam no WF-Lucio-Outbound (uazapi /sender/advanced).
// Aqui a gente só decide QUANDO o agendamento fica elegível (agendado_para).

import { gerarTexto } from './claude-client.js';
import fs from 'node:fs';
import path from 'node:path';
import { supabase, gravarMensagem, registrarEvento, atualizarLead } from './supabase-client.js';

const TZ = 'America/Sao_Paulo';
// Janela 08:00–17:30 seg-sex (America/Sao_Paulo). Sem pausa de almoço.
const JANELA_INICIO_H = 8;
const JANELA_INICIO_M = 0;
const JANELA_FIM_H = 17;
const JANELA_FIM_M = 30;
const JANELA_INICIO_MIN = JANELA_INICIO_H * 60 + JANELA_INICIO_M;
const JANELA_FIM_MIN = JANELA_FIM_H * 60 + JANELA_FIM_M;

const IDENTIDADE_PATH = path.resolve(process.cwd(), '.claude', 'identidade-lucio.md');
const IDENTIDADE = (() => { try { return fs.readFileSync(IDENTIDADE_PATH, 'utf8'); } catch { return ''; } })();

// ─── Janela útil ────────────────────────────────────────────────────────────

/**
 * Recebe um Date qualquer e devolve o próximo instante dentro da janela 09–17h
 * seg-sex America/Sao_Paulo. Se já está dentro, devolve o próprio.
 *
 * Implementação: usa Intl pra extrair partes em SP, calcula próxima janela e
 * volta pra UTC. Aceita imprecisão de DST (raro no Brasil hoje).
 */
export function proximoSlotUtil(date = new Date()) {
  // Bypass de teste: CADENCE_IGNORAR_JANELA=1 desliga a regra 09-17h seg-sex.
  // Voltar pra 0 (ou remover do .env) antes de produção.
  if (process.env.CADENCE_IGNORAR_JANELA === '1') return date;

  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  let y = +partes.year, m = +partes.month, d = +partes.day;
  let h = +partes.hour, mi = +partes.minute;
  // weekday curto en-CA: "Mon", "Tue", etc.
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let wd = wdMap[partes.weekday];

  const empurraDia = () => {
    const tmp = new Date(Date.UTC(y, m - 1, d) + 24 * 3600 * 1000);
    y = tmp.getUTCFullYear(); m = tmp.getUTCMonth() + 1; d = tmp.getUTCDate();
    wd = (wd + 1) % 7;
    h = JANELA_INICIO_H; mi = JANELA_INICIO_M;
  };

  // pular fim de semana
  while (wd === 0 || wd === 6) empurraDia();

  const totalMin = h * 60 + mi;
  // antes da janela
  if (totalMin < JANELA_INICIO_MIN) { h = JANELA_INICIO_H; mi = JANELA_INICIO_M; }
  // depois da janela → próximo dia
  else if (totalMin >= JANELA_FIM_MIN) { empurraDia(); while (wd === 0 || wd === 6) empurraDia(); }

  // monta ISO em SP e converte pra UTC
  const isoSP = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`;
  // Hack simples: assume offset -03 (SP sem DST). Se voltar DST no BR, refatorar com luxon/date-fns-tz.
  return new Date(`${isoSP}-03:00`);
}

/**
 * True se `date` cai dentro da janela util (08:00–17:30 seg-sex SP).
 * Reusa proximoSlotUtil: se o proximo slot util e <= agora, e porque ja estamos
 * dentro da janela. Respeita o bypass CADENCE_IGNORAR_JANELA=1.
 */
export function dentroDaJanela(date = new Date()) {
  return proximoSlotUtil(date).getTime() <= date.getTime();
}

// ─── Enroll / agendamento ───────────────────────────────────────────────────

/**
 * Enrola um lead numa cadência: cria registros em agendamentos_disparos pra todos
 * os passos, com agendado_para acumulado a partir de agora (respeitando janela).
 *
 * Idempotente-ish: se o lead já tem agendamentos pendentes, não duplica — cancela
 * antes (caller deve estar ciente). Pra reset puro, usar `resetarCadenciaSeRespondeu`.
 */
export async function enrolarLead(leadId, cadenciaNome) {
  // 1) cadência + passos
  const { data: cad, error: errCad } = await supabase
    .from('cadencias').select('id, nome, total_passos, ativa').eq('nome', cadenciaNome).maybeSingle();
  if (errCad) throw errCad;
  if (!cad || !cad.ativa) throw new Error(`cadência "${cadenciaNome}" inexistente ou inativa`);

  const { data: passos, error: errPassos } = await supabase
    .from('passos_cadencia').select('ordem, delay_minutos, prompt_orientacao')
    .eq('cadencia_id', cad.id).eq('ativa', true).order('ordem', { ascending: true });
  if (errPassos) throw errPassos;
  if (!passos?.length) throw new Error(`cadência "${cadenciaNome}" sem passos ativos`);

  // 2) cancela pendentes anteriores do lead
  await supabase.from('agendamentos_disparos')
    .update({ status: 'cancelado' })
    .eq('lead_id', leadId).eq('status', 'pendente');

  // 3) agenda novos
  let cursor = new Date();
  const rows = [];
  for (const p of passos) {
    cursor = new Date(cursor.getTime() + p.delay_minutos * 60_000);
    const slot = proximoSlotUtil(cursor);
    cursor = slot; // o próximo passo soma a partir do slot real
    rows.push({ lead_id: leadId, passo: p.ordem, agendado_para: slot.toISOString() });
  }

  const { data, error } = await supabase.from('agendamentos_disparos').insert(rows).select();
  if (error) throw error;

  await atualizarLead(leadId, { cadencia_id: cad.id, passo_atual: 0, status: 'em_cadencia' });
  await registrarEvento(leadId, 'cadencia_enrolada', { cadencia: cadenciaNome, total_passos: rows.length });
  // Transição pro dashboard
  try {
    const { registrarTransicao } = await import('./supabase-client.js');
    await registrarTransicao(leadId, null, 'em-cadencia', 'auto', { cadencia: cadenciaNome });
  } catch (err) { console.error('[cadence] erro registrando transição em-cadencia:', err.message); }
  return data;
}

// ─── Puxar pendentes ────────────────────────────────────────────────────────

/**
 * Retorna agendamentos pendentes elegíveis (agendado_para <= now, lead em modo bot,
 * status do lead permite envio). Inclui dados de lead + passo já joinados.
 */
export async function puxarPendentes(limite = 50) {
  // Janela util: fora de 08:00–17:30 seg-sex SP, nao puxa nada (e portanto nao
  // gera toque no Claude). Sem isso, atraso acumulado dispara rajada fora de hora.
  if (!dentroDaJanela()) return [];

  const { data, error } = await supabase
    .from('agendamentos_disparos')
    .select(`
      id, passo, agendado_para, tentativas,
      leads!inner ( id, nome, empresa, telefone, segmento, status, modo, cadencia_id, passo_atual )
    `)
    .eq('status', 'pendente')
    .lte('agendado_para', new Date().toISOString())
    .order('agendado_para', { ascending: true })
    .limit(limite);
  if (error) throw error;

  const filtrados = (data || []).filter(a =>
    a.leads.modo === 'bot' &&
    !['encerrado', 'handoff', 'qualificado', 'engajado'].includes(a.leads.status)
  );

  // junta o passo (prompt_orientacao) — uma query por cadencia_id distinta
  const cadIds = [...new Set(filtrados.map(a => a.leads.cadencia_id))];
  const passosPorCad = {};
  for (const cid of cadIds) {
    const { data: ps } = await supabase
      .from('passos_cadencia').select('ordem, prompt_orientacao').eq('cadencia_id', cid);
    passosPorCad[cid] = Object.fromEntries((ps || []).map(p => [p.ordem, p.prompt_orientacao]));
  }

  return filtrados.map(a => ({
    agendamentoId: a.id,
    lead: a.leads,
    passo: a.passo,
    tentativas: a.tentativas ?? 0,
    promptOrientacao: passosPorCad[a.leads.cadencia_id]?.[a.passo] || '',
  }));
}

/** Incrementa o contador de tentativas do disparo e devolve o novo valor. */
export async function incrementarTentativa(agendamentoId, atual = 0) {
  const novo = (atual ?? 0) + 1;
  const { error } = await supabase.from('agendamentos_disparos')
    .update({ tentativas: novo }).eq('id', agendamentoId);
  if (error) throw error;
  return novo;
}

/** Marca o disparo como 'falha' (sai da fila, nao regenera mais). */
export async function marcarFalha(agendamentoId, motivo = '') {
  const { error } = await supabase.from('agendamentos_disparos')
    .update({ status: 'falha', executado_em: new Date().toISOString() }).eq('id', agendamentoId);
  if (error) throw error;
  if (motivo) {
    try {
      const { data } = await supabase.from('agendamentos_disparos').select('lead_id').eq('id', agendamentoId).maybeSingle();
      if (data?.lead_id) await registrarEvento(data.lead_id, 'disparo_falhou', { agendamento_id: agendamentoId, motivo });
    } catch { /* evento e best-effort */ }
  }
}

// ─── Formular toque (Claude SDK) ────────────────────────────────────────────

const ESTILO_OUTBOUND = `
# Você está iniciando/continuando contato proativo com um lead via WhatsApp

Regras:
- Frases curtas. Quebra de linha entre ideias. 1-3 telas de celular no máximo.
- Sem markdown. Negrito com *asteriscos simples* só se realmente precisar (raro).
- NUNCA use travessão (— ou –) no texto. Use vírgula, ou quebre em duas frases.
- Não prometa preço, prazo ou disponibilidade. Você qualifica e provoca curiosidade.
- Termine com pergunta aberta quando fizer sentido — você quer resposta, não monólogo.
- Se a orientação do passo pedir tag de teste tipo "[teste: toque N — ...]", PRESERVE a tag literal no fim.
`;

/**
 * Carrega obras vinculadas ao lead (via lead_obras) — pra contexto outbound.
 * Devolve até 3 obras priorizando estágios ativos (canteiro precisa de energia).
 */
async function carregarObrasDoLead(lead_id) {
  if (!lead_id) return [];
  const { data, error } = await supabase
    .from('lead_obras')
    .select('posicao, contato_nome, contato_cargo, obras:obra_id (codigo_externo, nome, estagio_atual, fase, cidade, estado, bairro, valor_investimento, n_unidades, n_pavimentos, detalhes, inicio_obra, termino_obra)')
    .eq('lead_id', lead_id)
    .order('posicao', { ascending: true })
    .limit(10);
  if (error) { console.warn('[cadence] erro carregando obras:', error.message); return []; }

  const PRIO = ['FUNDAÇÕES', 'ESTRUTURA', 'ALVENARIA', 'EM CONSTRUÇÃO', 'SERVIÇOS PRELIMINARES', 'TERRAPLENAGEM', 'ACABAMENTO', 'LANÇAMENTO', 'PROJETO'];
  const score = (e) => { const i = PRIO.indexOf(String(e || '').toUpperCase()); return i < 0 ? 99 : i; };
  return (data || []).slice().sort((a, b) => score(a.obras?.estagio_atual) - score(b.obras?.estagio_atual)).slice(0, 3);
}

function formataObrasParaPrompt(leadObras) {
  if (!leadObras.length) return '(sem obras vinculadas)';
  return leadObras.map((lo, i) => {
    const o = lo.obras || {};
    const linhas = [];
    linhas.push(`Obra ${i + 1}: ${o.nome || o.codigo_externo || '(sem nome)'}`);
    if (o.cidade || o.estado) linhas.push(`  Local: ${[o.bairro, o.cidade, o.estado].filter(Boolean).join(' / ')}`);
    if (o.estagio_atual) linhas.push(`  Estágio: ${o.estagio_atual}${o.fase ? ' (' + o.fase + ')' : ''}`);
    if (o.n_unidades || o.n_pavimentos) linhas.push(`  Porte: ${o.n_unidades || '-'} unidades, ${o.n_pavimentos || '-'} pavimentos`);
    if (o.valor_investimento) linhas.push(`  Valor investimento: R$ ${Number(o.valor_investimento).toLocaleString('pt-BR')}`);
    if (o.detalhes) linhas.push(`  Detalhes: ${String(o.detalhes).slice(0, 240)}`);
    if (lo.contato_nome && lo.contato_nome !== (o.responsavel || null)) linhas.push(`  Contato registrado: ${lo.contato_nome}${lo.contato_cargo ? ' — ' + lo.contato_cargo : ''}`);
    return linhas.join('\n');
  }).join('\n\n');
}

/**
 * Gera o texto do toque pra um agendamento. Não envia — só formula.
 */
export async function formularToque({ lead, passo, promptOrientacao, historico = [] }) {
  const systemPrompt = IDENTIDADE + ESTILO_OUTBOUND;

  const histTxt = historico.length
    ? historico.map(m => `[${m.enviada_em}] ${m.autor === 'lead' ? 'Lead' : 'Lúcio'}: ${m.texto}`).join('\n')
    : '(sem histórico — primeiro contato)';

  const obras = await carregarObrasDoLead(lead?.id);

  const userPrompt = `## Lead
- Nome: ${lead.nome || 'desconhecido'}
- Cargo: ${lead.cargo || '-'}
- Empresa: ${lead.empresa || lead.razao_social || '-'}
- CNPJ: ${lead.cnpj || '-'}
- Tipo de empresa: ${lead.tipo_empresa || 'indefinido'}  (construtora|incorporadora|ambos|indefinido)
- Segmento da empresa: ${lead.segmento || '-'}
- Telefone (compartilhado pela empresa, pode atender qualquer um da equipe): ${lead.telefone}

## Obras vinculadas ao lead (priorizadas por estágio ativo)
${formataObrasParaPrompt(obras)}

## Histórico
${histTxt}

## Passo desta cadência
Toque número ${passo}.
Orientação: ${promptOrientacao}

Escreva agora a mensagem pro WhatsApp do lead. Texto direto, sem prefixo, sem aspas.`;

  const { texto, tokensIn, tokensOut } = await gerarTexto({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: parseInt(process.env.LUCIO_MAX_TOKENS || '1024', 10),
    label: `toque-${passo}`,
  });
  return { texto, tokensIn, tokensOut };
}

// ─── Marcar enviado ─────────────────────────────────────────────────────────

export async function marcarEnviado(agendamentoId, { texto, leadId, passo, uazapiCampaignId = null, tokensIn = null, tokensOut = null }) {
  const { error } = await supabase.from('agendamentos_disparos').update({
    status: 'enviado',
    executado_em: new Date().toISOString(),
    campanha_uazapi_id: uazapiCampaignId,
  }).eq('id', agendamentoId);
  if (error) throw error;

  await gravarMensagem({
    lead_id: leadId,
    chatid: null, // bridge preenche depois ou já vem do webhook
    direcao: 'out',
    autor: 'ia',
    texto,
    passo,
    modo_no_momento: 'bot',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  });

  await atualizarLead(leadId, { passo_atual: passo });
}

// ─── Reset (lead respondeu) ─────────────────────────────────────────────────

/**
 * Lead respondeu → cancela todos agendamentos pendentes e marca como engajado.
 * Idempotente. Chamado pelo handler de inbound após gravar a mensagem do lead.
 */
export async function resetarCadenciaSeRespondeu(leadId) {
  const { data: pendentes, error: errSel } = await supabase
    .from('agendamentos_disparos').select('id')
    .eq('lead_id', leadId).eq('status', 'pendente');
  if (errSel) throw errSel;

  if (pendentes?.length) {
    await supabase.from('agendamentos_disparos')
      .update({ status: 'cancelado' })
      .eq('lead_id', leadId).eq('status', 'pendente');
  }

  const { data: lead } = await supabase.from('leads').select('status').eq('id', leadId).single();
  if (lead && !['handoff', 'qualificado', 'encerrado'].includes(lead.status)) {
    await atualizarLead(leadId, { status: 'engajado' });
    await registrarEvento(leadId, 'cadencia_resetada', { motivo: 'lead_respondeu', cancelados: pendentes?.length ?? 0 });
  }
}
