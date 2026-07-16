# Runbook — corte do inbound pra API oficial (iaSolution)

Ordem de execução do go-live. Referente ao commit `0aea2b7`.

> **Regra de ouro deste arquivo:** nenhum valor de segredo aqui. Onde aparece
> `<cola do teu .env>`, o valor real está no `~/iA/lucio-bdr/.env` (cifrado com
> git-crypt) e vai direto pro painel, sem passar por chat, issue ou log.

---

## 1. Variáveis no Easypanel (serviço `lucio-bridge`)

O `.env` do repo **NÃO** vai pro container: o Dockerfile copia só `src/`,
`public/` e a identidade. Em produção quem manda é o painel. Se o token faltar,
o bridge sobe com `whatsapp_oficial=false` e o Lúcio fica **mudo sem erro
aparente** — o boot avisa, mas nada quebra.

### ADICIONAR (novas)

```
IASOLUTION_BASE_URL=https://apihub.iasolution.app/api/v1
IASOLUTION_TOKEN=<cola do teu .env>
IASOLUTION_TIMEOUT_MS=15000
IASOLUTION_NUMERO_NEGOCIO=<número do canal Luminus, E.164 sem +>
IASOLUTION_WEBHOOK_SECRET=<cola do teu .env>
IASOLUTION_ALLOWLIST=<teu número pro teste; ESVAZIAR no go-live>
GROQ_API_KEY=<cola do teu .env>
GROQ_WHISPER_MODEL=whisper-large-v3
GROQ_TIMEOUT_MS=30000
```

Atenção a duas:

- **`GROQ_API_KEY`** — provavelmente **não existe** hoje no Easypanel: a
  transcrição vivia no n8n, e só agora virou código do bridge. Sem ela, áudio do
  lead chega como "não consegui ouvir" e a conversa segue capenga (não quebra).
- **`IASOLUTION_ALLOWLIST`** — com valor, só esse número é atendido; **vazia,
  atende todo mundo** (estado de produção). É o único item desta lista que muda
  de valor entre o teste e o go-live.

### REMOVER (código não lê mais)

```
UAZAPI_BASE_URL
UAZAPI_INSTANCE_TOKEN
UAZAPI_INSTANCE_ID
N8N_OUT_WEBHOOK_URL
```

### MANTER

`N8N_OUTBOUND_WEBHOOK_URL` — o outbound cadenciado ainda roda por n8n → uazapi.
Só morre quando a cadência migrar pra template HSM aprovado.

Todo o resto (`ANTHROPIC_API_KEY`, `SUPABASE_*`, `CHATWOOT_*`, `CRM_*`,
`DASHBOARD_*`, `META_*`, `RESEND_*`, `LUCIO_*`, `WATCHDOG_*`, `OUTBOUND_*`)
fica como está.

---

### Onde pegar o token

Painel: **[hub.iasolution.app](https://hub.iasolution.app)** → **Canais → Detalhes do Canal**.
(Doc pública da API: [apihub.iasolution.app/docs](https://apihub.iasolution.app/docs) —
o `Try It` da direita testa a API real com o token do canal.)

---

## 2. Webhook no painel da iaSolution

Apontar o canal para:

```
https://lucio-bridge.2ep3tp.easypanel.host/webhook/iasolution
```

Com o header:

```
x-webhook-secret: <mesmo valor de IASOLUTION_WEBHOOK_SECRET>
```

**Ponto de decisão, e a aposta mais provável de dar errado:** o secret é aceito
**só por header**. Query string foi descartada de propósito (vazaria no access
log do Easypanel e de qualquer proxy no caminho).

A doc pública **não menciona** webhook secret, assinatura, HMAC nem header
customizado (busca por `secret`/`signature` na doc inteira: zero ocorrências).
Ou seja: é bem possível que o painel só aceite a URL. Se for o caso, **pare** e
me chame — as opções são todas trade-off, não configuração:

- deixar o endpoint aberto (quem achar a URL faz o Lúcio gastar LLM ou força
  lead pra modo mudo);
- secret no path/query (funciona, mas vaza em access log e exige rotação);
- filtrar por IP de origem, se a iaSolution publicar uma faixa fixa.

---

## 3. Ordem do corte

1. Variáveis no Easypanel (passo 1).
2. Migration `012` — **já aplicada** em 16/07/2026, índice verificado em uso.
3. `git push` + disparar o `EASYPANEL_DEPLOY_HOOK`.
4. Conferir no log de boot: `whatsapp_oficial=true transcricao=true`.
   Se aparecer `false`, a variável não pegou — não siga.
5. Reapontar o webhook no painel da iaSolution (passo 2). **É o momento do
   corte:** a partir daqui o n8n para de receber inbound.
6. Desativar no n8n, pra não sobrar fio capaz de injetar mensagem no bridge:
   - [WF-Lucio-IN-iaSolution](https://n8n-n8n.2ep3tp.easypanel.host/workflow/wvLamuxCdVWCVe94)
   - [WF-Lucio-OUT-iaSolution](https://n8n-n8n.2ep3tp.easypanel.host/workflow/shiqbeeSpH592HQW)
   - [WF-Lucio-IN](https://n8n-n8n.2ep3tp.easypanel.host/workflow/SHgvb3Cy1lBZGJ9B) (uazapi, legado)
   - [WF-Lucio-OUT](https://n8n-n8n.2ep3tp.easypanel.host/workflow/eapHHCmHLBKJbYzl) (uazapi, legado)
7. Smoke E2E (passo 4 abaixo).
8. Só então: esvaziar `IASOLUTION_ALLOWLIST` e redeployar.

---

## 4. Smoke E2E — o teste que substitui as apostas

Mandar mensagem do celular na allowlist pro número da Luminus e ler o log.
São quatro perguntas que **só o payload real responde**:

| Verificar | O que o log deve mostrar |
|---|---|
| Envelope é o esperado | ausência de `payload sem messages[] na raiz` |
| Lúcio responde | `resposta enviada (msg=wamid...)` |
| Áudio transcreve | `áudio transcrito (N chars)` |
| **Eco não muta o Lúcio** | `eco do próprio bridge ignorado` |

O último é o que 4 rodadas de review **não** conseguiram fechar: ninguém nunca
viu um eco real da iaSolution. `parseMensagemIaSolution` tem 4 fallbacks
encadeados (`m.to || m.recipient_id || contato.wa_id || m.from`) pra um campo
não observado. Se o mapeamento estiver errado, o modo de falha é **o Lúcio
falando por cima do humano**, visível só no log.

Sinais de que o mapeamento está errado:
- `evento com remetente = nosso próprio número` → o backstop pegou; o eco traz
  `from` = negócio e o parse precisa ajustar a ordem.
- Lead novo criado com o número da Luminus → o backstop não estava configurado
  (`IASOLUTION_NUMERO_NEGOCIO` vazio).

Capture o payload bruto do eco e confira contra o parse: é o que troca 4 apostas
por 1 certeza.

---

## 5. Depois do corte (não bloqueia o inbound)

- **Outbound / campanha Intec:** parada desde junho, fila zerada (168 disparos
  morreram em `max tentativas` quando a uazapi caiu). Reativar exige **template
  HSM aprovado pela Meta** — o 1º toque vai pra lead frio, fora da janela de
  24h, onde texto livre não passa.
- **Janela de 24h:** avisar Gerson e Viviane. Passadas 24h da última mensagem do
  lead, o Chatwoot deles não entrega texto livre. O bridge põe nota privada na
  conversa quando isso acontece, mas a regra é nova e não tinha equivalente na
  uazapi.
