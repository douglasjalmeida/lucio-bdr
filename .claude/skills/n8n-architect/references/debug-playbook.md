# Debug Playbook — n8n

## Fluxograma de diagnóstico

### "Workflow não está disparando"

1. **Está ativo?** `list_workflows` → checar `active: true`.
2. **Trigger correto?**
   - Webhook: URL de produção é `/webhook/<path>`, não `/webhook-test/<path>`.
   - Schedule: timezone configurada? cron expression certa? (testar em [crontab.guru](https://crontab.guru))
3. **Logs do n8n:** ver execuções recentes via MCP `list_executions(workflow_id)`. Se zero → trigger não está chegando. Se aparece com erro → próximo passo.

### "Workflow disparou mas falhou"

1. **`get_execution(id)`** → ver qual nó falhou.
2. Olhar **input** que chegou nele e **mensagem de erro**.
3. Causas comuns por tipo de erro:

| Erro | Causa provável |
|---|---|
| `Cannot read property 'X' of undefined` | Item anterior sem o campo esperado — validar payload antes |
| `401 Unauthorized` | Credential expirada ou trocada |
| `429 Too Many Requests` | Rate limit — adicionar SplitInBatches + Wait |
| `ETIMEDOUT` | API externa lenta — aumentar timeout do HTTP Request |
| `Invalid expression` | Expressão `{{ }}` mal formada — checar sintaxe |
| `Workflow execution timed out` | n8n default 5min — aumentar `EXECUTIONS_TIMEOUT` ou splitar em sub-workflows |

### "Webhook não dispara nem em teste"

1. **Workflow está aberto no editor com botão "Listen for test event"?** (modo teste só funciona com listener ativo)
2. URL exata? Path com case sensitive.
3. Se vier de fora (curl ok, ferramenta externa não): CORS, IP bloqueado, content-type errado.
4. Testar com curl direto:
   ```bash
   curl -X POST <webhook-url> -H 'content-type: application/json' -d '{"test": 1}'
   ```

### "Expression retorna `[Object Object]` ou similar"

- Tu interpolou um objeto onde se esperava string. Use `JSON.stringify($json.x)` ou acesse campo específico.

### "Credential funcionou ontem, hoje 401"

- Token expirou (OAuth) → reauth na credential.
- API key foi rotacionada → atualizar credential.
- IP mudou e API tem allowlist.

## Ferramentas de debug

### Pinned data
Clicar 📌 em um nó congela sua saída. Próximas execuções manuais reusam, sem rodar de novo. Útil pra debugar nós downstream sem chamar API repetidamente. **Limpar antes de ativar.**

### "Execute previous nodes"
Botão direito num nó → executa só ele e dependências, sem rodar workflow inteiro.

### Console.log em Code
```js
console.log("Debug X:", $json);
return $input.all();
```
Aparece no log de execução do nó.

### Manual run com payload custom
Em Webhook node, modo "Listen for test event" → enviar requisição → ver tudo que chegou.

### `$execution.mode`
Em Code: `$execution.mode` retorna `manual`, `webhook`, `trigger`, `error` etc. Útil pra branchear comportamento.

## Auditoria preventiva (antes de ativar workflow)

Checklist obrigatório:
- [ ] Nome com `[claudio-vN]`
- [ ] Sticky note inicial preenchido
- [ ] Tags configuradas
- [ ] Pinned data limpo em todos os nós
- [ ] Credentials existem e funcionam (testar HTTP Request standalone)
- [ ] Error Workflow conectado em Settings
- [ ] Idempotência: rodar 2x e verificar que não duplica
- [ ] Cenário de payload inválido testado (deve cair no error workflow, não pendurar)
- [ ] Sem `console.log` ou prints de debug deixados pra trás
- [ ] Validador local OK: `python scripts/validate-workflow.py <export.json>`

## Quando entregar pro Douglas

Sempre devolver:
```
✅ Workflow criado: [nome] [claudio-vN]
ID: <workflow_id>
Link: <N8N_URL>/workflow/<id>
Instância: pessoal | luminus

Credentials necessárias:
- <nome 1> (status: ✅ existe | ❌ criar manualmente)
- <nome 2>

Próximo passo:
1. Acessar link acima
2. Validar que credentials estão OK
3. Rodar manualmente com payload de teste: <exemplo>
4. Se OK, ativar (botão Active no canto superior direito)

Riscos / atenção:
- <ponto que merece olhar específico do Douglas>
```
