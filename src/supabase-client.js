import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Node 20 não tem WebSocket nativo; passar 'ws' explicitamente pro realtime-js
// não crashar no boot (Easypanel pode estar em Node 20). Em Node 22+ é ignorado.
export const supabase = url && serviceKey
  ? createClient(url, serviceKey, {
      auth: { persistSession: false },
      realtime: { transport: WebSocket },
    })
  : null;

export const supabaseEnabled = () => supabase !== null;

function ensure() {
  if (!supabase) throw new Error('Supabase não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env');
}

// Persistimos sempre em E.164 com `+` na frente. uazapi entrega sem `+`,
// Chatwoot entrega com `+` — sem normalizar, mesmo número vira 2 leads.
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

export async function buscarLeadPorTelefone(telefone) {
  ensure();
  const variantes = variantesTelefone(telefone);
  const { data, error } = await supabase
    .from('leads').select('*')
    .in('telefone', variantes)
    .order('id', { ascending: true });
  if (error) throw error;
  return (data && data[0]) || null;
}

export async function criarLead({ nome, empresa, telefone, segmento, origem = 'inbound' }) {
  ensure();
  const norm = normalizaTelefone(telefone);
  const { data, error } = await supabase.from('leads').insert({ nome, empresa, telefone: norm, segmento, origem }).select().single();
  if (error) throw error;
  return data;
}

