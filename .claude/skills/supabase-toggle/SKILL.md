---
name: supabase-toggle
description: Alterna o flag SUPABASE_MCP_READONLY no arquivo .env do projeto Lúcio entre 0 (write) e 1 (read-only). Use sempre que Douglas pedir "destrava supabase", "libera write supabase", "trava supabase de novo", "supabase modo escrita", "supabase read-only", "supabase ro/rw", "preciso aplicar migration", ou variações. Use também internamente, sem ele pedir, depois de qualquer apply_migration bem-sucedido — pra voltar ao estado seguro (read-only) automaticamente. NÃO reinicia o MCP sozinha (impossível via skill); imprime instrução pro Douglas rodar /mcp manualmente.
---

# supabase-toggle — alternar SUPABASE_MCP_READONLY

Ferramenta operacional pra evitar Read no `.env` (regra durável: nunca expor segredos no transcript). Edita o flag cego via `sed`, sem ler o resto do arquivo.

## Argumentos

- `on` — coloca `SUPABASE_MCP_READONLY=0` (libera **write** — apply_migration funciona).
- `off` — coloca `SUPABASE_MCP_READONLY=1` (volta pra **read-only** — estado seguro).
- sem arg — alterna o valor atual.

> Mnemônico: `on` = "modo escrita ON". `off` = "modo escrita OFF" (= read-only).

## Como executar

1. Localizar `.env`: sempre `/Users/douglasalmeida/iA/lucio-bdr/.env` (raiz do projeto Lúcio).

2. Aplicar troca via `sed -i '' -E` (macOS), **sem Read antes**:
   - Pra `on` (write): `sed -i '' -E 's/^SUPABASE_MCP_READONLY=.*/SUPABASE_MCP_READONLY=0/' /Users/douglasalmeida/iA/lucio-bdr/.env`
   - Pra `off` (read-only): `sed -i '' -E 's/^SUPABASE_MCP_READONLY=.*/SUPABASE_MCP_READONLY=1/' /Users/douglasalmeida/iA/lucio-bdr/.env`

3. Pra alternar (sem arg): primeiro descobrir o valor atual com `grep` cego:
   ```
   grep -E '^SUPABASE_MCP_READONLY=' /Users/douglasalmeida/iA/lucio-bdr/.env
   ```
   `grep` da linha SUPABASE_MCP_READONLY isolada NÃO expõe segredo. Ler o output, decidir, aplicar `sed` do passo 2.

4. Validar a troca com novo `grep` da MESMA linha (cego e isolado). Mostrar ao Douglas só essa linha.

## Output pro Douglas

Sempre terminar com instrução literal e copiável:

> Pronto. Agora **rode `/mcp` e reconecte o servidor `supabase`** pra ele recarregar o env. Me avisa quando reconectar.

Se foi `off` (read-only), também adicionar:
> Estado seguro restaurado. Próximo `apply_migration` vai falhar até você destravar de novo.

## Regras de segurança (inegociáveis)

- **NUNCA** usar a tool Read no `.env`. Só `sed` cego e `grep` da linha específica.
- **NUNCA** passar valores de outras vars do `.env` pra qualquer tool.
- Se `grep` da linha alvo voltar vazio (var não existe ainda), parar e avisar Douglas — não criar a var sozinho (pode estar em outro lugar como `.env.local`).
- A skill só toca em `SUPABASE_MCP_READONLY`. Qualquer outra var → recusar.

## Quando invocar sozinho (sem Douglas pedir)

Imediatamente após `mcp__supabase__apply_migration` retornar `success: true`, invocar com `off` pra travar de volta. Avisar Douglas em uma linha: "Travei o supabase de volta em read-only. Roda `/mcp` quando puder."
