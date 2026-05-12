---
name: chatwoot-ops
description: Operações no Chatwoot da Luminus via REST API — criar/listar labels, contatos, conversas, custom attributes, teams, inboxes; aplicar label; atribuir agente; adicionar nota privada. Use sempre que Douglas pedir "cria label no chatwoot", "lista contatos chatwoot", "cria inbox", "abre conversa", "manda mensagem pela API", "atribui pro closer", "adiciona nota privada", "vê pipeline no chatwoot", ou variações de operação CRM no Chatwoot. NÃO é MCP — usa curl direto.
---

# chatwoot-ops — Operações REST no Chatwoot Luminus

Skill pro Modo Dev: eu (Claudio) executo operações no Chatwoot da Luminus via `curl` no Bash, usando o API token guardado em `.env`. Sem MCP. Confiável, simples, rastreável.

## Pré-requisitos

Variáveis obrigatórias em `/Users/douglasalmeida/iA/lucio-bdr/.env`:

```
CHATWOOT_BASE_URL=https://chatwoot-mkt-chatwoot-mkt.2ep3tp.easypanel.host
CHATWOOT_API_TOKEN=<user_access_token do Profile Settings>
CHATWOOT_ACCOUNT_ID=<id numérico da conta, ver em /app/accounts/<id>/...>
CHATWOOT_INBOX_ID=<id da inbox WhatsApp Lúcio, ver em Settings → Inboxes>
```

**Como pegar o token:** Avatar canto inferior esquerdo → Profile Settings → role até "Access Token" → copia.

**Como pegar account_id:** olha a URL quando entra na conta — `https://.../app/accounts/<NÚMERO>/dashboard`. Esse número é o account_id.

## Regra de segurança

NUNCA imprimir o token em chat. Sempre carregar via `source .env` e usar `$CHATWOOT_API_TOKEN` em variável de ambiente. Se precisar mostrar um curl como exemplo, mascarar como `$CHATWOOT_API_TOKEN`.

## Padrão de chamada

Todos os endpoints abaixo seguem o padrão:

```bash
source /Users/douglasalmeida/iA/lucio-bdr/.env
curl -s -X <METHOD> \
  "$CHATWOOT_BASE_URL/api/v1/accounts/$CHATWOOT_ACCOUNT_ID/<endpoint>" \
  -H "api_access_token: $CHATWOOT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '<json body se POST/PATCH>'
```

## Operações comuns

### Labels (a "pipeline")

**Listar labels da conta:**
```bash
GET /api/v1/accounts/$ACC/labels
```

**Criar label:**
```bash
POST /api/v1/accounts/$ACC/labels
{
  "title": "mql-novo",
  "description": "Lead importado, sem toque ainda",
  "color": "#808080",
  "show_on_sidebar": true
}
```

**Aplicar label numa conversa:**
```bash
POST /api/v1/accounts/$ACC/conversations/<conv_id>/labels
{ "labels": ["mql-em-cadencia"] }
```

> Esse endpoint **sobrescreve** o set de labels. Pra adicionar sem remover, GET as labels atuais, mescla, e POST de novo.

### Contatos

**Criar contato:**
```bash
POST /api/v1/accounts/$ACC/contacts
{
  "inbox_id": $CHATWOOT_INBOX_ID,
  "name": "Fulano da Silva",
  "phone_number": "+5511999999999",
  "custom_attributes": {
    "empresa": "ACME Geradores",
    "setor": "industria",
    "cadencia": "geradores-b2b-v1"
  }
}
```

**Buscar contato por telefone:**
```bash
GET /api/v1/accounts/$ACC/contacts/search?q=5511999999999
```

### Conversas

**Criar conversa (a partir de contato existente):**
```bash
POST /api/v1/accounts/$ACC/conversations
{
  "source_id": "<phone_number ou identifier do contato>",
  "inbox_id": $CHATWOOT_INBOX_ID,
  "contact_id": <contact_id>,
  "status": "open"
}
```

**Atribuir conversa a um agente:**
```bash
POST /api/v1/accounts/$ACC/conversations/<conv_id>/assignments
{ "assignee_id": <user_id> }
```

