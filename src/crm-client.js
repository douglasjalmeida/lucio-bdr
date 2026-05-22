// Cliente REST do CRM externo da Luminus (funis Marketing + Vendas).
// Espelha o pipeline que já vai pro Chatwoot: cada transição registrada em
// `registrarTransicao` (supabase-client) também sincroniza o card no CRM.
//
// Tolera ausência de config (CRM_BASE_URL ou CRM_API_TOKEN vazio) — todas as
// funções viram no-op. Best-effort: erro no CRM nunca quebra o pipeline.
//
// Auth: Bearer EXTERNAL_API_TOKEN. API opera sobre uma org fixa no servidor.
// Doc: api-externa-funis.md.

const BASE_URL = (process.env.CRM_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.CRM_API_TOKEN || '';

const enabled = !!(BASE_URL && TOKEN);

export function crmEnabled() {
  return enabled;
}

export function crmConfig() {
  return { enabled, base: BASE_URL };
}

// ─────────────────────────────────────────────────────────────
// Mapa: estado interno do funil (FUNIL_ORDEM / labels Chatwoot)
// → { funil: 'marketing'|'sales', stage: <name da etapa no CRM> }.
// Marketing = jornada MQL (card = lead). Vendas = jornada SQL (card = negócio).
// `encerrado` é tratado à parte (ver espelharTransicao).
// ─────────────────────────────────────────────────────────────
const MAPA = {
  'em-cadencia':       { funil: 'marketing', stage: 'em-cadencia' },
  'mql-respondeu':     { funil: 'marketing', stage: 'mql-respondeu' },
  'mql-qualificado':   { funil: 'marketing', stage: 'mql-qualificado' },
  'mql-descartado':    { funil: 'marketing', stage: 'mql-descartado' },
  'humano-atendendo':  { funil: 'sales',     stage: 'humano-atendendo' },
  'sql-contato-feito': { funil: 'sales',     stage: 'sql-contato-feito' },
  'sql-proposta':      { funil: 'sales',     stage: 'sql-proposta' },
  'sql-negociacao':    { funil: 'sales',     stage: 'sql-negociacao' },
  'sql-ganho':         { funil: 'sales',     stage: 'sql-ganho' },
  'sql-perdido':       { funil: 'sales',     stage: 'sql-perdido' },
};

// Definição das etapas a garantir em cada funil (setup idempotente).
// is_won/is_lost só existem no funil de vendas e fecham o negócio ao mover.
export const STAGES = {
  marketing: [
    { name: 'em-cadencia',     label: 'Em cadência', position: 1, color: '#6366f1' },
    { name: 'mql-respondeu',   label: 'Respondeu',   position: 2, color: '#0ea5e9' },
    { name: 'mql-qualificado', label: 'Qualificado', position: 3, color: '#22c55e' },
    { name: 'mql-descartado',  label: 'Descartado',  position: 4, color: '#ef4444' },
  ],
  sales: [
    { name: 'humano-atendendo',  label: 'Closer atendendo', position: 1, color: '#6366f1' },
    { name: 'sql-contato-feito', label: 'Contato feito',    position: 2, color: '#0ea5e9' },
    { name: 'sql-proposta',      label: 'Proposta',         position: 3, color: '#a855f7' },
    { name: 'sql-negociacao',    label: 'Negociação',       position: 4, color: '#f59e0b' },
    { name: 'sql-ganho',         label: 'Ganho',            position: 5, color: '#22c55e', is_won: true },
    { name: 'sql-perdido',       label: 'Perdido',          position: 6, color: '#ef4444', is_lost: true },
  ],
};

// ─────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────
function url(funil, path) {
  // funil: 'marketing' | 'sales'. path começa sem barra (ex: 'stages/').
  return `${BASE_URL}/api/external/${funil}/${path}`;
}

async function call(method, funil, path, body = null) {
  if (!enabled) return null;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const r = await fetch(url(funil, path), opts);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* deixa null */ }
  if (!r.ok) {
    const snippet = text ? text.slice(0, 300) : '(vazio)';
    throw new Error(`CRM ${method} ${funil}/${path} -> ${r.status}: ${snippet}`);
  }
  return json;
}

// Telefone só com dígitos — by-phone normaliza máscara, mas mandamos limpo.
function soDigitos(telefone) {
  return String(telefone || '').replace(/\D/g, '');
}

