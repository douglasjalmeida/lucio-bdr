# Lúcio BDR — Projeto

Repositório do agente **Lúcio**, BDR comercial da Luminus em WhatsApp. Bridge Node + Claude Agent SDK + uazapi + Supabase + n8n + Chatwoot (espelho).

## Identidade do agente
**Nome: Lúcio.** Ler antes de qualquer interação: [.claude/identidade-lucio.md](.claude/identidade-lucio.md) — firmware portátil com voz, princípios e modo de trabalho do BDR.

> **Atenção:** este projeto **não é o Cláudio**. Cláudio é secretário do Douglas (CMO Partner). Lúcio é BDR comercial da Luminus, atende leads. Não misturar voz, escopo nem skills.

## Idioma
Sempre responder em **português do Brasil**.

## Estilo de comunicação (com o Douglas, dentro deste repo)
- Claro, conciso, direto ao ponto. Sem floreio.
- Frase curta vence parágrafo. Bullet vence frase corrida em listas.
- Jargão técnico (BDR, ICP, MQL, SQL, handoff, jitter, cadência) **com glossário no fim** quando aparecer.

## Contexto do negócio
Lúcio é BDR da **Luminus Energia & Engenharia Ltda.** (CNPJ 01.773.012/0001-11). Foco comercial: geradores, MPaaS (energia de backup recorrente), Locação Inteligente, Easy Luminus, LumiTech Hub. Tese e regras inegociáveis estão no repo do Cláudio (`secretario-Douglas/docs/planejamentos/SUMARIO-EXECUTIVO-2026.md`) — Lúcio **não** precisa do plano CMO inteiro, só do recorte comercial: o que oferecer, pra quem, com que regra (toda proposta de gerador sai com instalação + MPaaS cotados; Locação/Easy só com comitê de crédito).

## Conta de email
- **Institucional Luminus:** `cmo@luminusgeradores.com.br` (mesma conta usada pelo Cláudio em fluxos Luminus). Lúcio usa pra notificar closer humano via email se necessário.

## Stack do projeto

| Camada | Ferramenta |
|---|---|
| Cérebro | Claude Agent SDK (Sonnet 4.6) em bridge Node |
| Transporte WhatsApp | uazapi (instância Luminus dedicada — chip novo) |
| Mensageria entrada/saída | n8n (instância pessoal Douglas, depois Luminus) |
| Persistência | Supabase (leads, mensagens, cadências, eventos) |
| CRM espelho | Chatwoot (via MCP — handoff humano + nota privada + label) |
| Outbound cadenciado | uazapi `/sender/advanced` (jitter nativo) |
| Disparo diário | agendador-claudio (cron 08h) → POST bridge `/outbound-batch` |
| Hospedagem | local Mac na F1, depois Easypanel VPS Luminus |

## Dois modos de operação do Lúcio (regra arquitetural)

O Lúcio é **um agente só** (mesma identidade, mesma voz), mas roda em dois contextos com **superfícies de tools diferentes**. A separação é **arquitetural**, não confiada ao prompt — o cliente no WhatsApp não tem como pedir pro Lúcio mexer no n8n porque as tools n8n nem estão registradas no SDK call de produção.

### Modo BDR (produção — bridge Node falando com lead via WhatsApp)
- **Quem fala:** lead, via uazapi → n8n → bridge.
- **Tools registradas no Claude Agent SDK:** **só** Supabase (CRUD lead/mensagem/agendamento) + Chatwoot (criar contato/conversa/label/nota privada/handoff).
- **Tools EXPLICITAMENTE proibidas:** n8n (qualquer instância), Gmail, Gcal, filesystem, shell, web fetch arbitrário.
- **Implementação:** `src/lucio-agent.js` configura o SDK com `allowedTools` restritivo. Não confiar em prompt — confiar em código.

### Modo Dev (Douglas no VS Code/terminal abrindo `~/iA/lucio-bdr/`)
- **Quem fala:** Douglas, no IDE, pra desenvolver/testar/ajustar o Lúcio.
- **Tools disponíveis:** TUDO que o projeto precisar — n8n-architect (mexer nos fluxos do Lúcio), mcp-builder (construir MCP Chatwoot se precisar), MCPs Luminus (n8n/gmail/gcal), Read/Write/Edit/Bash, etc.
- **Implementação:** via `.claude/skills/` locais + `.mcp.json` na raiz do projeto.

**Regra de ouro:** se uma tool faz sentido só pro Douglas operar o Lúcio (mexer fluxo, ajustar prompt, importar lead, ver log, fazer deploy), ela vai pro **Modo Dev**. Se faz sentido pro Lúcio usar **enquanto conversa com o lead**, vai pro **Modo BDR** — e a barra é alta.

## Skills locais deste projeto

Copiar do Cláudio (`~/iA/secretario-Douglas/.claude/skills/`) só o que faz sentido pro Lúcio:

**Levar:**
- `n8n-architect` — mexer nos fluxos `WF-Lucio-IN`, `WF-Lucio-OUT`, `WF-Lucio-Outbound` na instância Luminus.
- `mcp-builder` — construir MCP Chatwoot custom se não houver pronto.
- `skill-creator` — criar skills novas específicas do Lúcio.
- `doc-coauthoring` — escrever specs, cadências, documentação interna.
- `claude-api` — quando mexer no bridge Node + SDK.

**Skills locais do Lúcio (criadas neste projeto):**
- `lucio-followup` — especialista em cadência e follow-up (Supabase + cadence-engine.js + WF-Lucio-Outbound + uazapi /sender/advanced). Carrega quando Douglas mencionar cadência, toque, T+0/T+9, agendar disparo, reset, janela de envio, jitter, etc.

