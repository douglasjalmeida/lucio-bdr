import 'dotenv/config';
const BASE = (process.env.CHATWOOT_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.CHATWOOT_API_TOKEN;
const ACC = process.env.CHATWOOT_ACCOUNT_ID;

// busca conversa do lead 385 (telefone +554896990020)
const sr = await fetch(`${BASE}/api/v1/accounts/${ACC}/contacts/search?q=%2B554896990020`, {
  headers: { 'api_access_token': TOKEN },
}).then(r => r.json());
const contato = (sr?.payload || []).find(c => c.phone_number === '+554896990020');
console.log('contato.id:', contato?.id);

const convs = await fetch(`${BASE}/api/v1/accounts/${ACC}/contacts/${contato.id}/conversations`, {
  headers: { 'api_access_token': TOKEN },
}).then(r => r.json());
const conv = convs?.payload?.[0];
console.log('conversation.id:', conv?.id);

const labels = await fetch(`${BASE}/api/v1/accounts/${ACC}/conversations/${conv.id}/labels`, {
  headers: { 'api_access_token': TOKEN },
}).then(r => r.json());
console.log('labels atuais:', labels?.payload || labels);
