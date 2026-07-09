// Coletor de tráfego da Meta → tabelas diárias no Supabase CMO.
//
// Faz SOZINHO o que o Cláudio fazia na mão: bate na Graph API da Meta
// (act_211274648569722, token System User com ads_read), agrega por DIA × criativo
// (rótulo AD01/AD02/AD03…) e por DIA × região, re-hospeda a imagem do criativo no
// Storage e grava tudo (upsert idempotente). O endpoint /api/trafego soma o período
// que o usuário escolhe no seletor. NÃO inventa número — grava só o que a Meta devolve.
//
// Fica em src/ (não scripts/) porque o Dockerfile só copia src/ e public/ — assim o
// server.js embute a coleta automática no boot (um serviço, um deploy).
// CLI de coleta manual: scripts/coletar-trafego.js. Loop: iniciarColetaAutomatica().

import { createClient } from '@supabase/supabase-js';

const V     = process.env.META_API_VERSION || 'v21.0';
const TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const ACCT  = process.env.META_AD_ACCOUNT_ID;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'trafego-criativos';
const CONV_ACTION = 'onsite_conversion.messaging_conversation_started_7d'; // conversa WhatsApp iniciada
// A Meta NÃO quebra messaging_conversation_started por região; usamos a 1ª resposta
// na conversa como PROXY (no total da conta bate ~1:1 com a conversa iniciada).
const REGIAO_PROXY_ACTION = 'onsite_conversion.messaging_first_reply';

function checarEnv() {
  const faltando = [];
  if (!TOKEN) faltando.push('META_SYSTEM_USER_TOKEN');
  if (!ACCT)  faltando.push('META_AD_ACCOUNT_ID');
  if (!SB_URL) faltando.push('SUPABASE_URL');
  if (!SB_KEY) faltando.push('SUPABASE_SERVICE_ROLE_KEY');
  if (faltando.length) throw new Error('Faltou no .env: ' + faltando.join(', '));
}

