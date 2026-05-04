---
name: lucio-followup
description: Especialista em cadência e follow-up do Lúcio BDR — implementa, debuga e ajusta o motor de cadência (Supabase + cadence-engine.js + WF-Lucio-Outbound + uazapi /sender/advanced). Use sempre que Douglas mencionar "cadência", "follow-up", "toque", "passo da cadência", "agendar disparo", "outbound", "T+0/T+9", "reset de cadência", "lead respondeu zera", "janela de envio", "jitter", "/sender/advanced", "agendamentos_disparos", "passos_cadencia", "WF-Lucio-Outbound", ou qualquer variação de cadência comercial do Lúcio. Vale também quando ele perguntar "por que esse lead não recebeu toque?" ou "o follow-up zerou?".
---

# Skill — Cadência e Follow-up do Lúcio BDR

## Regra de ouro

> **Cadência é dado, não código.** Quem manda no follow-up é o **schema do Supabase** (`cadencias`, `passos_cadencia`, `agendamentos_disparos`), não um worker em loop. Bridge Lúcio + uazapi `/sender/advanced` são só executores. Se for tentado a escrever lógica de "esperar N segundos / contar dias", pare — provavelmente é query SQL.

## Arquitetura (de docs/spec-lucio-bdr.md §3 + Bloco D)

```
agendador-claudio (cron seg-sex 08h00 BRT)
    │
    └── POST lucio-bridge:/outbound-batch
            │
            └── cadence-engine.js
                ├── SELECT leads devendo toque hoje (Supabase)
                ├── Formula mensagem via Claude SDK por lead (com contexto histórico)
                ├── Divide em 2 lotes: manhã (09:05) e tarde (13:35)
                ├── POST n8n WF-Lucio-Outbound (lote 1)
                ├── POST n8n WF-Lucio-Outbound (lote 2)
                └── Pra cada lead enfileirado:
                    ├── UPDATE agendamentos_disparos SET status='enviado', executado_em=now()
                    ├── INSERT próximo agendamento (passo+1, agendado_para=hoje+dias_apos_anterior do passo+1)
                    └── chatwoot.aplicarLabel + setCustomAttribute + moverPipeline (ativo F3)

n8n WF-Lucio-Outbound
    └── POST uazapi /sender/advanced
            (delayMin: 180, delayMax: 600, scheduled_for: <hora_lote>)
        uazapi distribui mensagens na janela com jitter NATIVO

lucio-bridge:/in (lead respondeu)
    ├── grava mensagem in
    ├── UPDATE agendamentos_disparos SET status='cancelado' WHERE lead_id=X AND status='pendente'
    ├── UPDATE leads SET status='engajado' (se não estiver já)
    ├── chatwoot.removerLabel('cadencia-passo-*'), aplicarLabel('engajado')   ← F3
    └── (se modo=bot) responde via Claude SDK normalmente
```

## Cadência piloto MVP (decisão A3 — 2026-05-04)

- **1 cadência só:** `geradores-b2b-v1` (id 1).
- **2 toques:** T+0 (entrada) e T+9 (follow-up único). Sem T+2, T+14.
- **Critérios de saída:**
  - `engajado` — lead respondeu (qualquer mensagem) → `agendamentos_disparos` futuros viram `cancelado`, lead sai da cadência ativa.
  - `encerrado:pediu_parar` — lead pediu pra parar a qualquer momento.
  - `encerrado:frio` — esgotou T+0 e T+9 sem responder.
- **Locação Inteligente fora do MVP** (entra como `cadencia_id=2` quando habilitar).

Schema relevante (já em `docs/supabase-schema.sql`):
```sql
cadencias (id, nome, total_passos, ativa)
passos_cadencia (cadencia_id, ordem, dias_apos_anterior, prompt_orientacao)
agendamentos_disparos (lead_id, passo, agendado_para, status, campanha_uazapi_id, executado_em)
```

## Janelas de envio (decisão Douglas — 2026-05-04)

**Duas janelas com almoço no meio:**
- Manhã: `09:00–12:00` BRT (America/Sao_Paulo)
- Tarde: `13:30–17:30` BRT
- Apenas dias úteis (seg-sex).
- Jitter mínimo 3min (180s) entre mensagens consecutivas do mesmo lote.

Implementação: `cadence-engine.js` divide o batch em 2 lotes (manhã/tarde) baseado no volume de leads devidos hoje. Cada lote vira 1 chamada `/sender/advanced` da uazapi com `scheduled_for=09:05` ou `13:35` e `delayMin/Max=180/600`. uazapi distribui sozinha com jitter respeitando a hora final natural da janela.

Variáveis em `.env` / Easypanel:
```
OUTBOUND_WINDOW_MORNING_START=09:00
OUTBOUND_WINDOW_MORNING_END=12:00
OUTBOUND_WINDOW_AFTERNOON_START=13:30
OUTBOUND_WINDOW_AFTERNOON_END=17:30
OUTBOUND_DELAY_MIN_SEC=180
OUTBOUND_DELAY_MAX_SEC=600
```

## Reset de cadência

Quando o bridge recebe `/in` com `autor=lead`:

```js
// 1 linha — reset acontece sozinho
await supabase
  .from('agendamentos_disparos')
  .update({ status: 'cancelado' })
  .eq('lead_id', leadId)
  .eq('status', 'pendente');

await atualizarLead(leadId, { status: 'engajado' });
```

**Não tentar re-criar agendamentos depois disso.** Se o lead voltar a ficar frio (silêncio prolongado em `engajado`), aí sim entra outra lógica (futuro), não MVP.

