# Manutenção — versionamento, backup, governança

## Backup periódico (recomendado)

Rodar `scripts/export-from-n8n.sh` semanalmente em ambas instâncias:
```bash
./scripts/export-from-n8n.sh pessoal
./scripts/export-from-n8n.sh luminus
```
Salva em `docs/n8n-backup/<instancia>/<YYYY-MM-DD>/`. Pasta gitignored — guarda local; se quiser histórico remoto, sincronizar com Drive/Dropbox manualmente.

Pode automatizar via /schedule no Claude Code se Douglas quiser.

## Naming convention final (resumo)

Todo workflow criado pelo Cláudio:
- **Nome:** `<descrição-pt> [claudio-vN]`
- **Active:** `false` ao criar
- **Tags:** `claudio` + domínio + (opcional) estágio

Workflows da Douglas/Luminus pré-existentes: **não renomear, não tagear, não tocar.**

## Sticky notes obrigatórios

Em todo workflow novo:
1. **Header sticky** (canto superior esquerdo) — formato em `mcp-protocol.md`.
2. **Inline stickies** em qualquer bloco com lógica não-óbvia.

## Gestão de credentials

- **Não criar credentials via API.** Sempre via UI (mais seguro, evita key vazada em log).
- Em workflow novo, listar credentials necessárias na resposta — Douglas cria ou confirma que existem.
- Naming de credential sugerido: `<servico>-<conta>-<ambiente>` (ex: `chatwoot-luminus-prod`, `openai-claude-pessoal`).
- Quando rotacionar key: atualizar credential no n8n, todos workflows que referenciam por nome continuam funcionando sem mudança.

## Migração entre instâncias

Pra mover workflow de pessoal → Luminus (ou vice-versa):
1. Export via MCP (`get_workflow(id)`) ou via UI (Download).
2. **Limpar IDs internos**: remover `id` do JSON e `versionId` (n8n re-gera ao importar).
3. **Recriar credentials** na instância destino (não viajam no JSON).
4. Import via MCP `create_workflow` (com `[claudio-v1]` no nome) ou via UI.
5. Validar credentials referenciadas → ajustar se nomes diferentes entre instâncias.

## Dev vs prod (boas práticas mesmo sem ambientes separados)

Não temos n8n dev separado. Estratégias para reduzir risco:
- **Sufixo `[claudio-vN]`** = sempre experimental até Douglas validar.
- **Workflow desativado por default.**
- **Tag `experimento`** até promovido a `produção-candidata` → `produção` (essa última só Douglas marca).
- **Pinned data** em nós que chamam APIs externas durante desenvolvimento — evita gastar créditos/disparar coisa em prod sem querer.

## Env vars / Variables (n8n nativo)

n8n tem Settings → Variables (env vars de workflow, acessíveis via `$vars.X`).

Para Luminus, vars sugeridas:
- `UAZAPI_BASE_URL`
- `CHATWOOT_BASE_URL`
- `CHATWOOT_ACCOUNT_ID`
- `GITHUB_DEFAULT_REPO`

Pra pessoal, definir conforme uso.

**Nunca** colocar API keys em Variables — usar Credentials. Variables é pra config não-secreta (URLs, IDs, paths).

## Limpeza periódica

Trimestralmente, auditar:
- Workflows desativados não usados há > 90 dias → arquivar (tag `arquivado`) ou deletar com aprovação.
- Workflows com 100% erro nas últimas execuções → investigar ou desativar.
- Credentials órfãs (não referenciadas por nenhum workflow) → remover.

Cláudio pode rodar essa auditoria via MCP a pedido (modo 2D do SKILL.md), sem deletar nada — só lista e propõe ações.

## Workflow de promoção (de v1 para produção)

Sequência típica:
1. Cláudio cria `Lead Site → Chatwoot [claudio-v1]` desativado.
2. Douglas valida em manual run, ajusta payloads de teste.
3. Se quiser mudança → Cláudio cria `[claudio-v2]` (não edita v1).
4. Quando v2 (ou v3) está OK → Douglas renomeia removendo o sufixo, marca tag `produção` e ativa.
5. v1 e v2 antigas: Douglas decide manter como histórico (tag `arquivado`) ou deletar.
