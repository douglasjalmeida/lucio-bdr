# Expressões n8n — sintaxe e armadilhas

> n8n usa expressões `{{ }}` baseadas em JS. Acesso a contexto via variáveis especiais.

## Variáveis principais

| Var | O que é | Exemplo |
|---|---|---|
| `$json` | JSON do item atual | `{{ $json.email }}` |
| `$input.item` | Item completo (com binary etc) | `{{ $input.item.json.id }}` |
| `$input.all()` | Array de todos items | `{{ $input.all().length }}` |
| `$node["NomeDoNo"].json` | Saída de nó específico (primeiro item) | `{{ $node["Webhook"].json.body.email }}` |
| `$items("NomeDoNo")` | Array de items de outro nó | `{{ $items("HTTP Request").map(i => i.json.id) }}` |
| `$now` | Data/hora atual (Luxon DateTime) | `{{ $now.toISO() }}` |
| `$today` | Início do dia atual | `{{ $today.toFormat("yyyy-LL-dd") }}` |
| `$workflow.id` | ID do workflow | `{{ $workflow.id }}` |
| `$execution.id` | ID da execução | `{{ $execution.id }}` |
| `$env.VAR_NAME` | Env var (se permitido) | `{{ $env.API_KEY }}` |
| `$vars.X` | Variável de ambiente do n8n (Settings → Variables) | `{{ $vars.GITHUB_TOKEN }}` |

## Datas com Luxon

n8n usa Luxon DateTime, não Moment.

```js
{{ $now.toISO() }}                          // "2026-04-30T15:30:00.000-03:00"
{{ $now.toFormat("yyyy-LL-dd HH:mm") }}     // "2026-04-30 15:30"
{{ $now.minus({days: 7}).toISO() }}         // 7 dias atrás
{{ $now.plus({hours: 2}).toFormat("HH:mm") }}
{{ DateTime.fromISO($json.createdAt).toFormat("dd/LL/yyyy") }}
```

## Manipulação de array (lodash-like nativo)

```js
{{ $json.items.map(i => i.name) }}
{{ $json.items.filter(i => i.active) }}
{{ $json.items.find(i => i.id === "abc") }}
{{ $json.items.length }}
{{ $json.items.reduce((a, i) => a + i.value, 0) }}
```

## Strings

```js
{{ $json.email.toLowerCase() }}
{{ $json.name.trim() }}
{{ $json.text.split(",").map(s => s.trim()) }}
{{ $json.text.includes("erro") }}
{{ `Olá ${$json.nome}, bem-vindo!` }}        // template literal
```

## Condicionais inline

```js
{{ $json.tipo === "lead" ? "novo" : "existente" }}
{{ $json.valor > 1000 ? "alto" : "baixo" }}
{{ $json.email || "sem-email@dominio.com" }}  // fallback
{{ $json.user?.email ?? "anonimo" }}          // optional chaining + nullish
```

## JMESPath (em Set / HTTP Request)

Em alguns lugares do n8n aparece opção JMESPath. É outra sintaxe (sem `{{}}`):
```
items[?active==true].name
```

Geralmente JS expression é mais flexível, mas JMESPath é útil em filtros de Set.

---

## Top 20 erros clássicos

### 1. `$json` está undefined
**Causa:** nó anterior não passou item; ou modo `Run Once for All Items` em Code mas tu acessou `$json` (lá é `items[0].json`).
**Fix:** verificar saída do nó anterior; em Code All-Items usar `items.map(item => item.json)`.

### 2. Comparar string com número falha
`{{ $json.id == 123 }}` — se `$json.id` vier `"123"` (string), `==` funciona, `===` não.
**Fix:** converter explícito: `Number($json.id) === 123` ou `String($json.id) === "123"`.

### 3. Boolean string
Webhook recebe `"true"` (string) e tu trata como boolean.
**Fix:** `$json.active === "true"` ou `Boolean($json.active && $json.active !== "false")`.

### 4. Date "Invalid DateTime"
`{{ DateTime.fromISO($json.data) }}` falha se `$json.data` não for ISO 8601.
**Fix:** usar `fromFormat`: `{{ DateTime.fromFormat($json.data, "dd/LL/yyyy") }}`.

### 5. `$node["X"]` retorna primeiro item só
Para todos: `$items("X")`.

### 6. Expressão dentro de string sem `=`
Em Set, escrever `texto: {{ $json.x }}` não funciona — precisa estar em modo Expression (botão fx).

### 7. Aspas mal fechadas em template literal
`` `Olá ${$json.nome}` `` (backticks). Aspas simples/duplas não fazem interpolação.

### 8. `$now` em modo "Run Once for Each Item"
`$now` é avaliado uma vez por execução do nó, não por item. Para timestamp único por item, gerar em Code.

### 9. Acessar binary como `$json.binary`
Errado. Binary é `$input.item.binary.<nome>` ou `$binary.<nome>`.

### 10. Loop infinito com Execute Workflow
Sub-workflow chamando ele mesmo sem condição de saída → trava o n8n.

### 11. Webhook URL teste vs prod
`/webhook-test/...` só dispara com workflow inativo + execução manual aberta. Em prod, ativar e usar `/webhook/...`.

### 12. Credentials não encontradas após import
Workflow importado de outra instância referencia credentials por ID, que não existe na nova. **Sempre** reconfigurar credentials manualmente após import.

### 13. `$env` bloqueado
Por default n8n bloqueia `$env` em expressões. Liberar via env var `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (cuidado com segurança).

### 14. Set "Keep Only Set" descarta dados
Em Set, ligar `Keep Only Set` joga fora todos os outros campos. Desligar se quiser mesclar.

### 15. Merge "Append" duplica colunas
`Append` apenas concatena items, não junta por chave. Para join, usar `Combine by matching fields`.

### 16. SplitInBatches sem return
SplitInBatches roda em loop. Ao final do braço de processamento, conectar de volta no SplitInBatches input pra próxima iteração. Sem isso, só processa 1 batch.

### 17. JSON.parse double-parsed
HTTP Request já retorna JSON parseado se Content-Type for application/json. `JSON.parse($json.body)` em cima quebra.

### 18. Async dentro de Code
`Run Once for Each Item` aceita async, `Run Once for All Items` também. Usar `await` normalmente.

### 19. `return` em Run Once for Each Item
Retornar **objeto** (`return {...}`) ou `return [{json: {...}}]`? Each-item: `return {field: value}` direto. All-items: `return [{json: {field: value}}, ...]`.

### 20. Static data não persiste em manual run
`$getWorkflowStaticData('global')` salva, mas em execução manual de teste não persiste (n8n não salva static data em manual). Só em produção (workflow ativo) persiste.
