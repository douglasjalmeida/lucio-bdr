-- 009: contador de tentativas em agendamentos_disparos
-- Mata o loop de regeneracao: um disparo que gera o toque (chamada Claude, custo)
-- mas falha no envio NAO pode ficar 'pendente' pra sempre, senao o tick regenera
-- no Claude a cada 60s indefinidamente. Com o contador, o disparo e re-tentado ate
-- um teto (OUTBOUND_MAX_TENTATIVAS) e depois marcado 'falha', saindo da fila.
ALTER TABLE agendamentos_disparos
  ADD COLUMN IF NOT EXISTS tentativas integer NOT NULL DEFAULT 0;
