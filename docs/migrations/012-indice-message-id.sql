-- 012 — índice pro anti-loop da API oficial.
--
-- Com a uazapi, o eco das nossas próprias mensagens era filtrado pelo provedor
-- (excludeMessages: wasSentByApi). A API oficial não filtra: o bridge reconhece
-- o eco comparando o id do WhatsApp com o que gravamos. Essa consulta roda a
-- cada eco humano, em `mensagens` — a tabela que mais cresce do schema.
--
-- Índice parcial: só as linhas com id preenchido interessam (as antigas, da
-- uazapi, têm NULL e nunca são consultadas por aqui).

CREATE INDEX IF NOT EXISTS idx_mensagens_message_id
  ON mensagens (uazapi_message_id)
  WHERE uazapi_message_id IS NOT NULL;
