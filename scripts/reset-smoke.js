// Reset completo do smoke test:
//   1. Apaga conversa + contato do lead atual no Chatwoot (telefone Douglas)
//   2. Apaga lead no Supabase (CASCADE limpa mensagens/agendamentos/lead_obras)
//   3. Reclona lead 56 (Willian Raphalski / GADENS) com telefone Douglas
//   4. Vincula as 19 obras
//
// Idempotente — pode rodar várias vezes.

import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';

const TELEFONE = '+554896990020';
const ORIGEM_ID = 56;

const CW_BASE = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
const CW_TOKEN = process.env.CHATWOOT_API_TOKEN;
const CW_ACC = process.env.CHATWOOT_ACCOUNT_ID;

async function cw(method, path, body = null) {
  const opts = { method, headers: { 'api_access_token': CW_TOKEN, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${CW_BASE}/api/v1/accounts/${CW_ACC}${path}`, opts);
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`Chatwoot ${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`);
  return json;
}

// 1. Chatwoot — busca contato pelo telefone
const q = encodeURIComponent(TELEFONE);
const sr = await cw('GET', `/contacts/search?q=${q}&include=contact_inboxes`);
const contato = (sr?.payload || []).find(c => c.phone_number === TELEFONE);
if (contato) {
  console.log(`📋 Contato Chatwoot id=${contato.id} — buscando conversas`);
  const convs = await cw('GET', `/contacts/${contato.id}/conversations`);
  const lista = convs?.payload || [];
  for (const c of lista) {
    try {
      await cw('DELETE', `/conversations/${c.id}`);
      console.log(`🗑️  Conversa Chatwoot ${c.id} apagada`);
    } catch (e) { console.warn(`⚠️  Falhou apagar conversa ${c.id}: ${e.message}`); }
  }
  try {
    await cw('DELETE', `/contacts/${contato.id}`);
    console.log(`🗑️  Contato Chatwoot ${contato.id} apagado`);
  } catch (e) { console.warn(`⚠️  Falhou apagar contato: ${e.message}`); }
} else {
  console.log('ℹ️  Sem contato Chatwoot pra esse telefone');
}

// 2. Supabase — apaga lead pelo telefone (CASCADE)
const { data: delLead } = await supabase
  .from('leads').delete().eq('telefone', TELEFONE).select('id, nome');
console.log(`🗑️  Supabase lead apagado:`, delLead);

// 3. Reclona lead 56
const { data: origem } = await supabase.from('leads').select('*').eq('id', ORIGEM_ID).single();
const novo = {
  nome: origem.nome, empresa: origem.empresa, telefone: TELEFONE,
  tipo_empresa: origem.tipo_empresa, cargo: origem.cargo, email: origem.email,
  cnpj: origem.cnpj, razao_social: origem.razao_social, cnae_primario: origem.cnae_primario,
  capital_social: origem.capital_social, situacao_cadastral: origem.situacao_cadastral,
  data_abertura_empresa: origem.data_abertura_empresa, tags: origem.tags,
  segmento: origem.segmento, origem: 'smoke-test-gadens',
  status: 'novo', modo: 'bot', cadencia_id: null,
};
const { data: criado, error: errCriar } = await supabase.from('leads').insert(novo).select().single();
if (errCriar) throw errCriar;
console.log(`✅ Lead clonado: id=${criado.id} telefone=${criado.telefone}`);

// 4. Vincula obras
const { data: links } = await supabase.from('lead_obras').select('*').eq('lead_id', ORIGEM_ID);
const novosLinks = links.map(l => ({
  lead_id: criado.id, obra_id: l.obra_id,
  contato_nome: l.contato_nome, contato_cargo: l.contato_cargo, contato_email: l.contato_email,
}));
const { error: errInsLinks } = await supabase.from('lead_obras').insert(novosLinks);
if (errInsLinks) throw errInsLinks;
console.log(`✅ ${novosLinks.length} obras vinculadas`);

console.log('\n🎯 Pronto. Próximo:');
console.log(`   node scripts/enrolar-leads-do-dia.js --telefone ${TELEFONE}`);
console.log(`   curl -X POST https://lucio-bridge.2ep3tp.easypanel.host/outbound-batch -H "Content-Type: application/json" -d '{"limite":1}'`);