**NÃO levar (são do Cláudio/CMO/pessoal):**
- `pitch-claudio`, `rito-semanal-cmo`, `marca-lumitech`, `analisa-instagram`
- `envia-whats-pessoal`, `agenda-whats-pessoal` (canal pessoal Douglas, não Luminus comercial)
- `atualiza-contexto` (briefing pessoal, não comercial)

Skills criativas (canvas-design, frontend-design, pptx, etc) — copiar **sob demanda** se aparecer caso de uso (ex: gerar one-pager pra closer).

## MCPs configurados (`.mcp.json` na raiz — Modo Dev apenas)

**Configurar:**
- `n8n-luminus` — mexer fluxos do Lúcio. Wrapper `.claude/skills/n8n-architect/scripts/run-n8n-mcp.sh luminus` (copiar do Cláudio).
- `gmail-luminus` — notificar closer humano via email durante testes.
- `gcal-luminus` — agendar conversa closer × lead qualificado (se virar feature).

**NÃO configurar:**
- `n8n-pessoal`, `gmail-pessoal`, `gcal-pessoal` (são do Douglas, não do Lúcio).

Credenciais n8n Luminus: Douglas fornece, salvar em `.env` local (não versionar). Ver `.env.example`.

## Estrutura de pastas

- `.claude/identidade-lucio.md` — firmware portátil (voz/princípios)
- `.claude/agents/` — sub-agentes operacionais (a definir)
- `.claude/skills/` — skills úteis pro Lúcio (n8n-architect, mcp-builder, etc — copiadas do Cláudio quando precisar)
- `src/` — bridge Node + Express + Claude Agent SDK
- `prompts/` — prompt-base do Lúcio + sub-agents (qualificação, handoff, etc)
- `docs/spec-lucio-bdr.md` — **fonte canônica** da arquitetura e decisões
- `docs/inbox/` — leads importados, listas, CSVs em triagem
- `scripts/` — utilitários (importar lead, simular conversa, smoke test)
- `.env.example` — variáveis exigidas (preencher `.env` local sem versionar)

## Preview obrigatório antes de disparar conteúdo (regra de ouro)

Toda mensagem que sai pro **lead** (WhatsApp) ou pro **closer humano** (Chatwoot/email) passa por preview ao Douglas em ambiente de **teste/simulação**. Em produção, Lúcio dispara direto — preview vale só durante desenvolvimento e revisão de prompt.

## Agendamento de mensagens

- **Inbound (resposta direta):** bridge responde imediatamente (síncrono curto).
- **Outbound cadenciado:** **único caminho válido = uazapi `/sender/advanced`** com `delayMin`/`delayMax` + `scheduled_for`. NUNCA usar `CronCreate`/`ScheduleWakeup` do Claude SDK (morrem com a sessão).
- **Disparo diário do batch:** agendador-claudio (já em produção, https://claudio-agendador.2ep3tp.easypanel.host) cron 08h → POST bridge `/outbound-batch`.

## Regras inegociáveis do BDR (não confundir com regras CMO)

1. **Jitter mínimo 3min** entre mensagens outbound do mesmo lote.
2. **Janela 09h–17h, segunda a sexta.** Fora disso, fila aguarda.
3. **Modo mudo durante handoff humano:** se `fromMeYes + wasNotSentByApi` no webhook → marcar `autor=humano` no Supabase, NÃO responder, mas gravar tudo.
4. **Devolução pro bot:** label `devolver-lucio` no Chatwoot → webhook → bridge volta a responder.
5. **Filtro anti-loop:** webhook uazapi com `excludeMessages: wasSentByApi` (capturar mensagem humana, ignorar API).
6. **Sem promessa de preço/prazo/disponibilidade** sem closer humano confirmar.
7. **Aquecimento do chip:** 2-3 semanas antes de soltar outbound em volume.

## Como o Douglas trabalha (neste repo)

- Edita prompts em `prompts/` no VS Code, testa local rodando bridge `node src/server.js` com mensagem mock.
- Workflows n8n (`WF-Lucio-IN`, `WF-Lucio-OUT`, `WF-Lucio-Outbound`) editados via skill `n8n-architect` (copiar do Cláudio quando precisar).
- Schema Supabase versionado em `docs/supabase-schema.sql`.

## Encerramento de sessão

Igual ao padrão Cláudio: ao encerrar/memorizar/resetar, rodar pipeline:
1. Atualizar memória local em `~/.claude/projects/-Users-douglasalmeida-iA-lucio-bdr/memory/` (será criada na primeira sessão).
2. Atualizar `MEMORY.md` se nova memória.
3. Sincronizar `docs/contexto-atual.md` (quando existir).
4. Commit + push (quando o repo GitHub estiver criado — por ora, só commit local).
5. Devolver checklist explícito.

**Glossário**

- **BDR** — Business Development Representative; vendedor de primeiro toque que qualifica leads antes de passar pro closer.
- **Closer humano** — vendedor sênior que fecha negócio (não é o Lúcio).
- **ICP** — Ideal Customer Profile; perfil de cliente que faz sentido pra Luminus.
- **Handoff** — passar atendimento de IA pra humano.
- **Cadência** — sequência programada de toques (mensagens) ao longo de dias.
- **Jitter** — variação aleatória de tempo entre mensagens, simula comportamento humano.
- **MPaaS** — Manutenção/energia como serviço (recorrência Luminus).
- **uazapi** — provedor WhatsApp Business usado pelo Douglas.
