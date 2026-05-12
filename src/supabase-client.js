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

export async function buscarLeadPorTelefone(telefone) {
  ensure();
  const { data, error } = await supabase.from('leads').select('*').eq('telefone', telefone).maybeSingle();
  if (error) throw error;
  return data;
}

export async function criarLead({ nome, empresa, telefone, segmento, origem = 'inbound' }) {
  ensure();
  const { data, error } = await supabase.from('leads').insert({ nome, empresa, telefone, segmento, origem }).select().single();
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

export async function agendarProximoPasso(lead_id, passo, agendado_para) {
  ensure();
  const { data, error } = await supabase.from('agendamentos_disparos').insert({ lead_id, passo, agendado_para }).select().single();
  if (error) throw error;
  return data;
}

export async function marcarLeadQualificado(lead_id, motivo = null) {
  ensure();
  await registrarEvento(lead_id, 'qualificado', { motivo });
  return atualizarLead(lead_id, { status: 'qualificado' });
}

export async function marcarHandoff(lead_id, payload = {}) {
  ensure();
  await registrarEvento(lead_id, 'handoff_solicitado', payload);
  return atualizarLead(lead_id, { status: 'handoff', modo: 'mudo' });
}

export async function devolverPraBot(lead_id) {
  ensure();
  await registrarEvento(lead_id, 'devolvido_bot', {});
  return atualizarLead(lead_id, { modo: 'bot' });
}

export async function encerrarLead(lead_id, motivo) {
  ensure();
  await registrarEvento(lead_id, 'encerrado_lucio', { motivo });
  return atualizarLead(lead_id, { status: 'encerrado', motivo_encerramento: motivo });
}