**Atribuir conversa a um team (Closers):**
```bash
POST /api/v1/accounts/$ACC/conversations/<conv_id>/assignments
{ "team_id": <team_id> }
```

### Mensagens

**Mensagem outgoing (do agente/Lúcio pro lead):**
```bash
POST /api/v1/accounts/$ACC/conversations/<conv_id>/messages
{
  "content": "Texto da mensagem",
  "message_type": "outgoing",
  "private": false
}
```

**Nota privada (visível só pro time, não vai pro WhatsApp):**
```bash
POST /api/v1/accounts/$ACC/conversations/<conv_id>/messages
{
  "content": "Lead disse que tem 3 quedas/mês, perde R$ 50k/queda. Urgência alta.",
  "message_type": "outgoing",
  "private": true
}
```

> **Nota privada é o canal-chave do handoff** — Lúcio escreve resumo pro closer aqui.

### Custom Attributes

**Criar custom attribute da conta:**
```bash
POST /api/v1/accounts/$ACC/custom_attribute_definitions
{
  "attribute_display_name": "Empresa",
  "attribute_display_type": 0,
  "attribute_description": "Nome da empresa do lead",
  "attribute_key": "empresa",
  "attribute_model": 1
}
```

> `attribute_model`: 0 = Conversation, 1 = Contact.
> `attribute_display_type`: 0=text, 1=number, 2=currency, 3=percent, 4=link, 5=date, 6=list, 7=checkbox.

**Atualizar atributos de um contato:**
```bash
PATCH /api/v1/accounts/$ACC/contacts/<contact_id>
{
  "custom_attributes": { "dor_identificada": "queda 3x/mês", "urgencia": "agora" }
}
```

### Teams

**Listar teams:**
```bash
GET /api/v1/accounts/$ACC/teams
```

**Criar team:**
```bash
POST /api/v1/accounts/$ACC/teams
{ "name": "Closers", "description": "Vendedores que assumem MQLs qualificados" }
```

### Inboxes

**Listar inboxes:**
```bash
GET /api/v1/accounts/$ACC/inboxes
```

**Criar inbox API (pro Lúcio):**
```bash
POST /api/v1/accounts/$ACC/inboxes
{
  "name": "WhatsApp Lúcio",
  "channel": { "type": "api", "webhook_url": "" }
}
```

## Workflow de setup inicial da pipeline

Quando Douglas pedir "monta a pipeline mínima no chatwoot", executar nesta ordem:

1. **Verificar conexão:** GET /accounts/$ACC/labels (lista vazia ou existente).
2. **Criar custom attributes** (Contact): empresa, setor, cadencia (list), dor_identificada, urgencia (list), closer_responsavel.
3. **Criar 12 labels:** mql-novo, mql-em-cadencia, mql-respondeu, mql-qualificado, mql-descartado, sql-contato-feito, sql-proposta, sql-negociacao, sql-ganho, sql-perdido, devolver-lucio, humano-atendendo.
4. **Criar team:** Closers.
5. **Criar inbox API:** WhatsApp Lúcio → guardar inbox_id retornado.
6. **Update .env:** preencher CHATWOOT_INBOX_ID.
7. **Devolver checklist:** o que foi criado + próximos passos (integrar bridge).

## Webhooks (pra Lúcio receber eventos)

Quando bridge estiver pronto pra escutar Chatwoot (ex: label `devolver-lucio` aplicada → Lúcio volta a responder):

```bash
POST /api/v1/accounts/$ACC/webhooks
{
  "url": "https://<bridge-url>/chatwoot-webhook",
  "subscriptions": ["conversation_status_changed", "conversation_updated", "message_created"]
}
```

## Glossário

- **API Access Token** — token pessoal do user no Chatwoot. Tem permissões do user dono. Pro Lúcio usar em produção, ideal criar **Agent Bot** dedicado e usar o token dele.
- **Inbox** — canal de comunicação (API, WhatsApp, Email...). Cada lead chega numa inbox.
- **Source ID** — identificador do lead no canal externo (no nosso caso, telefone no formato E.164).
- **Conversation** — fio de mensagens. Pode ter status `open`, `resolved`, `pending`, `snoozed`.