const sb = () => createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// Datas de CALENDÁRIO em BR (UTC-3) — a Meta reporta por dia no fuso da conta.
const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function menosDias(dataStr, n) {
  const d = new Date(dataStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const rotulo = (nome) => {
  const m = (nome || '').match(/AD\d+/i);
  return m ? m[0].toUpperCase() : 'OUTROS';
};
const arred2 = (n) => Math.round(Number(n || 0) * 100) / 100;
function conversasDe(actions) {
  if (!Array.isArray(actions)) return 0;
  const a = actions.find((x) => x.action_type === CONV_ACTION);
  return a ? Math.round(Number(a.value)) : 0;
}
function proxyRegiaoDe(actions) {
  if (!Array.isArray(actions)) return 0;
  const a = actions.find((x) => x.action_type === REGIAO_PROXY_ACTION);
  return a ? Math.round(Number(a.value)) : 0;
}

// ── Graph API com paginação + retry ────────────────────────────────────────
const TRANSIENTES = new Set([1, 2, 4, 17, 341, 368, 613]); // rate limit / temporário
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function pegarJson(url, tentativa = 0) {
  let j;
  try {
    const r = await fetch(url);
    j = await r.json();
  } catch (e) {
    if (tentativa < 5) { await dorme(2000 * (tentativa + 1)); return pegarJson(url, tentativa + 1); }
    throw e;
  }
  if (j.error) {
    if (TRANSIENTES.has(j.error.code) && tentativa < 5) {
      await dorme(3000 * (tentativa + 1)); // backoff: 3s, 6s, 9s, 12s, 15s
      return pegarJson(url, tentativa + 1);
    }
    throw new Error(`Meta (#${j.error.code}) ${j.error.message}`);
  }
  return j;
}

function montarUrl(path, params) {
  const url = new URL(`https://graph.facebook.com/${V}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  url.searchParams.set('access_token', TOKEN);
  return url;
}

async function metaGetAll(path, params) {
  const out = [];
  let j = await pegarJson(montarUrl(path, { limit: 500, ...params }));
  out.push(...(j.data || []));
  let guard = 0;
  while (j.paging && j.paging.next && guard++ < 300) {
    j = await pegarJson(j.paging.next);
    out.push(...(j.data || []));
  }
  return out;
}

// Divide [since,until] em janelas de `tam` dias — a Meta trava (#2) consultas
// diárias muito longas (level=ad + time_increment=1 por muitos dias).
function janelas(since, until, tam = 30) {
  const out = [];
  let ini = since;
  while (ini <= until) {
    const d = new Date(ini + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + tam - 1);
    let fim = d.toISOString().slice(0, 10);
    if (fim > until) fim = until;
    out.push({ since: ini, until: fim });
    const n = new Date(fim + 'T12:00:00Z'); n.setUTCDate(n.getUTCDate() + 1);
    ini = n.toISOString().slice(0, 10);
  }
  return out;
}

// ── Coletas ────────────────────────────────────────────────────────────────
async function coletarDiarioCriativo(since, until) {
  const map = new Map();
  for (const w of janelas(since, until, 30)) {
    const rows = await metaGetAll(`${ACCT}/insights`, {
      level: 'ad',
      time_increment: 1,
      time_range: { since: w.since, until: w.until },
      fields: 'ad_id,ad_name,spend,impressions,clicks,actions',
    });
    for (const r of rows) {
      const label = rotulo(r.ad_name);
      const key = `${r.date_start}|${label}`;
      const cur = map.get(key) || {
        data: r.date_start, conta_id: ACCT, criativo_id: label,
        criativo_nome: `${label} - Geradores de Energia`, objetivo: 'messaging_conversation',
        spend: 0, impressoes: 0, cliques: 0, conversas: 0,
      };
      cur.spend += Number(r.spend || 0);
      cur.impressoes += Number(r.impressions || 0);
      cur.cliques += Number(r.clicks || 0);
      cur.conversas += conversasDe(r.actions);
      map.set(key, cur);
    }
  }
  for (const v of map.values()) v.spend = arred2(v.spend);
  return [...map.values()];
}

async function coletarDiarioRegiao(since, until) {
  const map = new Map();
  for (const w of janelas(since, until, 30)) {
    const rows = await metaGetAll(`${ACCT}/insights`, {
      breakdowns: 'region',
      time_increment: 1,
      time_range: { since: w.since, until: w.until },
      fields: 'spend,actions',
    });
    for (const r of rows) {
      const regiao = r.region || '—';
      const key = `${r.date_start}|${regiao}`;
      // conversa por região = proxy (1ª resposta), sempre marcado proxy:true
      const cur = map.get(key) || { data: r.date_start, conta_id: ACCT, regiao, spend: 0, conversas: 0, proxy: true };
      cur.spend += Number(r.spend || 0);
      cur.conversas += proxyRegiaoDe(r.actions);
      map.set(key, cur);
    }
  }
  for (const v of map.values()) v.spend = arred2(v.spend);
  return [...map.values()];
}

// Imagem re-hospedada + status por rótulo (não é por dia). `labelsAlvo` = só os
// rótulos que tiveram gasto na janela (evita re-subir imagem de criativo antigo
// a cada tick). Set vazio/ausente = processa todos.
async function atualizarCriativos(client, labelsAlvo = null) {
  const ads = await metaGetAll(`${ACCT}/ads`, {
    fields: 'name,effective_status,creative{image_url,thumbnail_url}',
    limit: 200,
  });
  const byLabel = new Map();
  for (const a of ads) {
    const label = rotulo(a.name);
    if (label === 'OUTROS') continue;
    if (labelsAlvo && labelsAlvo.size && !labelsAlvo.has(label)) continue;
    const info = byLabel.get(label) || { label, nome: `${label} - Geradores de Energia`, ativo: false, image: null };
    const ativo = a.effective_status === 'ACTIVE';
    if (ativo) info.ativo = true;
    const img = a.creative && (a.creative.image_url || a.creative.thumbnail_url);
    // preferir imagem de anúncio ativo; senão qualquer uma
    if (img && (!info.image || ativo)) info.image = img;
    byLabel.set(label, info);
  }

  try { await client.storage.createBucket(BUCKET, { public: true }); } catch (_) { /* já existe */ }

  const out = [];
  for (const info of byLabel.values()) {
    const row = {
      criativo_id: info.label, conta_id: ACCT, nome: info.nome,
      objetivo: 'messaging_conversation', status: info.ativo ? 'ativo' : 'pausado',
      atualizado_em: new Date().toISOString(),
    };
    if (info.image) {
      try {
        const resp = await fetch(info.image);
        const buf = Buffer.from(await resp.arrayBuffer());
        const ct = resp.headers.get('content-type') || 'image/jpeg';
        const path = `${info.label}.png`;
        const up = await client.storage.from(BUCKET).upload(path, buf, { upsert: true, contentType: ct });
        if (!up.error) row.imagem_url = `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
        else console.warn(`[trafego] upload ${info.label} falhou:`, up.error.message);
      } catch (e) {
        console.warn(`[trafego] imagem ${info.label} falhou:`, e.message);
      }
    }
    // se não conseguiu imagem, NÃO manda imagem_url (mantém a que já estava no banco)
    out.push(row);
  }
  return out;
}

