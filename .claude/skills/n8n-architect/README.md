# n8n-architect (em construção)

Skill que torna o Cláudio especialista em criação, manutenção e debug de fluxos n8n, conectada via MCP a 2 instâncias (pessoal + Luminus).

## Status

🚧 Esqueleto criado. Conteúdo (SKILL.md, references/, scripts/, templates/, MCP config) será gerado quando Douglas confirmar:

1. URLs das 2 instâncias
2. Versão do n8n em cada uma
3. MCP server escolhido (default: `czlonkowski/n8n-mcp`)
4. Regra de ouro confirmada (nunca editar existente, só criar `[claudio-vN]` desativado)

## Setup do .env

```bash
cd .claude/skills/n8n-architect
cp .env.example .env
# preenche as 4 variáveis (URLs + API keys) + as 2 versões
```

`.env` já está protegido pelo `.gitignore` global do repo.

## Onde gerar API key no n8n

Settings → API → Create API Key. Copia e cola no `.env`. Depois de tudo rodando, considera rotacionar.
