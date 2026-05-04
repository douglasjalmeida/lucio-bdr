-- ─────────────────────────────────────────────────────────────────────────────
-- Lúcio BDR — Schema Supabase (DDL versionada)
-- Rodar no SQL Editor do projeto Supabase Luminus → Lúcio.
-- RLS desligado no MVP (bridge usa service_role). Liga depois com dashboard/auth.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Catálogo de cadências ──────────────────────────────────────────────────
create table if not exists cadencias (
  id            bigserial primary key,
  nome          text not null unique,
  total_passos  int  not null,
  ativa         bool not null default true,
  criado_em     timestamptz not null default now()
);

create table if not exists passos_cadencia (
  id                   bigserial primary key,
  cadencia_id          bigint not null references cadencias(id) on delete cascade,
  ordem                int    not null,
  dias_apos_anterior   int    not null,                       -- T+0=0; próximo passo soma dias_apos_anterior ao executado_em do anterior
  prompt_orientacao    text   not null,                       -- instrução curta pro Lúcio formular o toque
  ativa                bool   not null default true,
  unique (cadencia_id, ordem)
);

-- ─── Leads e estado ─────────────────────────────────────────────────────────
create table if not exists leads (
  id              bigserial primary key,
  nome            text,
  empresa         text,
  telefone        text not null unique,                       -- E.164 (ex: +5562999999999)
  segmento        text,
  origem          text not null default 'csv-manual',         -- csv-manual | chatwoot | sheets | inbound
  status          text not null default 'novo',               -- novo | em_cadencia | engajado | qualificado | handoff | encerrado
  modo            text not null default 'bot',                -- bot | mudo
  cadencia_id     bigint references cadencias(id),
  passo_atual     int  not null default 0,
  motivo_encerramento text,                                   -- pediu_parar | frio | sem_fit | qualificado_handoff | outro
  chatwoot_contact_id      bigint,                            -- preenche em F3
  chatwoot_conversation_id bigint,                            -- preenche em F3
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);

create index if not exists idx_leads_status on leads(status);
create index if not exists idx_leads_modo on leads(modo);
create index if not exists idx_leads_cadencia on leads(cadencia_id, passo_atual);

-- ─── Histórico de mensagens ─────────────────────────────────────────────────
create table if not exists mensagens (
  id                bigserial primary key,
  lead_id           bigint not null references leads(id) on delete cascade,
  chatid            text,                                     -- chatid uazapi (telefone@s.whatsapp.net)
  direcao           text not null,                            -- in | out
  autor             text not null,                            -- lead | ia | humano
  texto             text not null,
  passo             int,                                      -- preenchido em mensagens out de cadência
  modo_no_momento   text,                                     -- bot | mudo (snapshot)
  enviada_em        timestamptz not null default now(),
  uazapi_message_id text,
  status            text,                                     -- enviada | entregue | lida | falhou
  tokens_in         int,
  tokens_out        int,
  custo_usd         numeric(10, 6)
);

create index if not exists idx_mensagens_lead_data on mensagens(lead_id, enviada_em desc);
create index if not exists idx_mensagens_chatid on mensagens(chatid);

-- ─── Eventos analíticos ─────────────────────────────────────────────────────
create table if not exists eventos (
  id           bigserial primary key,
  lead_id      bigint references leads(id) on delete set null,
  tipo         text not null,                                 -- handoff_solicitado | handoff_concluido | devolvido_bot | qualificado | encerrado_lead | encerrado_lucio | erro_envio | etc
  payload_json jsonb,
  criado_em    timestamptz not null default now()
);

create index if not exists idx_eventos_tipo_data on eventos(tipo, criado_em desc);
create index if not exists idx_eventos_lead on eventos(lead_id);

-- ─── Fila de outbound (cadência) ────────────────────────────────────────────
create table if not exists agendamentos_disparos (
  id                  bigserial primary key,
  lead_id             bigint not null references leads(id) on delete cascade,
  passo               int not null,
  agendado_para       timestamptz not null,
  status              text not null default 'pendente',       -- pendente | enviado | cancelado | falhou
  campanha_uazapi_id  text,                                   -- id da campanha /sender/advanced
  executado_em        timestamptz,
  criado_em           timestamptz not null default now()
);

create index if not exists idx_agendamentos_status_data on agendamentos_disparos(status, agendado_para);

-- ─── Trigger atualizado_em em leads ─────────────────────────────────────────
create or replace function trg_leads_atualizado_em() returns trigger as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists leads_atualizado_em on leads;
create trigger leads_atualizado_em
  before update on leads
  for each row execute function trg_leads_atualizado_em();

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Ligado sem policies: bridge usa service_role (bypassa RLS); anon bloqueado.
-- Quando expor algo pra dashboard/auth, escrever policy específica.
alter table cadencias              enable row level security;
alter table passos_cadencia        enable row level security;
alter table leads                  enable row level security;
alter table mensagens              enable row level security;
alter table eventos                enable row level security;
alter table agendamentos_disparos  enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: cadência piloto MVP — Geradores B2B
-- Decisão A3 (2026-05-04): 1 cadência, 2 toques (T+0 e T+9).
-- prompt_orientacao fica genérico — refinar no Bloco C.
-- ─────────────────────────────────────────────────────────────────────────────

insert into cadencias (nome, total_passos, ativa)
values ('geradores-b2b-v1', 2, true)
on conflict (nome) do nothing;

insert into passos_cadencia (cadencia_id, ordem, dias_apos_anterior, prompt_orientacao)
select c.id, 1, 0,
  'Toque 1 (T+0): apresenta Luminus, gancho curto sobre geradores, pergunta de descoberta. Tom comercial mas humano. Refinar no Bloco C da spec.'
from cadencias c where c.nome='geradores-b2b-v1'
on conflict (cadencia_id, ordem) do nothing;

insert into passos_cadencia (cadencia_id, ordem, dias_apos_anterior, prompt_orientacao)
select c.id, 2, 9,
  'Toque 2 (T+9, último): follow-up se não respondeu o T+0. Reforça oferta, pergunta de novo, deixa porta aberta. Refinar no Bloco C da spec.'
from cadencias c where c.nome='geradores-b2b-v1'
on conflict (cadencia_id, ordem) do nothing;
