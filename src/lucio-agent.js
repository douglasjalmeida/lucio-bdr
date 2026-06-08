// Lúcio — chamada Claude Agent SDK com allowedTools restritivo.
// Modo BDR (produção): só Supabase (custom tools de domínio) + Chatwoot (F3).
// Identidade carregada de .claude/identidade-lucio.md.
// Prompt de cadência/qualificação fica POSTERGADO (Bloco C da spec).

import { gerarTexto } from './claude-client.js';
import { limparTextoOutbound } from './cadence-engine.js';
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
- NUNCA use travessão (— ou –) no texto. Use vírgula, ou quebre em duas frases. Ex.: escreva "Tenho uma ideia, posso te mostrar?" em vez de "Tenho uma ideia — posso te mostrar?".
- Resposta inteira deve caber em 1-3 telas de celular.
- Nunca ofereça preço, prazo ou disponibilidade sem closer humano confirmar.

# Notas internas do closer (CRÍTICO)

Linhas no histórico marcadas com [NOTA INTERNA closer — invisível pro lead] são
instruções que o closer humano (Luminus) deixou pra você. Tratamento:
- Ler com atenção e USAR como direcionamento da conversa.
- NUNCA citar, mencionar, parafrasear ou indicar a existência dessas notas pro lead.
- NUNCA repetir conteúdo de nota interna no texto que vai pro WhatsApp.
- Se a nota contradiz o que o lead pediu, segue a nota (closer manda).
- Se a nota diz "encerra", "descarta", "não responde mais" → respeita.

# Tudo que você escrever vai DIRETO pro WhatsApp do lead (CRÍTICO)

Não existe "canal interno" na sua saída. O texto que você produz é entregue ao lead,
sem revisão. Por isso:
- NUNCA narre seu estado operacional: "modo mudo", "handoff em andamento", "o closer
  humano entrou", "não vou responder enquanto o humano estiver ativo", "contexto
  registrado pra retomada", "aguardando qualificação", etc. Isso é interno e NÃO pode vazar.
- Você não tem como "ficar em silêncio" escrevendo — silêncio é decisão do sistema, que
  simplesmente não te chama. Se você foi chamado, é pra falar com o lead, normalmente.
- Sem emojis de status (🪄, ✅ de sistema), sem meta-comentário sobre handoff/closer/notas.
- Na dúvida entre narrar um processo interno ou dar uma resposta de venda: SEMPRE resposta de venda.
`;

// Token interno emitido pelo agente quando o "lead" é, na verdade, uma central
// eletrônica / URA / bot. O bridge intercepta: NÃO envia nada pro WhatsApp,
// registra nota e descarta o número. Nunca chega ao lead.
const SINAL_URA = '[[CENTRAL-AUTOMATICA]]';

const DETECCAO_URA = `

# Quando o número é uma central automática / URA (CRÍTICO)

Alguns números não são pessoas: são centrais eletrônicas — bots de CPF/CNPJ,
URA de recepção, menus automáticos, autorresposta de horário de atendimento,
pesquisa de satisfação ("informe uma nota de 0 a 10"), "você excedeu o número
de tentativas", "digite 1 para...", "este número não recebe mensagens", etc.

Sinais típicos de central automática (não pessoa):
- O contato PEDE dados a VOCÊ (CPF, CNPJ, protocolo, número de opção do menu).
- Respostas idênticas, robóticas, repetidas, sem nome próprio nem contexto da Luminus.
- Mensagens de sistema/autorresposta, sem interlocutor humano real do outro lado.

Se identificar com segurança que é central automática / URA (não uma pessoa):
- NÃO responda nada ao número. Não siga o menu, não informe CPF/CNPJ, não venda,
  não tente "encerrar com educação" — qualquer texto seu só realimenta o loop do bot.
- Responda APENAS com o token abaixo, sozinho na primeira linha, e na linha seguinte
  uma frase curta com a evidência:
  ${SINAL_URA}
  <evidência em uma linha — ex.: "Bot de CPF/CNPJ da Construtora Pride, não é o contato da pessoa">
  Esse token é interno: o sistema intercepta, registra a nota e NÃO envia nada pro WhatsApp.
- Na dúvida (pode ser uma pessoa, mesmo que confusa), NÃO use o token — responda
  normalmente como Lúcio. O token é só pra casos claros de máquina/URA.
`;

// Marcadores de "estado interno" que JAMAIS podem ir pro lead. Rede de segurança:
// se o modelo narrar operação interna apesar do prompt, o bridge bloqueia o envio.
const MARCADORES_VAZAMENTO = [
  /modo mudo/i,
  /handoff/i,
  /n[ãa]o vou responder (ao lead|enquanto)/i,
  /contexto registrado/i,
  /\[nota interna/i,
  /closer humano/i,
  /aguardando qualifica[çc]/i,
  /🪄/,
];

/** True se o texto parece narração de estado interno (não pode ir pro lead). */
export function pareceVazamentoInterno(texto) {
  if (!texto) return false;
  return MARCADORES_VAZAMENTO.some(re => re.test(texto));
}

// Casa o token de central automática mesmo com variações (espaços, _/-, acento).
const RE_SINAL_URA = /\[\[\s*CENTRAL[-_ ]?AUTOM[ÁA]TICA\s*\]\]/i;

/**
 * Detecta o sinal de central automática / URA emitido pelo agente.
 * @param {string} texto - Resposta crua do SDK.
 * @returns {{ura: boolean, justificativa: string}}
 */
export function detectarSinalUra(texto) {
  if (!texto || !RE_SINAL_URA.test(texto)) return { ura: false, justificativa: '' };
  const justificativa = texto
    .replace(RE_SINAL_URA, '')
    .replace(/^[\s:>*\-–—]+/, '')
    .trim();
  return { ura: true, justificativa };
}

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
  const systemPrompt = SYSTEM_BASE + ESTILO_WHATSAPP + DETECCAO_URA;

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

  const rotuloPor = (autor) => {
    if (autor === 'lead') return 'Lead';
    if (autor === 'humano') return 'Humano (Luminus)';
    if (autor === 'nota_interna') return '[NOTA INTERNA closer — invisível pro lead]';
    return 'Lúcio';
  };
  const historicoTexto = (historico || [])
    .map(m => `[${m.enviada_em}] ${rotuloPor(m.autor)}: ${m.texto}`)
    .join('\n') || '(sem histórico)';

  const userPrompt = `${contextoLead}

## Histórico recente
${historicoTexto}

## Mensagem agora chegou do lead
${mensagemAtual}

Responda como Lúcio. Texto direto, sem prefixo.`;

  try {
    const { texto, tokensIn, tokensOut } = await gerarTexto({
      system: systemPrompt,
      user: userPrompt,
      maxTokens: parseInt(process.env.LUCIO_MAX_TOKENS || '1024', 10),
      label: 'inbound',
    });
    // sessionId não existe mais (era do agent SDK). Ninguém consome — mantido null
    // na assinatura por compatibilidade.
    // Rede de segurança: arranca tag interna vazada / normaliza travessão antes
    // de devolver. O token [[CENTRAL-AUTOMATICA]] (URA) usa colchete duplo e
    // sobrevive — a detecção de URA no server.js segue funcionando.
    return { resposta: limparTextoOutbound(texto), sessionId: null, tokensIn, tokensOut };
  } catch (err) {
    console.error('[lucio-agent] erro no SDK:', err);
    throw err;
  }
}
