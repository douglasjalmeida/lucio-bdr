# Stack Luminus — receitas para integrações específicas

> Atalhos para os sistemas que Douglas de fato usa. Sempre validar nomes de credentials antes (via MCP `list_credentials`).

## uazapi (WhatsApp)

API REST do uazapi (não Evolution). Auth via header `token` ou `apikey` na credential.

### Receber webhook (de mensagem nova)
- Webhook node, path: `uazapi-recebe-mensagem`.
- Payload chega em `$json.body`. Estrutura típica:
  ```json
  {
    "EventType": "messages",
    "message": {
      "id": "...",
      "chatid": "554899...@s.whatsapp.net",
      "type": "text",
      "text": "...",
      "fromMe": false,
      "messageTimestamp": 1714500000
    }
  }
  ```
- **Filtrar por `chatid`** logo após o webhook (IF) — evita processar mensagens de grupos aleatórios.
- **Ignorar `fromMe: true`** se for fluxo de "responder mensagem recebida".

### Enviar mensagem
HTTP Request:
- Method: POST
- URL: `<UAZAPI_BASE>/send/text`
- Headers: credential com `token`
- Body JSON:
  ```json
  {
    "number": "554899386988",
    "text": "{{ $json.resposta }}"
  }
  ```

### Enviar mídia
URL `/send/media`, body com `{"number": "...", "type": "image|video|audio|document", "file": "<url>", "text": "<caption>"}`.

### Armadilhas
- `chatid` em grupos termina com `@g.us`, em DM com `@s.whatsapp.net` — não tratar igual.
- uazapi reenvia webhook em caso de timeout — sempre dedup por `message.id`.

## Chatwoot (CRM com Fernando)

Auth: `api_access_token` no header da credential.

### Listar conversas
GET `<CHATWOOT_URL>/api/v1/accounts/<ACCOUNT_ID>/conversations`

### Criar/atualizar contato
POST `/api/v1/accounts/<ID>/contacts` — checa por `phone_number` antes (search) pra dedup.

### Adicionar mensagem privada (nota)
POST `/api/v1/accounts/<ID>/conversations/<conv_id>/messages` com `{"content": "...", "private": true}`.

### Webhook entrada (Chatwoot → n8n)
Configurar em Chatwoot Settings → Integrations → Webhooks. Eventos úteis: `conversation_created`, `message_created`, `conversation_status_changed`.

## GitHub commit (igual WF-1)

Auth: PAT (Personal Access Token) ou GitHub App.

### Criar/atualizar arquivo
Endpoint: `PUT /repos/{owner}/{repo}/contents/{path}`.
Body:
```json
{
  "message": "context: ...",
  "content": "{{ Buffer.from($json.conteudo).toString('base64') }}",
  "sha": "{{ $json.sha_atual }}",
  "branch": "main"
}
```
- Se arquivo não existe, omitir `sha`.
- Se existe, primeiro fazer `GET /contents/{path}` pra pegar SHA atual.

### Append a arquivo (padrão WF-1)
1. GET arquivo → decode base64 → texto atual + SHA.
2. Concatenar nova entrada.
3. Encode base64 + PUT com SHA.

## Google Sheets

Credential: OAuth2 (preferível) ou Service Account.

### Append linha
Nó `Google Sheets` → operation `Append`. Especificar Sheet ID + Range (`A:Z`).

### Read e filter
Operation `Read` + filtros nativos. Para filtros complexos, ler tudo + Code com `.filter()`.

## OpenAI / Claude API

### Claude (recomendado pra qualidade)
HTTP Request:
- POST `https://api.anthropic.com/v1/messages`
- Headers: `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`
- Body: `{"model": "claude-sonnet-4-6", "max_tokens": 1024, "messages": [{"role": "user", "content": "..."}]}`
- **Prompt caching:** adicionar `"cache_control": {"type": "ephemeral"}` no bloco system pra economizar tokens.

### OpenAI
Usar nó nativo `OpenAI Chat Model` se existir, ou HTTP Request pra `https://api.openai.com/v1/chat/completions`.

## n8n nativos disponíveis (já em uso na Luminus)

- `Schedule Trigger` — para WF-1
- `Webhook` — uazapi entrada
- `HTTP Request` — todas APIs externas
- `Code` — parsing/normalização de mensagens
- `IF` — filtro chatid
- `Set` — formatar payloads

## Convenções para workflows Luminus

- Tag obrigatória: `luminus` + domínio (`marketing`, `vendas`, `crm`).
- Nome em português.
- Comentar (sticky note) qualquer integração com sistemas dos parceiros (Tivea, V4 quando voltar).
- WF-1 é a referência canônica de "estilo Luminus" — quando criar fluxo novo na Luminus, espelhar padrões dele (Schedule + WhatsApp captura + GitHub commit).
