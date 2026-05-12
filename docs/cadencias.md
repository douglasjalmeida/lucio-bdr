# Cadências — Lúcio BDR

Catálogo das cadências comerciais executadas pelo Lúcio. Fonte de verdade pra mensagens, intervalos e regras de execução. Schema canônico em `docs/supabase-schema.sql` + migrations em `docs/migrations/`.

---

## Regras gerais (valem pra todas)

- **Janela de envio:** 09h–17h, segunda a sexta (America/Sao_Paulo). Fora disso, fila aguarda.
- **Jitter mínimo:** 3min entre disparos do mesmo lote (uazapi `/sender/advanced` `delayMin`/`delayMax`).
- **Reset de cadência:** se o lead responder a qualquer toque, a cadência **zera** (status muda pra `engajado`, próximos toques cancelados). Lead volta a receber outbound só se for explicitamente reagendado.
- **Modo mudo:** se `leads.modo='mudo'` (handoff humano em curso), nenhum toque dispara — fica `pendente` até voltar pra `bot`.
- **Encerramento:** após o último toque sem resposta, status vira `encerrado`, motivo `frio`.
- **Sem promessa de preço/prazo/disponibilidade.** Lúcio qualifica e provoca curiosidade — fechamento é com closer humano.

---

## `geradores-b2b-v1` (produção)

Cadência piloto MVP. 3 toques. Foco: gerador + MPaaS pra empresas com risco de queda de energia.

| Passo | Quando | Objetivo |
|---|---|---|
| 1 | T+0 | Apresentação + descoberta |
| 2 | T+3 dias após toque 1 | Reengajamento (ângulo MPaaS/recorrência) |
| 3 | T+6 dias após toque 2 (T+9 total) | Última tentativa |

### Toque 1 — apresentação (T+0)

> Oi, {nome}, tudo bem? Aqui é o Lúcio, da Luminus. A gente cuida de gerador e energia de backup pra empresa que não pode parar quando a luz cai. Tô passando porque {empresa} entrou no nosso radar — queria entender rapidinho: hoje, se a energia caísse aí agora, quanto tempo vocês conseguem operar antes de virar prejuízo?

### Toque 2 — reengajamento MPaaS (T+3 dias)

> {nome}, voltei aqui. Sem cobrança — é que a maioria dos gestores que a gente conversa não quer comprar gerador, quer parar de se preocupar com queda de energia. A gente tem um modelo (MPaaS) onde a Luminus assume o equipamento + manutenção como serviço recorrente — você não imobiliza capital e a operação fica garantida. Faz sentido eu te mandar 2 linhas explicando como funciona pro seu cenário?

### Toque 3 — última tentativa (T+9)

> {nome}, último toque meu por aqui pra não te encher. Se backup de energia não é prioridade agora, beleza, fecho aqui. Se for e só não foi a hora, me avisa quando quiser retomar — fica anotado. Pode ser uma palavra: "agora", "depois" ou "não".

---

## `geradores-b2b-v1-teste` (homologação)

**Mesma estrutura, intervalos em horas pra testar follow-up sem esperar dias.** Cada mensagem leva tag visível `[teste: toque N — ...]` no final pra você identificar no WhatsApp.

| Passo | Quando | Objetivo |
|---|---|---|
| 1 | T+0 | Apresentação + descoberta |
| 2 | +2h após toque 1 | Reengajamento |
| 3 | +3h após toque 2 (5h total) | Última tentativa |

### Toque 1 — apresentação (T+0)

> Oi, {nome}, tudo bem? Aqui é o Lúcio, da Luminus. A gente cuida de gerador e energia de backup pra empresa que não pode parar quando a luz cai. Tô passando porque {empresa} entrou no nosso radar — queria entender rapidinho: hoje, se a energia caísse aí agora, quanto tempo vocês conseguem operar antes de virar prejuízo?
>
> [teste: toque 1 — primeiro contato]

### Toque 2 — reengajamento MPaaS (+2h)

> {nome}, voltei aqui. Sem cobrança — é que a maioria dos gestores que a gente conversa não quer comprar gerador, quer parar de se preocupar com queda de energia. A gente tem um modelo (MPaaS) onde a Luminus assume o equipamento + manutenção como serviço recorrente — você não imobiliza capital e a operação fica garantida. Faz sentido eu te mandar 2 linhas explicando como funciona pro seu cenário?
>
> [teste: toque 2 — 2h sem resposta]

### Toque 3 — última tentativa (+3h)

> {nome}, último toque meu por aqui pra não te encher. Se backup de energia não é prioridade agora, beleza, fecho aqui. Se for e só não foi a hora, me avisa quando quiser retomar — fica anotado. Pode ser uma palavra: "agora", "depois" ou "não".
>
> [teste: toque 3 — 3h sem resposta, último]

---

## Como alternar entre prod e teste

Na importação do lead, setar `leads.cadencia_id` pra:
- **Prod:** id de `geradores-b2b-v1`
- **Teste:** id de `geradores-b2b-v1-teste`

Não precisa de env flag — é decisão por lead. CSV de importação pode ter coluna `cadencia` aceitando os dois nomes.

---

## Próximos passos (ainda em F2)

- [ ] `cadence-engine.js` lendo `passos_cadencia` (campo `delay_minutos`) e gerando registros em `agendamentos_disparos`.
- [ ] `WF-Lucio-Outbound` no n8n Luminus consumindo o batch e postando em uazapi `/sender/advanced`.
- [ ] agendador-claudio cron 08h apontando pro endpoint `/outbound-batch` do bridge.
- [ ] Importar 10 leads de teste (CSV manual).
- [ ] Smoke test: lead em `geradores-b2b-v1-teste` → recebe os 3 toques em ~5h.

**Glossário**

- **MPaaS** — Manutenção/energia como serviço; recorrência mensal Luminus, sem imobilizar capital.
- **Toque** — uma mensagem da cadência.
- **T+0** — primeiro toque, no momento da entrada do lead na cadência.
- **Jitter** — variação aleatória entre disparos pra simular humano e evitar banimento.