// Extrai um card único de respostas que podem vir como objeto ou {results:[]}.
function primeiroCard(res) {
  if (!res) return null;
  if (Array.isArray(res?.results)) return res.results[0] || null;
  if (Array.isArray(res)) return res[0] || null;
  if (res?.id) return res;
  return null;
}

// ─────────────────────────────────────────────────────────────
// Setup de etapas (idempotente). Roda via scripts/crm-setup.js.
// ─────────────────────────────────────────────────────────────
export async function listarStages(funil) {
  const res = await call('GET', funil, 'stages/');
  return res?.results || res || [];
}

export async function removerStage(funil, id) {
  return call('DELETE', funil, `stages/${id}/`);
}

// Remove etapas que NÃO fazem parte do conjunto canônico (STAGES) — usado pra
// alinhar o CRM ao pipeline do Chatwoot (fonte da verdade). Idempotente.
// CUIDADO: só rode com os funis vazios; apagar etapa com card órfana o card.
export async function limparStagesForaDoCanonico() {
  if (!enabled) return { skipped: 'crm-off' };
  const relatorio = { marketing: [], sales: [] };
  for (const funil of ['marketing', 'sales']) {
    const canonicos = new Set(STAGES[funil].map(s => s.name));
    const existentes = await listarStages(funil);
    for (const s of existentes) {
      if (canonicos.has(s.name)) continue;
      await removerStage(funil, s.id);
      relatorio[funil].push({ id: s.id, name: s.name });
    }
  }
  return relatorio;
}

export async function garantirStages() {
  if (!enabled) return { skipped: 'crm-off' };
  const relatorio = { marketing: [], sales: [] };
  for (const funil of ['marketing', 'sales']) {
    const existentes = await listarStages(funil);
    const nomes = new Set(existentes.map(s => s.name));
    for (const stage of STAGES[funil]) {
      if (nomes.has(stage.name)) {
        relatorio[funil].push({ name: stage.name, status: 'já existe' });
        continue;
      }
      await call('POST', funil, 'stages/', stage);
      relatorio[funil].push({ name: stage.name, status: 'criada' });
    }
  }
  return relatorio;
}

// ─────────────────────────────────────────────────────────────
// Cards (lead no marketing, negócio no sales)
//
// Idempotência: guardamos o id do card no Supabase (crm_lead_id / crm_deal_id).
// Marketing tem by-phone confiável (lead grava phone direto), mas o NEGÓCIO do
// funil de vendas NÃO grava phone pesquisável (by-phone busca via contato/empresa
// vinculado, e a API externa não expõe contato) — sem o id salvo, cada transição
// recriava o negócio. Por isso o id salvo é a chave primária de idempotência;
// by-phone vira só fallback. As funções de mover/criar retornam um "patch" de
// persistência ({ crm_lead_id } | { crm_deal_id }) quando descobrem/criam um id,
// pra registrarTransicao gravar no lead. Retornam null quando não há nada a salvar.
// ─────────────────────────────────────────────────────────────
async function buscarCard(funil, telefone) {
  const phone = soDigitos(telefone);
  if (!phone) return null;
  const recurso = funil === 'marketing' ? 'leads' : 'deals';
  const res = await call('GET', funil, `${recurso}/by-phone/?phone=${encodeURIComponent(phone)}`);
  return primeiroCard(res);
}

// Marketing: move o LEAD por id salvo; senão acha por telefone; senão cria.
async function moverOuCriarLead({ telefone, nome, stage, crmLeadId }) {
  if (crmLeadId) {
    await call('POST', 'marketing', 'leads/move/', { id: crmLeadId, stage });
    return null;
  }
  const existente = await buscarCard('marketing', telefone);
  if (existente) {
    await call('POST', 'marketing', 'leads/move/', { id: existente.id, stage });
    return { crm_lead_id: existente.id };
  }
  const novo = await call('POST', 'marketing', 'leads/', {
    title: nome || undefined,
    phone: soDigitos(telefone),
    stage,
  });
  return novo?.id ? { crm_lead_id: novo.id } : null;
}

// Vendas: move o NEGÓCIO por id salvo; senão tenta by-phone (raro); senão cria.
// move/ do sales aceita SÓ id. title é obrigatório na criação.
async function moverOuCriarNegocio({ telefone, nome, empresa, stage, crmDealId }) {
  if (crmDealId) {
    await call('POST', 'sales', 'deals/move/', { id: crmDealId, stage });
    return null;
  }
  const existente = await buscarCard('sales', telefone);
  if (existente) {
    await call('POST', 'sales', 'deals/move/', { id: existente.id, stage });
    return { crm_deal_id: existente.id };
  }
  const title = nome || empresa || `Negócio ${soDigitos(telefone)}`;
  const novo = await call('POST', 'sales', 'deals/', { title, phone: soDigitos(telefone), stage });
  return novo?.id ? { crm_deal_id: novo.id } : null;
}

