# MCP Protocol — n8n-architect

## Servidores MCP configurados

Dois servers separados (namespaces independentes), ambos via `czlonkowski/n8n-mcp` (community, REST API + n8n public API key).

```
mcp__n8n-pessoal__*   → instância pessoal (Douglas)
mcp__n8n-luminus__*   → instância Luminus
```

## Tools disponíveis (czlonkowski/n8n-mcp)

Cada namespace expõe ~40 tools. As mais usadas:

### Read-only (seguras, sempre OK)
- `list_workflows` — lista todos workflows (filtra por tag/ativo)
- `get_workflow(id)` — JSON completo de um workflow
- `list_executions(workflow_id)` — execuções recentes
- `get_execution(id)` — detalhe de uma execução (input/output de cada nó)
- `list_credentials` — lista nomes de credentials (sem valores)
- `get_node_documentation(nodeType)` — doc oficial do nó
- `search_nodes(query)` — busca nó por nome/funcionalidade

### Write (sob regra de ouro)
- `create_workflow(payload)` — **OK**: cria novo, sempre `active: false` e nome com `[claudio-vN]`.
- `update_workflow(id, payload)` — **PROIBIDO** sem autorização explícita citando ID.
- `delete_workflow(id)` — **PROIBIDO** sem autorização explícita citando ID.
- `activate_workflow(id)` — **PROIBIDO**, Douglas ativa manualmente.
- `deactivate_workflow(id)` — **PROIBIDO** sem autorização explícita.

## Naming convention

### Workflows criados pelo Cláudio
```
<descrição-em-portugues> [claudio-vN]
```
Exemplos:
- `Lead Site → Chatwoot [claudio-v1]`
- `Backup Diário Sheets [claudio-v2]`
- `Webhook uazapi → GitHub [claudio-v3]`

### Versões
- v1 = primeira versão proposta
- v2, v3... = iterações em cima da v1 (cada uma cria workflow NOVO; não sobrescreve a v1)
- Quando Douglas ativar uma versão e marcar como "produção", próxima sugestão começa de v(N+1)

### Tags obrigatórias
- `claudio` (sempre)
- domínio: `marketing` | `vendas` | `infra` | `crm` | `whatsapp` | `interno`
- estágio (opcional): `experimento` | `produção-candidata`

## Sticky note inicial obrigatório

Todo workflow novo deve ter um Sticky Note no canto superior esquerdo com este formato:

```
# <Nome do workflow> [claudio-vN]

**Objetivo:** <1 linha>
**Gatilho:** <Webhook X / Schedule Y / Manual>
**Saídas:** <onde grava/manda>
**Dependências:** <credentials, env vars, sub-workflows>

**Autor:** Cláudio (skill n8n-architect)
**Criado em:** YYYY-MM-DD
**Baseado em:** <ID original se for fork, ou "novo">
```

## Sticky notes em blocos

Adicionar Sticky Note em:
- Qualquer nó Code com lógica > 5 linhas
- Qualquer IF/Switch com regra de negócio (não trivial)
- Qualquer ponto com tratamento de erro custom
- Loops (SplitInBatches) — explicar tamanho do batch e razão

## Credentials

- **Nunca** hardcode tokens/keys em nós. Sempre referenciar por **nome de credential**.
- Ao propor um workflow, listar **todas as credentials** que ele exige.
- Se a credential não existe na instância (verificar via `list_credentials`), **avisar Douglas e parar** — ele cria manualmente, não tente criar via API (n8n não suporta criar credential com secret via API REST, e a interface é mais segura).

## Gatilho de pedido de autorização

Antes de qualquer chamada `update_workflow`, `delete_workflow`, `activate_workflow`, `deactivate_workflow`, parar e pedir confirmação no formato:

```
⚠️ Operação fora da regra de ouro:
- Instância: <pessoal|luminus>
- Workflow: <nome> (ID: <id>)
- Ação: <update|delete|activate|deactivate>
- Motivo: <justificativa>

Confirma com "sim, autorizo <ação> no <id>"?
```

Só prosseguir se Douglas responder com a frase exata (ou equivalente inequívoco).
