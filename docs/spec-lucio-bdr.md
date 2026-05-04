# Spec Executiva — Agente Lúcio (BDR Luminus)

**Cliente interno:** Luminus Energia & Engenharia Ltda.
**Canal:** WhatsApp via uazapi (chip dedicado Luminus, novo)
**Cérebro:** Claude Agent SDK em bridge Node (espelho do `telegram-bridge` do Cláudio)
**Modelo:** Sonnet 4.6 (avaliar Haiku 4.5 após F2)
**Status:** Spec executiva — design fechado em 2026-05-03, projeto bootstrapped em 2026-05-04
**Fonte original do design:** memória `projeto_agente_lucio_bdr.md` no `secretario-Douglas`

---

## 1. Tese da arquitetura

**Lúcio = Cláudio especializado pra prospecção comercial Luminus.** Mesma stack arquitetural do Cláudio/telegram-bridge, trocando:

- Telegram → **uazapi** (WhatsApp)
- Skills de CMO/marketing → **skills BDR** (qualificação, handoff, cadência)
- Foco em produtividade pessoal → **foco em pipeline comercial**

**O que se mantém igual ao Cláudio:**
- Bridge Node + Claude Agent SDK como cérebro (não AI Agent dentro do n8n)
- n8n como **pipe de mensageria** (entrada e saída)
- Persistência em **Supabase** (não SQLite local — multi-tenant futuro + dashboard + MCP)
- Easypanel VPS Luminus pra produção
- agendador-claudio reaproveitado pra disparo diário do batch outbound
- MCPs como tools (Chatwoot, Supabase, gcal-luminus, gmail-luminus)
- Identidade portátil em `.claude/identidade-lucio.md`

**O que muda:**
- Histórico do lead vai pro **Supabase** (não GitHub markdown como no Bruno/Meppel) — porque BDR precisa de queries analíticas (taxa de resposta por cadência, tempo médio até handoff, etc).
- Outbound cadenciado usa **uazapi `/sender/advanced`** nativo — não loop no n8n nem cron por mensagem.

---

## 2. Fluxo end-to-end

```
WhatsApp ─► uazapi ──webhook (excludeMessages: wasSentByApi)──► n8n WF-Lucio-IN
                                                                    ├ filtros (1:1, não-grupo)
                                                                    ├ grava bruto Supabase
                                                                    └ POST lucio-bridge /in
                                                                            │
                                                                            ▼
                                                           ┌─────────────────────────────┐
                                                           │   lucio-bridge (Node + SDK) │
                                                           │                             │
                                                           │   MCPs como tools:          │
                                                           │   - supabase                │
                                                           │   - chatwoot                │
                                                           │   - gcal-luminus            │
                                                           │   - gmail-luminus           │
                                                           └──────────────┬──────────────┘
                                                                          │
                                                            ┌─────────────┴─────────────┐
                                                            ▼                           ▼
                                                  n8n WF-Lucio-OUT             MCP Chatwoot
                                                            │              (espelho: contato,
                                                            ▼               conversa, label,
                                                  uazapi /send/text         nota privada,
                                                            │               handoff)
                                                            ▼
                                                       WhatsApp lead

Outbound diário:
agendador-claudio (cron 08h)
  └► POST lucio-bridge /outbound-batch
       └► bridge formula N mensagens via Claude
            └► POST n8n WF-Lucio-Outbound
                 └► uazapi /sender/advanced (delayMin 180s, delayMax 600s, janela 09h-17h)
```

---

## 3. Componentes

### 3.1. Bridge Lúcio (Node + Claude Agent SDK)

**Stack:** Node 20 + `@anthropic-ai/claude-agent-sdk` + Express + dotenv.

**Endpoints:**
- `POST /in` — recebe mensagem inbound do `WF-Lucio-IN`. Bridge consulta histórico (Supabase), roda agente, devolve resposta via `WF-Lucio-OUT`.
- `POST /outbound-batch` — recebe lista de leads do agendador, bridge formula mensagens da cadência do dia, posta em batch no `WF-Lucio-Outbound`.
- `POST /handoff-return` — webhook do Chatwoot quando label `devolver-lucio` é aplicada → bridge muda status do lead pra `bot` no Supabase.
- `GET /health` — healthcheck.

**Lógica do `/in`:**
1. Recebe `{ telefone, nome, mensagem, timestamp, chatid, autor }`.
2. Se `autor=humano` (humano respondeu pelo celular): grava no Supabase com `direcao=out, autor=humano`, NÃO responde, retorna 200.
3. Se `autor=lead`:
   a. Busca lead no Supabase (cria se novo).
   b. Se `lead.modo=mudo` (handoff em andamento): grava mensagem, NÃO responde.
   c. Se `lead.modo=bot`: carrega últimas 30 mensagens do lead, roda Claude SDK com identidade-lucio + histórico, devolve resposta via WF-OUT.