export async function removerLead(id) { return call('DELETE', 'marketing', `leads/${id}/`); }
export async function removerNegocio(id) { return call('DELETE', 'sales', `deals/${id}/`); }

// ─────────────────────────────────────────────────────────────
// Notas — espelha no card CRM as notas privadas que o Lúcio cria no Chatwoot.
// O CRM tem UM campo `notes` por card (não um log multi-entrada), então
// acumulamos: lê o notes atual, anexa a nova entrada com carimbo de data/hora.
// A nota vai pro card mais avançado que existe (negócio se houver, senão lead).
// No-op se o lead não tem card no CRM — nota não cria card do zero.
// ─────────────────────────────────────────────────────────────
function carimboBR() {
  return new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Teto do campo acumulado: mantém as entradas mais recentes (corta o começo).
const NOTES_MAX_CHARS = 8000;

export async function adicionarNotaCard(lead, texto) {
  if (!enabled) return null;
  if (!texto || !lead) return null;

  // O lead vive em até dois funis ao mesmo tempo (Marketing como MQL + Vendas
  // como negócio). A nota vai pra TODOS os cards que existem, pra ser encontrável
  // em qualquer funil que o usuário abrir — não só no "mais avançado".
  const alvos = [];
  if (lead.crm_lead_id) alvos.push({ funil: 'marketing', recurso: 'leads', id: lead.crm_lead_id });
  if (lead.crm_deal_id) alvos.push({ funil: 'sales', recurso: 'deals', id: lead.crm_deal_id });
  if (!alvos.length) return null;

  const entrada = `— [${carimboBR()}] ${texto}`;
  const escritos = [];
  for (const a of alvos) {
    try {
      // read-modify-write não-atômico: como o espelho é best-effort e fire-and-
      // forget, duas notas quase-simultâneas pro mesmo card podem perder uma.
      // Aceitável (notas do Lúcio pro mesmo lead são raras e sequenciais).
      const atual = await call('GET', a.funil, `${a.recurso}/${a.id}/`);
      const anterior = (atual?.notes || '').trim();
      let novo = anterior ? `${anterior}\n\n${entrada}` : entrada;
      if (novo.length > NOTES_MAX_CHARS) novo = novo.slice(-NOTES_MAX_CHARS);
      await call('PATCH', a.funil, `${a.recurso}/${a.id}/`, { notes: novo });
      escritos.push(a);
    } catch (e) {
      // best-effort por card: falha num funil não impede o outro
      console.warn(`[crm] nota falhou em ${a.funil}/${a.id}:`, e.message);
    }
  }
  return escritos.length ? escritos : null;
}

// ─────────────────────────────────────────────────────────────
// Entrada principal — chamada (fire-and-forget) por registrarTransicao.
// `lead` = { telefone, nome, empresa, crm_lead_id, crm_deal_id }.
// Retorna patch de persistência ({ crm_lead_id }|{ crm_deal_id }) ou null.
// ─────────────────────────────────────────────────────────────
export async function espelharTransicao(lead, etapaPara) {
  if (!enabled) return null;
  if (!lead?.telefone || !etapaPara) return null;

  // `encerrado`: se o lead já virou negócio, fecha como perdido lá; senão
  // descarta no funil de marketing.
  if (etapaPara === 'encerrado') {
    if (lead.crm_deal_id || (await buscarCard('sales', lead.telefone))) {
      return moverOuCriarNegocio({
        telefone: lead.telefone, nome: lead.nome, empresa: lead.empresa,
        stage: 'sql-perdido', crmDealId: lead.crm_deal_id,
      });
    }
    return moverOuCriarLead({
      telefone: lead.telefone, nome: lead.nome, stage: 'mql-descartado', crmLeadId: lead.crm_lead_id,
    });
  }

  const m = MAPA[etapaPara];
  if (!m) return null;

  if (m.funil === 'marketing') {
    return moverOuCriarLead({
      telefone: lead.telefone, nome: lead.nome, stage: m.stage, crmLeadId: lead.crm_lead_id,
    });
  }
  return moverOuCriarNegocio({
    telefone: lead.telefone, nome: lead.nome, empresa: lead.empresa,
    stage: m.stage, crmDealId: lead.crm_deal_id,
  });
}
