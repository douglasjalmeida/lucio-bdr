# Padrões de design — workflows n8n

## Idempotência

Workflow tem que poder rodar 2x com mesmo input sem causar duplicação. Estratégias:

- **Dedup por chave externa:** antes de criar registro X, fazer `GET` checando se já existe (por ID externo, hash do payload).
- **Hash do payload:** `crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')` em nó Code, salvar em store (Sheets/DB) e checar antes.
- **Webhook com event ID:** se a fonte manda ID único do evento, usar ele como dedupe key.

## Retry / backoff

Em todo HTTP Request:
- `Retry On Fail: true`
- `Max Tries: 3`
- `Wait Between Tries: 5000` (5s) — n8n não faz backoff exponencial nativo, mas 5s + 3 tentativas cobre 90% das falhas transitórias.

Para backoff exponencial real: usar Code + loop com `await new Promise(r => setTimeout(r, 2**attempt * 1000))`.

## Error Workflow global

Criar workflow `error-handler [claudio-v1]` com:
1. **Error Trigger** (gatilho)
2. **Set** — formatar mensagem (workflow name, node name, erro, timestamp)
3. **HTTP Request** ou **WhatsApp via uazapi** — notificar Douglas
4. **Sticky note**: "Workflow chamado quando qualquer outro workflow falha. Configurado em Settings → Error Workflow de cada workflow de produção."

Em cada workflow novo, em Settings → Error Workflow, apontar pra ele.

## Fan-out (1 input → N outputs)

- Webhook recebe → Code splita em items → próximo nó processa cada item.
- Items em n8n são naturalmente fan-out: nó seguinte é executado N vezes.

## Fan-in (N inputs → 1 output)

- Vários braços → Merge (`Append`) → próximo nó recebe array consolidado.

## Paginação

API com paginação:
1. Code inicial define `cursor = null`.
2. Loop com SplitInBatches (size=1) ou Code recursivo:
   - HTTP Request passando cursor.
   - Se response tem `nextCursor`, atualizar e continuar.
   - Se não, sair.
3. Acumular resultados em array.

Atalho: usar nó **HTTP Request** com `Pagination: true` (ele faz nativo se a API for padrão REST).

## Batch / rate limit

API com limite de 60 req/min:
- SplitInBatches `size: 10`
- Wait `1s` entre batches
- = 10 req/s, fica abaixo de 60/min com folga

## Sub-workflows (reuso)

Quando criar:
- Lógica usada por 2+ workflows (ex: "enviar mensagem WhatsApp formatada")
- Bloco > 5 nós que faz uma coisa coesa
- Lógica que muda independentemente do fluxo pai

Padrão de chamada:
```
[Pai] → Execute Workflow [enviar-whatsapp [claudio-v1]] → continua
```

Sub-workflow recebe items, retorna items. Naming: começar com verbo (`enviar-`, `validar-`, `enriquecer-`).

## Dedup recente (janela de tempo)

Mensagem WhatsApp pode chegar duplicada (uazapi reenvia). Estratégia:
- Code inicial calcula hash da mensagem.
- Lookup em **Static Data do workflow** (`$getWorkflowStaticData('global')`) — guarda hashes recentes (últimos 5min) com TTL.
- Se hash já existe → IF → branch "ignora" (sem nó nenhum).
- Senão → grava hash → continua.

## Validação de payload

Webhook → primeira coisa = nó Code "Validar Payload":
- Schema mínimo (campos obrigatórios)
- Tipos certos
- Se inválido → throw error com mensagem clara → cai no Error Workflow.
- Se válido → retorna item normalizado.

Evita erros profundos no fluxo por payload malformado.

## Estado entre execuções

Para workflows que precisam memória (ex: "última vez que rodei foi em..."):
- **Static Data:** `$getWorkflowStaticData('global').lastRun = $now.toISO()`. Persiste entre runs do mesmo workflow.
- Limitação: não compartilha entre workflows. Para isso, usar Sheets/DB externo.

## Pinned data (debug)

Em qualquer nó: clicar 📌 pra "pinar" a saída. Próximas execuções manuais usam dado pinado em vez de re-executar nós anteriores. **Limpar antes de ativar em prod.**
