# Briefing pro Cláudio — definição de foco comercial do Lúcio (BDR Luminus)

> **Contexto:** Lúcio é BDR comercial da Luminus no WhatsApp. Acabou de receber base de 1.174 obras residenciais com 3.875 contatos. Antes de soltar a cadência outbound, precisa decidir o pitch: canteiro, definitivo ou híbrido. Decisão depende do plano CMO 2026 que tá com o Cláudio.

## A base (em `docs/inbox/`)

- **1.174 obras** residenciais (segmento: 100% RESIDENCIAL)
- **3.875 contatos** únicos com nome + telefone (~3,3 contatos/obra)
- Cadência definida: **1 toque T+0**, 70 leads/dia, janela 08-17h30 SP seg-sex, jitter 3-8min → ~38 dias úteis pra executar a base inteira
- Filtro de estágio aprovado: `FUNDAÇÕES, SERVIÇOS PRELIMINARES, TERRAPLENAGEM, ESTRUTURA, ALVENARIA, EM CONSTRUÇÃO` → reduz pra ~826 obras / ~2.700 leads

## Variáveis disponíveis por lead (riqueza alta)

- **Pessoa:** nome, cargo (gerente de obra, engenheiro, etc), email, telefone
- **Empresa:** nome fantasia (construtora/incorporadora), CNPJ
- **Obra:** nome, subtipo, estágio atual, fase, valor de investimento, área construída, nº edifícios/pavimentos/unidades, endereço completo, datas início/término
- **Técnico:** estrutura, fachada, fundações, acabamento, área de lazer
- **`Detalhes` (texto rico):** ex. "Estão executando estrutura com 70%, alvenaria 40%, instalações 10%, pavimento 7%"

## Os 3 modelos de pitch possíveis

### A) Gerador de canteiro (durante obra)

- **Dor:** canteiro precisa de energia provisória pra equipamentos (betoneira, guincho, ferramenta), iluminação e escritório enquanto não tem rede definitiva
- **Decisor:** engenheiro/gerente de obra da **construtora**
- **Momento ideal:** Fundações até Estrutura/Alvenaria (em Acabamento já tem rede)
- **Subset da base:** ~826 obras alinhadas, com 229 obras "ouro" (Fundações + Serv. Preliminares + Estrutura)
- **Tipo de venda Luminus:** **Locação Inteligente** (curto prazo, 1-12 meses)
- **Ticket:** baixo/médio, alto volume, alta rotatividade
- **Gargalo Luminus conhecido:** Locação só sai com comitê de crédito aprovado — construtoras pequenas podem não passar
- **Concorrência:** locadoras regionais agressivas (Sotreq, Tigre, locais)

### B) Gerador definitivo do condomínio (pós-entrega)

- **Dor:** condomínio residencial precisa de gerador pra elevador, iluminação emergência, bombas, portaria, gás central — normativa obriga em alguns estados/portes
- **Decisor:** **incorporadora** define em PROJETO/LANÇAMENTO; instalação em ESTRUTURA/ACABAMENTO; síndico opera depois
- **Momento ideal:** Projeto, Lançamento, Acabamento — **estágios que o Douglas acabou de excluir do filtro**
- **Subset da base se mudar filtro:** 180 PROJETO + 146 LANÇAMENTO + 48 ACABAMENTO = 374 obras
- **Tipo de venda Luminus:** **gerador + instalação + MPaaS** (regra inegociável: toda proposta de gerador sai com instalação e MPaaS cotados)
- **Ticket:** alto, ciclo longo, baixa rotatividade
- **Aderência ICP:** alta — é o produto âncora da Luminus
- **Concorrência:** fabricantes/integradoras grandes (CAT, Cummins, Stemac)

### C) Híbrido — entra pelo canteiro, cultiva pro definitivo

- Lúcio aborda construtora com gancho de **canteiro** (dor imediata, gancho fácil de qualificar), mas o objetivo real é **mapear o decisor da incorporadora ligada à obra** e abrir conversa pro definitivo
- **Vantagens:** gancho mais quente, dupla oportunidade por lead (canteiro agora + definitivo daqui 6-18 meses)
- **Desvantagens:** dois ciclos de venda; closer humano precisa orquestrar handoff em 2 momentos diferentes; risco de Lúcio prometer coisa de canteiro e perder o definitivo

## Recomendações tentativas

| Cenário Luminus 2026 | Modelo recomendado |
|---|---|
| Prioridade é giro de locação / pé de caixa rápido | **A canteiro** |
| Prioridade é ticket alto / produto âncora / MPaaS | **B definitivo** (mudar filtro pra incluir PROJETO+LANÇAMENTO+ACABAMENTO) |
| Quer extrair LTV máximo da base | **C híbrido** (mais operacional, mas melhor ROI por lead) |

## Perguntas pro Cláudio decidir

1. O **SUMARIO-EXECUTIVO-2026** priorizou **giro de Locação Inteligente** ou **ticket alto de gerador+MPaaS** como pé de receita do tri?
2. ICP Luminus aceita **construtora residencial pequena/média** (perfil típico dos 1.174 leads), ou o foco é indústria/comercial onde a Luminus tem mais força?
3. Como Lúcio deve qualificar **pré-comitê de crédito** sem assustar lead na primeira conversa? (Modelo A depende disso.)
4. Se híbrido (C), em qual sinal o handoff dispara — "tenho obra ativa, preciso de canteiro" ou só "preciso de proposta de definitivo"?
5. Vale ajustar o filtro de estágio se for B ou C? (Incluir PROJETO/LANÇAMENTO/ACABAMENTO muda volume e tempo de execução.)

## Notas pro Cláudio

- A base **não tem indústria nenhuma** — é 100% residencial. Se ICP Luminus 2026 priorizou indústria, **essa base talvez não seja prioridade** e vale apenas como teste de motor.
- A riqueza de variáveis (estágio, % execução, valor, decisor) permite **mensagem ultra-personalizada** que outras locadoras/integradoras não conseguem fazer em escala — vantagem competitiva real do Lúcio.
- Decisão é estratégica e depende do plano comercial Luminus 2026. Lúcio executa o que definir — mas o **prompt do toque**, o **filtro de estágio** e o **critério de handoff** mudam radicalmente entre A, B e C.

---

**Documento gerado em:** 2026-05-13 por Lúcio (modo Dev no projeto `lucio-bdr`).
**Próximo passo:** Douglas leva ao Cláudio, Cláudio responde as 5 perguntas, Lúcio ajusta filtro/prompt/handoff.
