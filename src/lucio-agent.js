// Lúcio — chamada Claude Agent SDK com allowedTools restritivo.
// Modo BDR (produção): só Supabase (custom tools de domínio) + Chatwoot (F3).
// Identidade carregada de .claude/identidade-lucio.md.
// Prompt de cadência/qualificação fica POSTERGADO (Bloco C da spec).

import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';

const IDENTIDADE_PATH = path.resolve(process.cwd(), '.claude', 'identidade-lucio.md');

function loadIdentidade() {
  try { return fs.readFileSync(IDENTIDADE_PATH, 'utf8'); }
  catch { return '# Identidade Lúcio (placeholder)\n'; }
}

const SYSTEM_BASE = loadIdentidade();

const ESTILO_WHATSAPP = `

# Você está conversando via WhatsApp com lead (mobile)

Regras de formatação (OBRIGATÓRIO):
- Frases curtas. Quebra de linha entre ideias. Sem parágrafos longos.
- Sem markdown pesado: WhatsApp não renderiza # ou tabelas.
- Negrito com *asteriscos simples* (formato WhatsApp), no máximo 1-2 por mensagem.
- Sem listas numeradas grandes. Bullet com - quando precisar.
- Resposta inteira deve caber em 1-3 telas de celular.
- Nunca ofereça preço, prazo ou disponibilidade sem closer humano confirmar.
`;

/**
 * Roda o Claude Agent SDK pra gerar resposta inbound do Lúcio.
 *
 * @param {object} params
 * @param {object} params.lead - Lead do Supabase.
 * @param {Array<{direcao,autor,texto,enviada_em}>} params.historico - Últimas mensagens (cronológico).
 * @param {string} params.mensagemAtual - Texto recém-recebido do lead.
 * @returns {Promise<{resposta: string, sessionId: string|null, tokensIn: number|null, tokensOut: number|null}>}
 */
export async function gerarRespostaInbound({ lead, historico, mensagemAtual }) {
  const systemPrompt = SYSTEM_BASE + ESTILO_WHATSAPP;

  const contextoLead = `
## Lead atual
- Nome: ${lead?.nome || 'desconhecido'}
- Empresa: ${lead?.empresa || '-'}
- Telefone: ${lead?.telefone}
- Segmento: ${lead?.segmento || '-'}
- Origem: ${lead?.origem}
- Status: ${lead?.status}
- Cadência: ${lead?.cadencia_id || '-'} (passo ${lead?.passo_atual ?? 0})
`.trim();

  const historicoTexto = (historico || [])
    .map(m => `[${m.enviada_em}] ${m.autor === 'lead' ? 'Lead' : (m.autor === 'humano' ? 'Humano (Luminus)' : 'Lúcio')}: ${m.texto}`)
    .join('\n') || '(sem histórico)';

  const userPrompt = `${contextoLead}

## Histórico recente
${historicoTexto}

## Mensagem agora chegou do lead
${mensagemAtual}

Responda como Lúcio. Texto direto, sem prefixo.`;

  const allowedTools = []; // F1: nenhuma. Vão entrar tools de domínio Supabase + Chatwoot quando o agente precisar agir.

  let respostaTexto = '';
  let sessionId = null;
  let tokensIn = null, tokensOut = null;

  try {
    for await (const event of query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model: process.env.LUCIO_MODEL || 'claude-sonnet-4-6',
        allowedTools,
        maxTurns: 1,
      },
    })) {
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') respostaTexto += block.text;
        }
      }
      if (event.type === 'result') {
        sessionId = event.session_id || null;
        tokensIn = event.usage?.input_tokens ?? null;
        tokensOut = event.usage?.output_tokens ?? null;
      }
    }
  } catch (err) {
    console.error('[lucio-agent] erro no SDK:', err);
    throw err;
  }

  return { resposta: respostaTexto.trim(), sessionId, tokensIn, tokensOut };
}
