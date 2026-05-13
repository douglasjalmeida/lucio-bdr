---
name: deploy-lucio
description: Faz push do código atual pro GitHub (se houver commits locais) e dispara o deploy do bridge Lúcio no Easypanel via webhook. Use sempre que Douglas pedir "deploy", "manda", "sobe", "põe no ar", "publica", "atualiza o bridge", "sobe o lúcio", "deploy lúcio", ou qualquer variação que peça pra colocar mudança em produção. Auto-deploy do Easypanel está DESLIGADO de propósito (evita restart durante conversa ativa), então push sozinho não basta — sempre precisa do trigger do hook.
---

# deploy-lucio — push + trigger Easypanel

Skill operacional pra encurtar o ciclo "subir código novo pro bridge Lúcio em produção". Auto-deploy Easypanel **off** (decisão de 2026-05-13 — restart durante conversa ativa mataria buffer 10s, request SDK em voo, Whisper, etc).

## Quando invocar

Triggers do Douglas (português, casual): `deploy`, `manda`, `sobe`, `põe no ar`, `publica`, `atualiza bridge`, `sobe o lúcio`, `dá deploy`, `joga em prod`. Variações idiomáticas também — se a intenção é claramente colocar mudança em produção, vale.

NÃO usar se:
- Douglas só pediu `git push` (push sem deploy é raro mas legítimo, ex: subir branch).
- A mudança é só em `docs/`, `.claude/`, ou outros arquivos que não afetam runtime (não muda comportamento do bridge — desperdício de deploy).
- Não houve mudança nenhuma (`git status` limpo + nada à frente do origin).

## O que fazer (sequência)

1. **Confirmar estado git:**
   ```
   cd /Users/douglasalmeida/iA/lucio-bdr && git status --short && git log origin/main..HEAD --oneline 2>/dev/null
   ```
   Se tiver commits locais não enviados → vai pro passo 2.
   Se trabalho ainda não commitado (arquivos em "M" ou staged) → PARA, pergunta ao Douglas se deve commitar antes (não comita sozinho — usuário pode estar no meio de algo).

2. **Push (se necessário):**
   ```
   git push origin main
   ```
   Se nada à frente do origin, pula direto pro passo 3.

3. **Dispara o hook do Easypanel:**
   ```
   source /Users/douglasalmeida/iA/lucio-bdr/.env && curl -sS -X POST "$EASYPANEL_DEPLOY_HOOK" -o /tmp/deploy_resp.txt -w "HTTP %{http_code}\n"; head -c 300 /tmp/deploy_resp.txt; echo
   ```

4. **Confirma ao Douglas:**
   - HTTP 200/204 + body "Deploying..." → "Deploy disparado. Container reinicia em ~1-2min." + lista (1 linha cada) os commits que vão entrar (`git log origin/main~N..HEAD --oneline` da janela).
   - Outro HTTP → mostra o code + body e diz que falhou.

## Segurança / regras duráveis

- **Nunca ecoar a URL completa do hook** no transcript. Se precisar mostrar pro Douglas, mascara: `sed 's|/api/deploy/.*|/api/deploy/****|'`.
- **Nunca usar `Read` no `.env`** — sempre `source` em subshell ou `grep` da linha específica.
- **Nunca disparar deploy sem trigger explícito** do Douglas. Mesmo que tenha commit novo, espera ele pedir.

## Exemplo de saída esperada

```
Deploy disparado (HTTP 200). Container reinicia em ~1-2min com:
- 9b3de72 — handler devolver-lucio via label
- 4a1f0a3 — notas privadas → contexto Lúcio
```