## Mapeamento Chatwoot — labels + pipeline (F3)

A cada toque enviado e a cada evento de cadência, aplicar:

| Evento | Ação Chatwoot |
|---|---|
| 1º toque enviado (T+0) | label `cadencia-passo-1` + custom_attribute `lucio_passo=1` + pipeline `Em Cadência` |
| 2º toque enviado (T+9) | label `cadencia-passo-2` + custom_attribute `lucio_passo=2` |
| Lead respondeu antes do final | label `engajado` + remove `cadencia-passo-*` + pipeline `Engajado` |
| Lead pediu pra parar | label `optout` + pipeline `Encerrado-OptOut` |
| Esgotou cadência sem resposta | label `frio` + pipeline `Encerrado-Frio` |
| Qualificado → handoff | label `handoff-closer` + pipeline `Closer Atuando` + assign closer (round-robin via CHATWOOT_CLOSER_IDS) + nota privada |

**Ativo só quando MCP Chatwoot custom existir (F3).** Em F2, `src/mcps.js` continua no-op — bridge tolera Chatwoot off.

## Origem dos leads e como entram em cadência

- CSV manual em `docs/inbox/<arquivo>.csv` → `scripts/importar-leads.js` → INSERT em `leads` com `origem='csv-manual'`.
- Pra cada lead novo importado, **se cadencia_id é setado**, criar agendamento inicial:
  ```sql
  INSERT INTO agendamentos_disparos (lead_id, passo, agendado_para, status)
  VALUES (X, 1, now(), 'pendente');
  ```
  T+0 = "primeira oportunidade hoje". O cron 08h pega no próximo dia útil.

## Endpoints relevantes

- `POST /outbound-batch` no bridge — chamado pelo agendador-claudio. Sem body necessário; bridge consulta Supabase.
- `POST /in` no bridge — já existe; só adicionar lógica de reset.
- `POST /handoff-return` no bridge — já existe; quando label `devolver-lucio` aplicada no Chatwoot.

## Como debugar quando "lead não recebeu toque"

Ordem de diagnóstico:

1. Ver `leads.modo` — se `mudo`, bridge não responde mas cadência também não envia (regra). UPDATE pra `bot` se for o caso.
2. Ver `leads.status` — se `encerrado`/`handoff`/`qualificado`, está fora da cadência por design.
3. Ver `agendamentos_disparos` do lead: tem linha `pendente` com `agendado_para <= now()`?
   - Não → cadência não foi enfileirada. Verificar se importação criou agendamento inicial.
   - Sim → falha está no cron/bridge/n8n. Checar logs.
4. Ver `eventos` do lead — log de tudo que aconteceu (handoff, devolvido_bot, qualificado).
5. Ver `mensagens` ordenado por `enviada_em` — confirma o que saiu.
6. Verificar Executions do `WF-Lucio-Outbound` no n8n.
7. Verificar resposta da uazapi (`campanha_uazapi_id` em `agendamentos_disparos`).

## Queries SQL úteis (cole no SQL Editor pra debugar)

```sql
-- Leads em cadência ativa
SELECT id, nome, telefone, status, modo, cadencia_id, passo_atual, atualizado_em
FROM leads
WHERE status = 'em_cadencia' AND modo = 'bot'
ORDER BY atualizado_em DESC;

-- Próximos toques agendados
SELECT a.lead_id, l.nome, l.telefone, a.passo, a.agendado_para, a.status
FROM agendamentos_disparos a
JOIN leads l ON l.id = a.lead_id
WHERE a.status = 'pendente'
ORDER BY a.agendado_para;

-- Leads que deviam ter recebido toque hoje
SELECT a.lead_id, l.telefone, a.passo, a.agendado_para
FROM agendamentos_disparos a JOIN leads l ON l.id = a.lead_id
WHERE a.status = 'pendente'
  AND a.agendado_para <= now()
  AND l.modo = 'bot'
  AND l.status NOT IN ('encerrado', 'handoff', 'qualificado');

-- Histórico de cadência de um lead específico
SELECT 'mensagem' AS tipo, enviada_em AS quando, direcao, autor, texto, passo
FROM mensagens WHERE lead_id = $1
UNION ALL
SELECT 'evento', criado_em, tipo, NULL, payload_json::text, NULL
FROM eventos WHERE lead_id = $1
UNION ALL
SELECT 'agendamento', agendado_para, status, NULL, NULL, passo
FROM agendamentos_disparos WHERE lead_id = $1
ORDER BY quando;
```

## Arquivos principais (a serem criados em F2)

- `src/cadence-engine.js` — lê agendamentos, formula mensagens via Claude SDK, posta no n8n.
- `src/server.js` — implementar `POST /outbound-batch` (hoje retorna 501).
- `src/server.js` — adicionar reset no fluxo do `/in`.
- workflow n8n `WF-Lucio-Outbound` — ainda não existe; cria via skill `n8n-architect`.

## O que NÃO fazer

- Não escrever app Python separada — Postgres + uazapi `/sender/advanced` resolvem tudo.
- Não fazer loop com `setInterval` esperando dias passarem — agendador-claudio + cron 08h é o relógio.
- Não tentar enviar batch fora da janela 09–12 / 13:30–17:30 — uazapi distribui dentro da janela via `scheduled_for`.
- Não criar agendamento futuro quando lead é importado se `cadencia_id` é null — só quem entra na cadência mesmo.
- Não ignorar dia útil — query precisa filtrar `dow IN (1..5)`.
- Não responder mensagens enquanto lead estiver em modo `mudo` (handoff em andamento).
