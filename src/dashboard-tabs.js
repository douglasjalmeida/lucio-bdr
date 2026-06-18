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

// Atividade recente: merge dos últimos bruno_eventos + bruno_mensagens, desc.
export async function getAtividadeBruno(limite = 15) {
  const [eventos, mensagens] = await Promise.all([
    supabase
      .from('bruno_eventos')
      .select('tipo, criado_em')
      .order('criado_em', { ascending: false })
      .limit(limite),
    supabase
      .from('bruno_mensagens')
      .select('direcao, autor, texto, enviada_em')
      .order('enviada_em', { ascending: false })
      .limit(limite),
  ]);

  if (eventos.error) throw eventos.error;
  if (mensagens.error) throw mensagens.error;

  const deEventos = (eventos.data ?? []).map((e) => ({
    quando: e.criado_em,
    tipo: `evento:${e.tipo}`,
    resumo: rotuloEvento(e.tipo),
  }));

  const deMensagens = (mensagens.data ?? []).map((m) => {
    const texto = (m.texto || '').trim() || '(sem texto)';
    const dir = m.direcao === 'entrada' ? '↘ recebida' : '↗ enviada';
    return { quando: m.enviada_em, tipo: 'mensagem', resumo: `${dir} · ${truncar(texto, 80)}` };
  });

  return [...deEventos, ...deMensagens]
    .filter((a) => a.quando)
    .sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime())
    .slice(0, limite);
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

function truncar(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