**Diretório:**
```
~/iA/lucio-bdr/
├── .env                         # chaves (ANTHROPIC, UAZAPI, SUPABASE, N8N, CHATWOOT)
├── package.json
├── src/
│   ├── server.js                # Express + endpoints
│   ├── lucio-agent.js           # Claude Agent SDK + identidade-lucio
│   ├── supabase-client.js       # CRUD leads/mensagens/cadências
│   ├── cadence-engine.js        # Lógica de outbound batch
│   ├── handoff.js               # Detecta + processa handoff humano
│   └── mcps.js                  # Carrega MCPs (chatwoot, supabase)
├── prompts/
│   ├── system-base.md           # Compõe identidade-lucio + contexto Luminus
│   ├── qualificacao.md          # Sub-prompt: qualificar lead
│   ├── handoff.md               # Sub-prompt: passar pra humano
│   └── outbound-toque-1.md      # Templates por passo de cadência
├── docs/
│   ├── spec-lucio-bdr.md        # Este arquivo
│   ├── supabase-schema.sql      # DDL versionada
│   └── cadencias.md             # Catálogo de cadências (1=geradores, 2=MPaaS, etc)
└── scripts/
    ├── importar-leads.js        # CSV → Supabase
    ├── simular-conversa.js      # Roda mensagem mock contra bridge local
    └── smoke-test.sh
```

### 3.2. Workflow `WF-Lucio-IN` (n8n)

**Trigger:** Webhook uazapi.
**Filtro webhook uazapi:** `excludeMessages: wasSentByApi` (mantém `fromMeYes` chegando — crítico pra detectar humano).

**Nodes:**
1. Webhook recebe payload.
2. Filtro: descarta grupo (`isGroup=true`), descarta status, mantém texto+áudio.
3. Detector de autor:
   - `fromMe=true && wasNotSentByApi=true` → `autor=humano`
   - `fromMe=false` → `autor=lead`
   - `fromMe=true && wasSentByApi=true` → descarta (é o próprio Lúcio).
4. Áudio? → transcreve via Whisper (Groq, padrão Cláudio).
5. Normaliza `{ telefone, nome, mensagem, chatid, timestamp, autor }`.
6. Grava bruto Supabase tabela `mensagens`.
7. POST `lucio-bridge:/in`.

### 3.3. Workflow `WF-Lucio-OUT` (n8n)

**Trigger:** Webhook do bridge.

**Nodes:**
1. Webhook recebe `{ telefone, resposta, lead_id, passo }`.
2. Grava em `mensagens` (direcao=out, autor=ia).
3. POST uazapi `/send/text` (template já validado no n8n).
4. Atualiza `agendamentos_disparos.status=executado`.

### 3.4. Workflow `WF-Lucio-Outbound` (n8n)

**Trigger:** Webhook do bridge (`/outbound-batch` chama daqui).

**Nodes:**
1. Webhook recebe lista `[{ telefone, mensagem, lead_id, passo, scheduled_for }, ...]`.
2. Monta payload uazapi `/sender/advanced` com `delayMin: 180`, `delayMax: 600`, `messages: [...]`.
3. POST uazapi `/sender/advanced`.
4. Recebe `campanha_uazapi_id`, atualiza `agendamentos_disparos`.

### 3.5. Schema Supabase (mínimo)

```sql
-- Catálogo de cadências
cadencias (id, nome, total_passos, ativa, criado_em)
passos_cadencia (id, cadencia_id, ordem, dias_apos_anterior, prompt_orientacao, ativa)

-- Leads e estado
leads (id, nome, empresa, telefone, segmento, origem, status, modo, cadencia_id, passo_atual, criado_em, atualizado_em)
  -- status: novo | em_cadencia | engajado | qualificado | handoff | encerrado
  -- modo: bot | mudo
  -- origem: csv-manual | chatwoot | sheets | inbound

-- Histórico
mensagens (id, lead_id, chatid, direcao, autor, texto, passo, modo_no_momento, enviada_em, uazapi_message_id, status, tokens_in, tokens_out, custo)
  -- direcao: in | out
  -- autor: lead | ia | humano

-- Eventos analíticos
eventos (id, lead_id, tipo, payload_json, criado_em)
  -- tipo: handoff_solicitado, handoff_concluido, devolvido_bot, qualificado, encerrado_lead, encerrado_lucio, etc

-- Fila de outbound
agendamentos_disparos (id, lead_id, passo, agendado_para, status, campanha_uazapi_id, executado_em)
  -- status: pendente | enviado | cancelado | falhou
```

DDL completo em `docs/supabase-schema.sql` (a criar).

---