export async function coletarTrafego({ dias = 35 } = {}) {
  checarEnv();
  const until = hojeBR();
  const since = menosDias(until, dias);
  const client = sb();

  const crit = await coletarDiarioCriativo(since, until);
  const reg = await coletarDiarioRegiao(since, until);
  const stamp = new Date().toISOString();
  crit.forEach((r) => (r.atualizado_em = stamp));
  reg.forEach((r) => (r.atualizado_em = stamp));

  if (crit.length) {
    const { error } = await client.from('trafego_diario').upsert(crit, { onConflict: 'data,conta_id,criativo_id' });
    if (error) throw new Error('upsert trafego_diario: ' + error.message);
  }
  if (reg.length) {
    const { error } = await client.from('trafego_diario_regiao').upsert(reg, { onConflict: 'data,conta_id,regiao' });
    if (error) throw new Error('upsert trafego_diario_regiao: ' + error.message);
  }
  const labelsComGasto = new Set(crit.filter((r) => r.spend > 0).map((r) => r.criativo_id));
  const crm = await atualizarCriativos(client, labelsComGasto);
  if (crm.length) {
    const { error } = await client.from('trafego_criativo').upsert(crm, { onConflict: 'criativo_id' });
    if (error) throw new Error('upsert trafego_criativo: ' + error.message);
  }

  const resumo = { since, until, linhas_criativo: crit.length, linhas_regiao: reg.length, imagens: crm.filter((c) => c.imagem_url).length };
  console.log(`✓ tráfego ${since}→${until}: ${resumo.linhas_criativo} dia×criativo · ${resumo.linhas_regiao} dia×região · ${resumo.imagens} imagens`);
  return resumo;
}

// Loop automático embutido — o server chama no boot. Backfill 1x, depois re-puxa a
// janela recente a cada N min (pega ajuste de atribuição). Sai quieto sem token (dev).
export function iniciarColetaAutomatica() {
  if (!process.env.META_SYSTEM_USER_TOKEN) {
    console.log('[trafego] coleta automática OFF (sem META_SYSTEM_USER_TOKEN)');
    return;
  }
  const intervaloMin  = Number(process.env.TRAFEGO_INTERVALO_MIN || 30);
  const janelaDias    = Number(process.env.TRAFEGO_JANELA_DIAS || 35);
  const backfillDias  = Number(process.env.TRAFEGO_BACKFILL_DIAS || 120);
  let primeira = true;
  const tick = async () => {
    const dias = primeira ? backfillDias : janelaDias;
    try { await coletarTrafego({ dias }); }
    catch (e) { console.error('[trafego] tick erro:', e.message); }
    finally { primeira = false; }
  };
  console.log(`[trafego] coleta automática ON — backfill ${backfillDias}d, depois ${janelaDias}d a cada ${intervaloMin}min`);
  tick();
  setInterval(tick, intervaloMin * 60 * 1000);
}
