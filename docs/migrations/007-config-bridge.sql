-- F6+: controle global do envio outbound pelo dashboard.
-- Tabela chave/valor pra estado de runtime do bridge que precisa sobreviver a
-- restart (Easypanel recicla o container). Hoje guarda só o estado do outbound,
-- mas serve pra qualquer flag operacional futura.
--
-- Estado do outbound (chave 'outbound_estado'):
--   ativo     → batch dispara normalmente (default)
--   pausado   → batch NÃO dispara; agendamentos ficam pendentes intactos
--   encerrado → igual pausado, intenção de parar a campanha (reversível)
--
-- Pausar e encerrar bloqueiam o envio do mesmo jeito; a diferença é semântica
-- (temporário vs. fim da campanha) e fica registrada em valor + atualizado_por.

create table if not exists config_bridge (
  chave          text primary key,
  valor          text not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por text
);

insert into config_bridge (chave, valor, atualizado_por)
values ('outbound_estado', 'ativo', 'migration-007')
on conflict (chave) do nothing;
