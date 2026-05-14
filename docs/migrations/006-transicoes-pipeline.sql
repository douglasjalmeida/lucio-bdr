-- F6: Dashboard de cadência + pipeline em tempo real.
-- Tabela dedicada pra todas as transições de etapa do funil (BDR → MQL → SQL).
-- Alimenta o dashboard com tempo médio entre etapas e timeline por lead.
--
-- Etapas válidas (string livre por flexibilidade, mas convenção):
--   novo, em-cadencia, mql-respondeu, mql-qualificado, humano-atendendo,
--   sql-contato-feito, sql-proposta, sql-negociacao, sql-ganho, sql-perdido,
--   devolvido-bot, encerrado, descartado

create table if not exists transicoes_pipeline (
  id          bigserial primary key,
  lead_id     bigint not null references leads(id) on delete cascade,
  cadencia_id bigint references cadencias(id),    -- desnormalizado pra facilitar filtro
  etapa_de    text,                                -- null no primeiro evento do lead
  etapa_para  text not null,
  origem      text not null default 'auto',        -- auto | manual | sistema | backfill
  payload_json jsonb,                              -- contexto extra (gatilho do Haiku, motivo, etc)
  criado_em   timestamptz not null default now()
);

create index if not exists idx_transicoes_lead_data on transicoes_pipeline(lead_id, criado_em);
create index if not exists idx_transicoes_etapa_data on transicoes_pipeline(etapa_para, criado_em desc);
create index if not exists idx_transicoes_cadencia on transicoes_pipeline(cadencia_id, criado_em desc);

-- View materializada não — usar query direta. Volume baixo (centenas/dia).

-- Backfill: derivado de `eventos` existentes. Idempotente via ON CONFLICT? Não,
-- não há unique constraint. Rodar 1x manualmente após criar a tabela.
-- (Backfill em arquivo separado pra Douglas rodar quando aplicar a migration.)
