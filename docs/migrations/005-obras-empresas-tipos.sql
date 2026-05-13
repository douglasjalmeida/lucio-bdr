-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005 — Suporte à base de obras (residencial)
-- Adiciona:
--   1. tabela `obras` (dados da pesquisa de obras: 1 linha por obra)
--   2. tabela `lead_obras` (M:N, lead ↔ obra com posição/papel)
--   3. colunas novas em `leads` (cargo, email, cnpj, razao_social, cnae_primario,
--      tipo_empresa, capital_social, situacao_cadastral, data_abertura_empresa,
--      score_credito, score_provider, score_atualizado_em, tags)
--
-- Não destrutivo: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Obras ──────────────────────────────────────────────────────────────────
create table if not exists obras (
  id                    bigserial primary key,
  codigo_externo        text unique,                            -- "Código" da pesquisa de obras (fonte externa)
  nome                  text,
  segmento              text,                                   -- residencial, comercial, industrial...
  subtipo               text,
  estagio_atual         text,                                   -- FUNDAÇÕES, ESTRUTURA, EM CONSTRUÇÃO...
  fase                  text,
  valor_investimento    numeric(14, 2),                         -- em R$
  area_construida_m2    numeric(12, 2),
  endereco              text,
  bairro                text,
  cidade                text,
  estado                text,                                   -- UF
  cep                   text,
  inicio_obra           date,
  termino_obra          date,
  n_edificios           int,
  n_pavimentos          int,
  n_unidades            int,
  detalhes              text,                                   -- texto rico (ex: "estrutura 70%, alvenaria 40%...")
  raw_json              jsonb,                                  -- linha completa da pesquisa (todos os campos não mapeados)
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);

create index if not exists idx_obras_estagio on obras(estagio_atual);
create index if not exists idx_obras_cidade  on obras(cidade);
create index if not exists idx_obras_estado  on obras(estado);

-- ─── M:N lead ↔ obra ────────────────────────────────────────────────────────
-- Um mesmo lead (telefone) pode aparecer em N obras (vários projetos sob mesma
-- empresa). Uma obra tem M contatos (até 22 no arquivo de pesquisa).
create table if not exists lead_obras (
  id              bigserial primary key,
  lead_id         bigint not null references leads(id) on delete cascade,
  obra_id         bigint not null references obras(id) on delete cascade,
  posicao         int,                                          -- 1-22 (posição do contato no arquivo)
  papel           text,                                         -- "contato_obra" | "responsavel" | "decisor"
  contato_nome    text,                                         -- nome da pessoa naquela posição (telefone é compartilhado pela empresa)
  contato_cargo   text,                                         -- cargo da pessoa naquela posição
  contato_email   text,                                         -- email específico daquele contato
  criado_em       timestamptz not null default now(),
  unique (lead_id, obra_id, posicao)
);

create index if not exists idx_lead_obras_lead on lead_obras(lead_id);
create index if not exists idx_lead_obras_obra on lead_obras(obra_id);

-- ─── Leads: novos campos ────────────────────────────────────────────────────
alter table leads add column if not exists cargo                   text;
alter table leads add column if not exists email                   text;
alter table leads add column if not exists cnpj                    text;
alter table leads add column if not exists razao_social            text;
alter table leads add column if not exists cnae_primario           text;    -- ex: "4120-4/00"
alter table leads add column if not exists tipo_empresa            text;    -- "construtora" | "incorporadora" | "ambos" | "indefinido"
alter table leads add column if not exists capital_social          numeric(14, 2);
alter table leads add column if not exists situacao_cadastral      text;    -- ATIVA | BAIXADA | SUSPENSA | NULA | INAPTA
alter table leads add column if not exists data_abertura_empresa   date;
alter table leads add column if not exists score_credito           int;     -- score real (Serasa/Boa Vista), 300-1000
alter table leads add column if not exists score_provider          text;    -- "serasa" | "bigboost" | "casadosdados" | null
alter table leads add column if not exists score_atualizado_em     timestamptz;
alter table leads add column if not exists tags                    jsonb default '[]'::jsonb;  -- ex: ["elegivel_locacao", "obra_grande", "cnae_4120"]

create index if not exists idx_leads_cnpj         on leads(cnpj);
create index if not exists idx_leads_tipo_empresa on leads(tipo_empresa);
create index if not exists idx_leads_cnae         on leads(cnae_primario);
create index if not exists idx_leads_tags_gin     on leads using gin(tags);