## 3.6. Superfícies de tools (regra arquitetural — separação Modo BDR vs Modo Dev)

O Lúcio roda em dois contextos com superfícies de tools deliberadamente diferentes. **Cliente no WhatsApp NUNCA tem acesso a tools administrativas** — a separação é garantida em código (`allowedTools` do SDK), não em prompt.

### Modo BDR (produção — bridge Node ↔ lead WhatsApp)

**Tools registradas no Claude Agent SDK do bridge:**

| Tool | Uso |
|---|---|
| `supabase_*` (custom MCP ou cliente HTTP) | Buscar/atualizar lead, gravar mensagem, ler histórico, agendar próximo passo |
| `chatwoot_*` (MCP) | Criar contato/conversa, aplicar label, escrever nota privada pro closer, marcar handoff |

**Tudo o mais é proibido por configuração:**
- ❌ n8n (qualquer instância)
- ❌ Gmail, Gcal
- ❌ Read/Write/Edit/Bash, filesystem
- ❌ Web fetch arbitrário
- ❌ Skills do projeto (`n8n-architect`, `mcp-builder` etc — só existem no IDE do Douglas)

**Implementação no bridge:**
```js
// src/lucio-agent.js — exemplo conceitual
const allowedTools = ['supabase_*', 'chatwoot_*'];
// SDK call só registra estas; nem o prompt mais criativo do mundo
// consegue chamar n8n porque a tool não existe na superfície.
```

### Modo Dev (Douglas no VS Code/terminal)

**Skills locais** (`.claude/skills/`): n8n-architect, mcp-builder, skill-creator, doc-coauthoring, claude-api.

**MCPs configurados** (`.mcp.json`): n8n-luminus, gmail-luminus, gcal-luminus.

**Tools nativas:** Read, Write, Edit, Bash, Glob, Grep, etc.

**Uso típico:** Douglas pede "ajusta o WF-Lucio-IN pra capturar áudio também" → Cláudio (via skill n8n-architect + MCP n8n-luminus) edita o workflow. **O Lúcio em produção não vê nada disso.**

### Por que essa separação importa

1. **Segurança:** lead malicioso não consegue prompt-injection pro Lúcio mexer em fluxo n8n, porque a tool não está registrada na superfície de produção.
2. **Custo/latência:** SDK call em produção carrega menos contexto/tools — resposta mais rápida e barata.
3. **Clareza mental:** Lúcio em produção é BDR puro. Cláudio (no IDE do Douglas) é o admin que opera o Lúcio.
4. **Igual ao Cláudio:** Cláudio na bridge Telegram tem menos tools que Cláudio no VS Code — mesmo padrão.

---

## 4. Decisões fechadas (não revisitar sem motivo)

1. Cérebro = bridge Node + SDK (não n8n AI Agent).
2. Outbound = `/sender/advanced` da uazapi (jitter nativo).
3. Persistência = Supabase (não SQLite, não GitHub markdown).
4. Chatwoot = espelho via MCP (não integração nativa uazapi↔Chatwoot).
5. Handoff F1 = humano responde pelo celular do número Luminus.
6. Devolução = label `devolver-lucio` no Chatwoot.
7. Modo mudo ≠ cego (grava tudo durante handoff).
8. Chip novo dedicado, aquecimento 2-3 semanas.
9. Sonnet 4.6.
10. **Separação Modo BDR vs Modo Dev:** Lúcio em produção (WhatsApp) só tem Supabase + Chatwoot como tools; tudo administrativo (n8n, gmail, gcal, filesystem) só existe no Modo Dev (Douglas no IDE). Garantido em código via `allowedTools` no SDK.

---

## 5. Decisões pendentes (próxima conversa Douglas × Cláudio)

### Bloco A — pra rodar a cadência precisa decidir
1. **Origem dos leads.** De onde sai a lista que vira cadência? (Chatwoot? Sheets? CSV? CRM Luminus?)
2. **Chip WhatsApp Luminus.** Já existe? Quando começa o aquecimento?
3. **Cadências iniciais.** Quantas cadências distintas no MVP? Sugestão: começar com **1 só** (geradores B2B inbound de eventos/feiras) e expandir depois.

### Bloco B — pra subir o bridge precisa decidir
4. **MCP Chatwoot.** Existe pronto na comunidade ou construir custom via skill `mcp-builder`?
5. **Supabase.** Cloud free tier ou self-hosted no Easypanel Luminus?
6. **Repo GitHub.** `lucio-bdr-luminus` privado novo dentro da org Luminus (pendente auth).

### Bloco C — pra refinar prompt precisa decidir
7. **ICP detalhado.** Setor / porte / cargo / cenário de uso. Lúcio precisa saber a quem está falando.
8. **Casos de uso prioritários.** Geradores fixos? MPaaS? Locação? Easy? — escolher 1-2 pra MVP do prompt.
9. **Tom outbound vs inbound.** Padrão proposto na identidade — Douglas valida.

