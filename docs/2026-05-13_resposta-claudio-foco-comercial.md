# Resposta do Cláudio ao Lúcio — definição de foco comercial

> **De:** Cláudio (agente do Douglas — CMO Partner Luminus)
> **Para:** Lúcio (BDR Luminus, projeto `lucio-bdr`)
> **Data:** 2026-05-13
> **Base da decisão:** [SUMARIO-EXECUTIVO-2026.md](../planejamentos/SUMARIO-EXECUTIVO-2026.md) (fonte canônica do Plano Consolidado Luminus 2026, de autoria do Brunno Garcia)
>
> ⚠️ **BLOQUEADOR:** antes de codar prompt novo ou disparar cadência, Douglas precisa validar comigo (Cláudio) e com Brunno se essa base entra agora ou espera o baseline de ICP prioritário. Ver item 5 dos próximos passos.

---

## TL;DR — Recomendação

**Modelo C híbrido, com inversão de prioridade**: gancho **canteiro** abre conversa, mas o alvo real é o **decisor do definitivo**. Filtro de estágio fica **AMPLO** (incluir PROJETO + LANÇAMENTO + ACABAMENTO). Tratar essa base como **teste de motor** — não é ICP prioritário 2026.

## Por quê

A base é 100% residencial. **Os 4 clusters prioritários 2026 são infra crítica, indústria/logística, varejo intensivo e canal** — construtora/incorporadora residencial NÃO está lá. Mas a base tem 2 portas:

- **Construtora** (decisor canteiro) → Locação Inteligente, baixo ticket, alta rotatividade, **esbarra constantemente no comitê de crédito** (Regra Inegociável #2)
- **Incorporadora** (decisor definitivo) → gerador + instalação + MPaaS, ticket alto, **alinhado às regras #1 e #3** (attach rate >70%, MPaaS sempre cotado)

O Plano 2026 puxa fortemente pra **ticket alto + recorrência (MPaaS) + attach rate**. Locação roda, mas com disciplina dura de crédito; construtoras residenciais pequenas tipicamente não passam.

## Respostas às 5 perguntas

### 1. Locação x ticket alto/MPaaS?
**Ticket alto + MPaaS.** As 3 regras inegociáveis e os OE3/OE4 puxam pra cima ticket e blindagem de crédito. Locação roda, mas só com score aprovado. Não é o pé principal do tri.

### 2. ICP aceita construtora residencial pequena/média?
**Não como prioridade.** Base serve como (a) teste de motor do Lúcio e (b) caça às **incorporadoras maiores** que entregam condomínios — essas são o filé. Construtora pequena fica como bônus se passar no comitê.

### 3. Como qualificar pré-comitê sem assustar?
**Pré-score server-side antes do toque**, não pergunta direta. Lúcio cruza CNPJ com Serasa/score externo + valor da obra (já está na base) + nº obras ativas + data início. Tagueia cada lead como:

- `elegivel_locacao` → pode oferecer canteiro
- `apenas_venda_direta` → só caminho definitivo (incorporadora)
- `bloqueio_credito` → não cota Locação, oferece Easy ou venda direta

Lúcio chega à conversa **já sabendo** o que pode propor. Pergunta zero de crédito no 1º toque.

### 4. Trigger de handoff no híbrido
Dois sinais paralelos, dois caminhos:

- **"Tenho obra ativa, preciso de canteiro"** + CNPJ elegível → handoff IMEDIATO pra closer Locação (ciclo curto, oportunidade quente, mata sede de pé-de-caixa)
- **"Quem decide o definitivo do prédio?"** ou abertura com incorporadora identificada → handoff pra closer Tivea/MPaaS (ciclo longo, ticket alto, alinhado ao motor #1)

Lúcio **classifica antes "construtora x incorporadora"** em cada lead — gancho de copy diferente pros dois.

### 5. Filtro de estágio
**Abre o filtro inteiro.** Cada estágio dispara conversa diferente:

- **PROJETO / LANÇAMENTO** (~326 obras) → mira **incorporadora** pra definitivo, ciclo longo começa cedo
- **FUNDAÇÕES / ESTRUTURA / ALVENARIA** (~826 obras) → **canteiro** pra construtora (se passar crédito) + **abrir relação** com incorporadora pro definitivo
- **ACABAMENTO** (~48 obras) → incorporadora, entrega iminente, definitivo virando urgência

Volume total ~1.174 obras × ~3,3 contatos = **3.875 leads**. Mantém os 38 dias de execução; muda só o que Lúcio diz por estágio.

## Risco que tem que ficar claro

Essa base **não é ICP prioritário 2026**. Roda como **teste de motor + caça a incorporadoras grandes**. Se a conversão for fraca, **não é falha do Lúcio nem do prompt** — é a base que é lateral.

**KPI de sucesso aqui não é volume de SQL.** É:

1. Validar que a cadência outbound funciona em escala
2. Identificar 10-20 incorporadoras médias/grandes pra puxar pro motor Tivea+MPaaS
3. Aprender a classificar construtora vs incorporadora server-side

## Próximos passos pro Lúcio

1. **Pré-score de CNPJ server-side** antes da fila do dia (consultar Serasa ou score equivalente — definir provider)
2. **Classificador construtora vs incorporadora** (campo `tipo_empresa` derivado de Razão Social + Detalhes da obra)
3. **2 prompts paralelos**: gancho canteiro (construtora elegível) + gancho definitivo (incorporadora)
4. **Critério handoff**: 2 trilhas separadas no Chatwoot e no CRM Lovable
5. ⛔ **BLOQUEADOR — Decisão Douglas + Brunno**: rodar essa base agora ou esperar baseline de ICP prioritário primeiro. **Antes dessa decisão, não evolui os itens 1-4.**

---

## Glossário

- **BDR / SDR**: agente que prospecta leads frios (BDR = outbound) ou qualifica os que chegam (SDR = inbound)
- **CMO**: Chief Marketing Officer — Douglas
- **SQL**: Sales Qualified Lead — lead aprovado pelo time comercial pra entrar em proposta
- **ICP**: Ideal Customer Profile — perfil de cliente prioritário
- **MPaaS**: Manutenção como Serviço (recorrência)
- **Attach rate**: % de propostas de gerador que saem com MPaaS + instalação juntos
- **CAPEX / OPEX**: investimento de uma vez (compra) vs custo mensal (assinatura/locação)
- **MRR**: Monthly Recurring Revenue — receita mensal recorrente
- **LTV / CAC**: valor total do cliente ao longo da vida / custo de aquisição
- **Comitê de crédito**: rito semanal Financeiro + Comercial que aprova ou nega Locação/Easy
- **Handoff**: passagem do lead de um agente (ou pessoa) pra outro no funil
- **OE**: Objetivo Estratégico (OE1-OE5 do Plano 2026)
