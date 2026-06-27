-- 010: conversões por região no snapshot de tráfego (Incremento B do dashboard)
-- O snapshot de Meta hoje guarda total + por criativo, mas NÃO de onde vêm as
-- conversas. Esta coluna guarda o breakdown por região da Meta:
--   por_regiao = [{ "regiao": "SC", "conversas": 9, "investimento": 412.30, "cpl": 45.81, "proxy": false }, ...]
-- Quando a Meta não entregar a conversa de mensagem quebrada por região, o
-- pipeline grava cliques no link / leads por região como PROXY e marca
-- "proxy": true (o dashboard rotula "(proxy: cliques)"). Idempotente.
ALTER TABLE trafego_snapshots
  ADD COLUMN IF NOT EXISTS por_regiao jsonb NOT NULL DEFAULT '[]'::jsonb;