### Bloco D — operacional
10. **Closer humano destinatário do handoff.** Quem é? Como recebe a notificação (Chatwoot? email? whats próprio)?
11. **Áudio (PTT) recebido do lead.** F1 transcreve e responde texto, ou ignora primeiro?

---

## 6. Fases de entrega

### **F0 — Bootstrap (FEITO em 2026-05-04)**
- ✅ Estrutura de pastas `~/iA/lucio-bdr/`
- ✅ Identidade Lúcio (`.claude/identidade-lucio.md`)
- ✅ CLAUDE.md do projeto
- ✅ Spec executiva (este arquivo)
- ⬜ `.env.example`
- ⬜ `package.json` boilerplate

### **F1 — Bridge local + inbound reativo (3-5 dias)**
- ⬜ Schema Supabase criado e versionado
- ⬜ `src/server.js` Express + endpoints
- ⬜ `src/lucio-agent.js` Claude SDK carregando identidade
- ⬜ MCPs Supabase + Chatwoot conectados
- ⬜ `WF-Lucio-IN` e `WF-Lucio-OUT` no n8n pessoal
- ⬜ Smoke test inbound: lead manda → Lúcio responde
- ⬜ Detector de handoff humano funcionando

### **F2 — Outbound cadenciado (3-4 dias)**
- ⬜ `cadence-engine.js` formulando mensagens
- ⬜ `WF-Lucio-Outbound` postando em `/sender/advanced`
- ⬜ agendador-claudio cron 08h apontando pro bridge
- ⬜ Catálogo de 1 cadência completa em `docs/cadencias.md`
- ⬜ Importar primeiros 10 leads de teste
- ⬜ Aquecimento chip (operacional, paralelo)

### **F3 — Handoff + Chatwoot espelho (2-3 dias)**
- ⬜ MCP Chatwoot tools completas (criar contato/conversa/label/nota)
- ⬜ Webhook Chatwoot → bridge `/handoff-return`
- ⬜ Notificação pro closer humano (canal a definir)
- ⬜ Modo mudo testado com humano respondendo pelo celular

### **F4 — Migração VPS + analytics (2-3 dias)**
- ⬜ Bridge containerizado
- ⬜ Subir no Easypanel Luminus (`luminus-agente` ou `lucio-bridge`)
- ⬜ Dashboard básico de funil (Supabase + Metabase ou tabela só)
- ⬜ Relatório semanal automatizado (mensagens enviadas, taxa de resposta, qualificados, handoffs)

**Total estimado: 10-15 dias úteis** se nenhuma surpresa nova.

---

## 7. Riscos identificados

- **Banimento WhatsApp:** chip novo precisa aquecer; janela 09–17h dias úteis; volume gradual; jitter mínimo 3min.
- **Loop bot↔bot:** filtro `wasSentByApi` no webhook + bridge nunca responde a `fromMe=true` com `wasSentByApi=true`.
- **Bridge cego durante handoff:** garantir que `fromMeYes && wasNotSentByApi` chega no webhook e bridge grava.
- **Persistência do modo mudo:** status no Supabase, não em memória — sobreviver a restart do bridge.
- **MCPs Chatwoot inexistentes prontos:** plano B é construir via skill `mcp-builder` (1-2 dias adicionais).
- **Lead reclamando de spam:** cadência precisa ter `unsubscribe` natural ("é só me avisar que paro de te mandar mensagem").

---

## 8. Próximos passos imediatos

1. Douglas valida esta spec.
2. Conversa decisões dos Blocos A/B/C/D acima (próxima sessão).
3. Cláudio cria `.env.example` + `package.json` + boilerplate `src/server.js`.
4. Cláudio cria `docs/supabase-schema.sql` com DDL.
5. Quando auth GitHub Luminus resolver: `git init` + `gh repo create` + push.

**Glossário**

- **BDR** — Business Development Representative; vendedor de primeiro toque que qualifica leads antes de passar pro closer.
- **Bridge** — processo Node servindo endpoint HTTP que orquestra o Claude Agent SDK.
- **Closer** — vendedor sênior que fecha o negócio (Lúcio só qualifica e direciona).
- **ICP** — Ideal Customer Profile.
- **Handoff** — IA passa atendimento pra humano.
- **Cadência** — sequência programada de toques (mensagens) ao longo de dias.
- **Jitter** — variação aleatória de delay entre mensagens, evita padrão robotizado.
- **MPaaS** — Manutenção/energia como serviço (recorrência Luminus).
- **PTT** — Push-to-Talk, áudio de WhatsApp.
- **MCP** — Model Context Protocol; protocolo de conexão entre LLM e ferramentas externas.
