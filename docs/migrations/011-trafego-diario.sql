-- 011: tráfego DIA A DIA (Meta) — faz o seletor de período do dashboard valer
-- também pra aba Tráfego. Substitui o modelo de "snapshot único de janela fixa":
-- agora o worker grava métricas por dia × criativo (e por dia × região), e o
-- endpoint /api/trafego soma o intervalo que o usuário escolheu (7d/30d/custom),
-- igual às abas Bruno e Lúcio. Idempotente (roda quantas vezes precisar).
--
-- Fonte: Graph API da Meta (act_211274648569722), token System User (ads_read),
-- coletado por scripts/coletar-trafego.js. NÃO inventa número — só grava o que a
-- Meta devolve. Dias sem veiculação simplesmente não têm linha (= zero na soma).

create table if not exists trafego_diario (
  id             bigint generated always as identity primary key,
  data           date        not null,              -- dia (calendário Meta)
  conta_id       text        not null,
  criativo_id    text        not null,              -- rótulo do anúncio: AD01, AD02, AD03...
  criativo_nome  text,
  objetivo       text,
  spend          numeric     not null default 0,
  impressoes     bigint      not null default 0,
  cliques        bigint      not null default 0,
  conversas      integer     not null default 0,    -- messaging_conversation_started_7d
  atualizado_em  timestamptz not null default now(),
  unique (data, conta_id, criativo_id)
);
create index if not exists idx_trafego_diario_data on trafego_diario (conta_id, data);

create table if not exists trafego_diario_regiao (
  id             bigint generated always as identity primary key,
  data           date        not null,
  conta_id       text        not null,
  regiao         text        not null,
  spend          numeric     not null default 0,
  conversas      integer     not null default 0,
  proxy          boolean     not null default false,
  atualizado_em  timestamptz not null default now(),
  unique (data, conta_id, regiao)
);
create index if not exists idx_trafego_diario_regiao_data on trafego_diario_regiao (conta_id, data);

-- 1 linha por rótulo de criativo: imagem re-hospedada + status atual (ativo/pausado).
-- A imagem não é por dia; fica aqui e o endpoint faz o join com a soma diária.
create table if not exists trafego_criativo (
  criativo_id    text        primary key,           -- AD01, AD02...
  conta_id       text,
  nome           text,
  objetivo       text,
  status         text,                               -- 'ativo' | 'pausado'
  imagem_url     text,
  atualizado_em  timestamptz not null default now()
);
