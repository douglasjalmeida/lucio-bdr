-- Espelho Chatwoot → CRM externo (funis Marketing/Vendas).
-- Guarda o id do card no CRM pra idempotência do espelho (crm-client.js):
--   crm_lead_id  → id do lead no funil de Marketing (MQL)
--   crm_deal_id  → id do negócio no funil de Vendas (SQL)
--
-- Por que precisa: o negócio no funil de vendas NÃO grava telefone pesquisável
-- (by-phone busca via contato/empresa vinculado, e a API externa não expõe
-- contato), então sem o id salvo cada transição SQL recriaria o negócio.
-- Mesmo no marketing, o id salvo desambigua telefone compartilhado (matriz).
--
-- Mesmo padrão das colunas chatwoot_contact_id / chatwoot_conversation_id.

alter table leads add column if not exists crm_lead_id bigint;  -- card no funil Marketing
alter table leads add column if not exists crm_deal_id bigint;  -- card no funil Vendas
