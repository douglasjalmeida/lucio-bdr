// Classificador de qualificação MQL → SQL.
// Roda após cada resposta do Lúcio. Pergunta pro Haiku (cheap) se o lead deu sinal
// de intenção forte (preço, prazo, urgência real, pedido de humano).
// Retorna estrutura usada pelo handoff.

import Anthropic from '@anthropic-ai/sdk';

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const MODEL = process.env.LUCIO_QUALIFIER_MODEL || 'claude-haiku-4-5-20251001';

const SYSTEM = `Você é um classificador de qualificação BDR para a Luminus (geradores + MPaaS B2B).

Sua tarefa: olhar uma conversa WhatsApp entre o BDR Lúcio e um lead, e decidir se o lead virou MQL qualificado (pronto pra handoff pro closer humano).

Critérios pra QUALIFICADO (qualquer um basta):
- Pediu falar com humano/vendedor/representante/closer.
- Perguntou preço, prazo, modelo, disponibilidade.
- Confirmou dor real: já caiu energia, prejuízo concreto, urgência operacional.
- Sinalizou janela de decisão clara ("preciso até X", "tô orçando agora").
- Pediu proposta, orçamento, visita técnica, reunião.

Critérios pra NÃO QUALIFICADO:
- Só perguntou "quem fala?" / "que empresa?" sem prosseguir.
- Respondeu monossílabo sem sinal ("ok", "blz", "vlw").
- Pediu pra parar / sair / não tem interesse.
- Curiosidade genérica sem dor.

Responda APENAS JSON válido nesse formato exato (sem markdown, sem comentário):
{
  "qualified": true|false,
  "urgencia": "agora"|"30-90d"|"sem-prazo",
  "dor_identificada": "frase curta com a dor concreta ou vazio",
  "sinais": "1-2 frases citando o que disparou a qualificação ou por que não qualificou",
  "motivo_handoff": "frase curta resumindo pro closer humano, ou vazio se não qualificou"
}`;

export async function avaliarQualificacao({ lead, historico, ultimaRespostaLucio }) {
  if (!client) {
    return { qualified: false, motivo_skip: 'ANTHROPIC_API_KEY ausente' };
  }

  const histTexto = (historico || [])
    .slice(-20)
    .map(m => `[${m.autor === 'lead' ? 'LEAD' : (m.autor === 'humano' ? 'HUMANO' : 'LÚCIO')}]: ${m.texto}`)
    .join('\n') || '(vazio)';

  const userMsg = `Lead: ${lead?.nome || '?'} | Empresa: ${lead?.empresa || '?'} | Cadência: ${lead?.cadencia_id || '?'} (passo ${lead?.passo_atual ?? 0})

Histórico:
${histTexto}

Última resposta do Lúcio:
${ultimaRespostaLucio || '(vazio)'}

Classifique agora.`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content?.find(c => c.type === 'text')?.text || '';
    const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      qualified: !!parsed.qualified,
      urgencia: parsed.urgencia || 'sem-prazo',
      dor_identificada: parsed.dor_identificada || '',
      sinais: parsed.sinais || '',
      motivo_handoff: parsed.motivo_handoff || '',
      tokensIn: resp.usage?.input_tokens ?? null,
      tokensOut: resp.usage?.output_tokens ?? null,
    };
  } catch (err) {
    console.error('[qualifier] erro:', err.message);
    return { qualified: false, motivo_skip: err.message };
  }
}
