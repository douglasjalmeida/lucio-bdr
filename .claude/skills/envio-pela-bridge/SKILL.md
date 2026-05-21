---
name: envio-pela-bridge
description: Regra inegociável de COMO enviar qualquer mensagem outbound do Lúcio pro lead — teste OU campanha. Todo envio DEVE passar pela bridge (caminho /outbound-batch), nunca por chamada direta na uazapi. Use sempre que Douglas pedir "manda teste", "envio de teste", "testa o envio", "dispara campanha", "envio de campanha", "manda mensagem pro lead de teste", "simula envio", "manda pro meu número", "manda pro Fernando", "testa o outbound", ou qualquer variação de disparar mensagem pra lead. Carrega ANTES de escrever qualquer código de envio.
---

# Skill — Envio SEMPRE pela bridge (teste e campanha)

## Regra absoluta (nunca mais quebrar)

> **Todo envio outbound pro lead — teste OU campanha — passa pela BRIDGE.**
> Nunca por chamada direta na uazapi (`enviarTextoImediato`, `/sender/advanced` cru, ou script que fala direto com a uazapi).

**Por quê:** só o caminho da bridge (`/outbound-batch` → `processarOutboundBatch`) faz as 3 coisas **juntas**:

1. **WhatsApp** — POST no `WF-Lucio-Outbound` → uazapi `/sender/advanced`.
2. **Chatwoot** — `garantirLeadNoChatwoot` + `espelharMensagemConversa` + label `mql-em-cadencia`.
3. **CRM** — a transição `em-cadencia` (disparada no enroll) espelha pro funil Marketing.

Envio **direto na uazapi** entrega **só no WhatsApp** → Chatwoot e CRM ficam vazios → **estado inconsistente entre os 3 sistemas**. Foi exatamente o erro de 2026-05-21 (mandei teste por `enviarTextoImediato`, nada apareceu no Chatwoot/CRM, e o Douglas — com razão — cobrou). **Não repetir.**

## Único caminho válido de envio

```
1. Garantir o lead no Supabase (criarLead se não existe).
2. enrolarLead(leadId, 'geradores-b2b-v1')   ← cria agendamento T+0
       └─ dispara transição 'em-cadencia' → card aparece no funil Marketing do CRM
3. POST <BRIDGE_PUBLIC_URL>/outbound-batch { dryRun: true }   ← PREVIEW (regra de ouro)
       └─ formula o toque via Claude SDK, NÃO envia nada — devolve o texto pro Douglas revisar
4. Douglas aprova o texto.
5. POST <BRIDGE_PUBLIC_URL>/outbound-batch { dryRun: false }  ← DISPARA
       └─ WhatsApp + espelha no Chatwoot + (CRM já tem o card do passo 2)
```

Script sancionado: **`scripts/enviar-teste.js`** (preview por padrão; `--send` dispara). Ele faz enroll + `/outbound-batch` pela bridge — nunca uazapi direta.

## Proibido (anti-padrão)

- ❌ `enviarTextoImediato({telefone, texto})` pra enviar toque/campanha. Esse helper é **só** pro closer humano respondendo via Chatwoot (`/chatwoot-webhook`) — contexto em que o Chatwoot JÁ é a origem. Nunca pra outbound do Lúcio.
- ❌ Qualquer `fetch` direto pra `${UAZAPI_BASE_URL}/sender/advanced` num script de teste/campanha.
- ❌ Inserir mensagem com `gravarMensagem` "fingindo" que enviou sem passar pela bridge.

## Janela (09–17h seg-sex)

Fora da janela, o card no CRM e a conversa no Chatwoot aparecem **na hora** (são síncronos no batch), mas a **entrega no WhatsApp** o `WF-Lucio-Outbound` pode agendar pra próxima janela útil. Pra teste imediato, enrolar com `CADENCE_IGNORAR_JANELA=1` deixa o agendamento elegível agora; a entrega no zap ainda depende do WF. Não burlar a janela em produção real.

## Preview obrigatório (regra de ouro do projeto)

Em desenvolvimento/teste, **sempre** `dryRun: true` primeiro → mostrar o texto ao Douglas → só disparar com `dryRun: false` após o OK. Em produção real (cron 08h), dispara direto.

## Checklist antes de qualquer disparo

1. [ ] O lead existe no Supabase?
2. [ ] Foi enrolado na cadência (não estou inventando envio avulso)?
3. [ ] Fiz `dryRun` e mostrei o texto pro Douglas?
4. [ ] O disparo é via `<BRIDGE_PUBLIC_URL>/outbound-batch` (NÃO uazapi direta)?
5. [ ] Confirmei depois: card no CRM + conversa no Chatwoot + (se na janela) WhatsApp?

**Glossário:** `dryRun` — modo do `/outbound-batch` que formula o toque mas não envia (pra preview). `BRIDGE_PUBLIC_URL` — URL pública da bridge (`.env`).
