# Providers de pré-score CNPJ — Lúcio outbound

> **Decisão a tomar:** Douglas escolhe o provider antes do importador subir, pra schema já comportar os campos. Cláudio sugeriu Serasa, BigBoost (BigDataCorp), Casa dos Dados. Adiciono uma 4ª opção (D) que economiza significativamente.

## Contexto de uso

- Volume: **3.875 leads** na 1ª rodada da base de obras
- Ritmo: 70 leads/dia → ~55 dias úteis pra esgotar a base
- Necessidade real **pré-toque** (não pós-conversa):
  1. Empresa existe e está **ativa** na Receita
  2. **CNAE primário** (4120-4 = construtora, 6810-2/02 = incorporadora)
  3. Proxy de **porte** (capital social, data de abertura, nº filiais)
  4. Score real de inadimplência? — **ver análise no fim**

## Comparativo

| Provider | Preço | Cobertura | Latência | Score real? |
|---|---|---|---|---|
| **A. Serasa Experian** | Cotação comercial (≥R$ 500/mo + R$ por consulta — pedir cotação ao representante 3003-2599) | PJ completo: cadastrais, restritivos, score positivo, quadro social | Real-time | **Sim** (score Serasa) |
| **B. BigDataCorp BigBoost** (dataset `partner_boavista_one_score_company`) | R$ 13,01/consulta (1-10k) descendo até R$ 10,60 (>500k) | Score Boa Vista (300-1000), restritivos, exposição financeira | Real-time | **Sim** (score Boa Vista) |
| **C. Casa dos Dados** | **R$ 0,01/consulta** pay-per-use (trial 200 grátis 7d) | Dados cadastrais + CNAE (Receita), sem score | Real-time, instável (relatos de 403 Forbidden — exige JS/cookies, quebra acesso programático) | ❌ Só cadastrais |
| **D. BrasilAPI + minha-receita (free)** | R$ 0 | CNAE + razão social + capital social + situação cadastral + data abertura + endereço | Real-time | ❌ Só cadastrais |

**Cálculo total pra 3.875 leads:**
- Serasa: ~R$ 1.500 + cotação base (estimativa)
- BigBoost: ~**R$ 50.000** (R$ 13/consulta × 3.875)
- Casa dos Dados: **R$ 38,75**
- BrasilAPI: **R$ 0**

## Análise crítica

**Score real de inadimplência (Serasa/Boa Vista) no PRÉ-TOQUE é exagero.** Razões:
1. Lúcio só conversa no toque 1 — não cota nada. Comitê de crédito Luminus roda **depois** que o lead virou oportunidade real.
2. Pagar R$ 13 por lead frio que talvez nem responda queima caixa em escala.
3. O que Lúcio precisa **antes** do toque é só: empresa ativa + CNAE pra classificar (construtora/incorporadora) + porte aproximado. Isso resolve filtragem inicial e copy.
4. **Score real entra depois**, na qualificação pós-conversa, e só pra leads que pediram Locação — uma fração mínima.

## Recomendação tática

**Estratégia em 2 estágios:**

| Estágio | Quando | Provider | Custo total |
|---|---|---|---|
| **Estágio 1 — pré-toque (todos)** | Antes da fila de disparo do dia | **D. BrasilAPI / minha-receita** (free) | R$ 0 |
| **Estágio 2 — score real** | Pós-conversa, só leads que pediram Locação | **A. Serasa Experian** ou **B. BigBoost** | ~R$ 13/lead × (N leads que viraram qualificação Locação) ≈ R$ 200-1.000/mês |

**Economia:** R$ 50.000 vs R$ 0+R$1.000. Mesmo poder de decisão no funil real.

**Custo de implementação:**
- BrasilAPI já tem endpoint público (`/cnpj/v1/{cnpj}`), sem auth, rate limit razoável
- Self-host opcional via `minha-receita` (Docker, dump mensal da Receita) se BrasilAPI falhar

## Pergunta pro Douglas

Topa a **estratégia em 2 estágios (BrasilAPI free agora + Serasa/BigBoost depois pra leads quentes)** ou prefere ir direto num provider pago no pré-toque?

Se topar a estratégia em 2 estágios, **decisão de qual provider pago pra estágio 2** pode ficar pra depois — não bloqueia importador nem schema.

---

**Fontes consultadas:**
- [Casa dos Dados Planos](https://portal.casadosdados.com.br/planos)
- [Comparativo APIs CNPJ 2026 (cnpj-api.com)](https://cnpj-api.com/blog/melhor-api-consulta-cnpj)
- [BigDataCorp — Score de Crédito Multidados Boa Vista](https://docs.bigdatacorp.com.br/plataforma/reference/marketplace-score-de-credito-multidados-biro-de-credito-empresa)
- [Serasa Experian — Análise de Crédito PJ](https://www.serasaexperian.com.br/solucoes/analise-de-credito-de-pessoas-juridicas/)
- [BrasilAPI — CNPJ](https://brasilapi.com.br/docs#tag/CNPJ)
