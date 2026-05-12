-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002 — cadência em minutos + cadência de teste + 3 toques
-- 2026-05-04
--
-- Por quê:
--   - Schema original só tinha `dias_apos_anterior` (granularidade dia).
--   - Pra testar follow-up sem esperar dias, precisamos suportar minutos.
--   - Decisão (2026-05-04): 3 toques em vez de 2.
--
-- Estratégia:
--   - Adiciona coluna `delay_minutos` (canônica daqui pra frente).
--   - Backfill: dias_apos_anterior * 1440.
--   - Mantém `dias_apos_anterior` por compat (deprecated, remover depois).
--   - Cria cadência `geradores-b2b-v1-teste` com 3 passos em horas.
--   - Estende `geradores-b2b-v1` (prod) pra 3 passos.
-- ─────────────────────────────────────────────────────────────────────────────

alter table passos_cadencia
  add column if not exists delay_minutos int;

update passos_cadencia
   set delay_minutos = dias_apos_anterior * 1440
 where delay_minutos is null;

alter table passos_cadencia
  alter column delay_minutos set not null;

-- ─── Prod: estender geradores-b2b-v1 de 2 → 3 toques ────────────────────────
-- Toque 1: T+0       (já existe)
-- Toque 2: T+3 dias  (novo — entre os antigos)
-- Toque 3: T+6 dias após toque 2 (era o antigo "T+9" total)

-- Atualiza total_passos
update cadencias set total_passos = 3 where nome = 'geradores-b2b-v1';

-- Renumera o antigo passo 2 (T+9) pra passo 3, ajustando delay
update passos_cadencia
   set ordem = 3,
       dias_apos_anterior = 6,
       delay_minutos = 6 * 1440,
       prompt_orientacao = 'Toque 3 (T+6 dias após toque 2, último): última tentativa. Reforça valor curto, pergunta direta, deixa porta aberta sem pressão. Tag de teste se modo_teste.'
 where cadencia_id = (select id from cadencias where nome='geradores-b2b-v1')
   and ordem = 2;

-- Insere novo passo 2 (T+3 dias após toque 1)
insert into passos_cadencia (cadencia_id, ordem, dias_apos_anterior, delay_minutos, prompt_orientacao)
select c.id, 2, 3, 3*1440,
  'Toque 2 (T+3 dias após toque 1): reengajamento leve. Traz ângulo MPaaS/recorrência, pergunta aberta. Tag de teste se modo_teste.'
from cadencias c where c.nome='geradores-b2b-v1'
on conflict (cadencia_id, ordem) do nothing;

-- ─── Teste: nova cadência geradores-b2b-v1-teste (3 passos em horas) ────────
-- Toque 1: T+0
-- Toque 2: 2h após toque 1
-- Toque 3: 3h após toque 2

insert into cadencias (nome, total_passos, ativa)
values ('geradores-b2b-v1-teste', 3, true)
on conflict (nome) do nothing;

insert into passos_cadencia (cadencia_id, ordem, dias_apos_anterior, delay_minutos, prompt_orientacao)
select c.id, 1, 0, 0,
  'Toque 1 (T+0): apresentação Lúcio/Luminus, gancho curto sobre geradores, pergunta aberta de descoberta. Termina com "[teste: toque 1 — primeiro contato]".'
from cadencias c where c.nome='geradores-b2b-v1-teste'
on conflict (cadencia_id, ordem) do nothing;

insert into passos_cadencia (cadencia_id, ordem, dias_apos_anterior, delay_minutos, prompt_orientacao)
select c.id, 2, 0, 120,
  'Toque 2 (+2h após toque 1): reengajamento leve. Traz ângulo MPaaS, pergunta aberta. Termina com "[teste: toque 2 — 2h sem resposta]".'
from cadencias c where c.nome='geradores-b2b-v1-teste'
on conflict (cadencia_id, ordem) do nothing;

insert into passos_cadencia (cadencia_id, ordem, dias_apos_anterior, delay_minutos, prompt_orientacao)
select c.id, 3, 0, 180,
  'Toque 3 (+3h após toque 2, último): última tentativa. Pergunta direta, porta aberta sem pressão. Termina com "[teste: toque 3 — 3h sem resposta, último]".'
from cadencias c where c.nome='geradores-b2b-v1-teste'
on conflict (cadencia_id, ordem) do nothing;