export async function atualizarLead(id, patch) {
  ensure();
  const { data, error } = await supabase.from('leads').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function gravarMensagem({ lead_id, chatid, direcao, autor, texto, passo = null, modo_no_momento = null, uazapi_message_id = null, tokens_in = null, tokens_out = null, custo_usd = null }) {
  ensure();
  const { data, error } = await supabase.from('mensagens').insert({
    lead_id, chatid, direcao, autor, texto, passo, modo_no_momento,
    uazapi_message_id, tokens_in, tokens_out, custo_usd,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function ultimasMensagensDoLead(lead_id, limit = 30) {
  ensure();
  const { data, error } = await supabase
    .from('mensagens')
    .select('direcao, autor, texto, enviada_em, passo, modo_no_momento')
    .eq('lead_id', lead_id)
    .order('enviada_em', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}

export async function registrarEvento(lead_id, tipo, payload_json = {}) {
  ensure();
  const { error } = await supabase.from('eventos').insert({ lead_id, tipo, payload_json });
  if (error) throw error;
}

// Registra transição de etapa do funil pro dashboard. Idempotente-ish: se a
// última transição registrada pro lead já está na mesma etapa_para, não duplica.
export async function registrarTransicao(lead_id, etapa_de, etapa_para, origem = 'auto', payload_json = null) {
  ensure();
  if (!lead_id || !etapa_para) return null;
  // Anti-duplicata: olha última transição do lead. Se igual à proposta, no-op.
  const { data: ultima } = await supabase
    .from('transicoes_pipeline')
    .select('etapa_para')
    .eq('lead_id', lead_id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ultima?.etapa_para === etapa_para) return { skipped: 'mesma-etapa' };

  // Busca cadencia_id do lead pra desnormalizar (facilita filtro no dashboard).
  const { data: leadRow } = await supabase
    .from('leads')
    .select('cadencia_id')
    .eq('id', lead_id)
    .maybeSingle();

  const { error } = await supabase.from('transicoes_pipeline').insert({
    lead_id,
    cadencia_id: leadRow?.cadencia_id || null,
    etapa_de: etapa_de || ultima?.etapa_para || null,
    etapa_para,
    origem,
    payload_json,
  });
  if (error) throw error;
  return { ok: true };
}

// Query de transições por janela. Retorna agregados por etapa pra KPI cards.
export async function contarTransicoesPorEtapa({ desde, ate, cadenciaId = null } = {}) {
  ensure();
  let q = supabase.from('transicoes_pipeline').select('etapa_para, criado_em, lead_id');
  if (desde) q = q.gte('criado_em', desde);
  if (ate) q = q.lte('criado_em', ate);
  if (cadenciaId) q = q.eq('cadencia_id', cadenciaId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Lista de leads ativos com timeline de transições — pra tabela detalhada.
export async function transicoesPorLead({ desde, cadenciaId = null, limit = 200 } = {}) {
  ensure();
  let q = supabase
    .from('transicoes_pipeline')
    .select('id, lead_id, etapa_de, etapa_para, origem, criado_em, cadencia_id')
    .order('criado_em', { ascending: true });
  if (desde) q = q.gte('criado_em', desde);
  if (cadenciaId) q = q.eq('cadencia_id', cadenciaId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function listarCadencias() {
  ensure();
  const { data, error } = await supabase.from('cadencias').select('id, nome').order('id');
  if (error) throw error;
  return data || [];
}

export async function listarLeadsPorIds(ids) {
  ensure();
  if (!ids?.length) return [];
  const { data, error } = await supabase
    .from('leads')
    .select('id, nome, empresa, telefone, status, modo, cadencia_id')
    .in('id', ids);
  if (error) throw error;
  return data || [];
}

// ─── Controle global do outbound (config_bridge) ─────────────────────────────

// Estado do envio outbound: 'ativo' | 'pausado' | 'encerrado'. Persistido pra
// sobreviver a restart do container. Default 'ativo' se a chave não existir.
export async function getOutboundEstado() {
  ensure();
  const { data, error } = await supabase
    .from('config_bridge')
    .select('valor, atualizado_em, atualizado_por')
    .eq('chave', 'outbound_estado')
    .maybeSingle();
  if (error) throw error;
  return {
    estado: data?.valor || 'ativo',
    atualizado_em: data?.atualizado_em || null,
    atualizado_por: data?.atualizado_por || null,
  };
}

export async function setOutboundEstado(estado, atualizado_por = 'dashboard') {
  ensure();
  if (!['ativo', 'pausado', 'encerrado'].includes(estado)) {
    throw new Error(`estado inválido: ${estado}`);
  }
  const { data, error } = await supabase
    .from('config_bridge')
    .upsert({ chave: 'outbound_estado', valor: estado, atualizado_em: new Date().toISOString(), atualizado_por }, { onConflict: 'chave' })
    .select('valor, atualizado_em, atualizado_por')
    .single();
  if (error) throw error;
  return { estado: data.valor, atualizado_em: data.atualizado_em, atualizado_por: data.atualizado_por };
}

// ─── Mensagens enviadas (pro dashboard) ──────────────────────────────────────

// Lista mensagens que saíram pro lead (direcao='out'): toques outbound da IA,
// respostas inbound da IA e mensagens do closer humano. Join com leads pra nome/
// empresa/telefone e pra permitir filtro por cadência.
export async function listarMensagensEnviadas({ desde = null, cadenciaId = null, limit = 100 } = {}) {
  ensure();
  let q = supabase
    .from('mensagens')
    .select('id, texto, autor, passo, enviada_em, modo_no_momento, leads!inner ( id, nome, empresa, telefone, cadencia_id )')
    .eq('direcao', 'out')
    .order('enviada_em', { ascending: false })
    .limit(limit);
  if (desde) q = q.gte('enviada_em', desde);
  if (cadenciaId) q = q.eq('leads.cadencia_id', cadenciaId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(m => ({
    id: m.id,
    texto: m.texto,
    autor: m.autor,
    passo: m.passo,
    enviada_em: m.enviada_em,
    modo_no_momento: m.modo_no_momento,
    lead_id: m.leads?.id ?? null,
    nome: m.leads?.nome || '',
    empresa: m.leads?.empresa || '',
    telefone: m.leads?.telefone || '',
  }));
}

export async function agendarProximoPasso(lead_id, passo, agendado_para) {
  ensure();
  const { data, error } = await supabase.from('agendamentos_disparos').insert({ lead_id, passo, agendado_para }).select().single();
  if (error) throw error;
  return data;
}

export async function marcarLeadQualificado(lead_id, motivo = null) {
  ensure();
  await registrarEvento(lead_id, 'qualificado', { motivo });
  await registrarTransicao(lead_id, null, 'mql-qualificado', 'auto', { motivo }).catch(() => {});
  return atualizarLead(lead_id, { status: 'qualificado' });
}

export async function marcarHandoff(lead_id, payload = {}) {
  ensure();
  await registrarEvento(lead_id, 'handoff_solicitado', payload);
  await registrarTransicao(lead_id, null, 'humano-atendendo', 'auto', payload).catch(() => {});
  return atualizarLead(lead_id, { status: 'handoff', modo: 'mudo' });
}

export async function devolverPraBot(lead_id) {
  ensure();
  await registrarEvento(lead_id, 'devolvido_bot', {});
  await registrarTransicao(lead_id, null, 'em-cadencia', 'manual', { motivo: 'devolver-lucio' }).catch(() => {});
  return atualizarLead(lead_id, { modo: 'bot' });
}

export async function encerrarLead(lead_id, motivo) {
  ensure();
  await registrarEvento(lead_id, 'encerrado_lucio', { motivo });
  await registrarTransicao(lead_id, null, 'encerrado', 'auto', { motivo }).catch(() => {});
  return atualizarLead(lead_id, { status: 'encerrado', motivo_encerramento: motivo });
}
