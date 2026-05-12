// Testa só o lado Chatwoot do handoff (label + nota + atribui team).
// Pula Supabase porque o projeto tá pausado.
import 'dotenv/config';
import { garantirLeadNoChatwoot, aplicarLabelsAditivo, removerLabels, addNotaPrivada, atribuirTeam, atualizarAtributosContato } from '../src/chatwoot-client.js';

const TEAM_ID = parseInt(process.env.CHATWOOT_CLOSERS_TEAM_ID || '1', 10);
const cw = await garantirLeadNoChatwoot({
  telefone: '+5511988887777', nome: 'Lead Teste Pipeline',
  customAttrs: { empresa: 'ACME Teste', setor: 'industria' },
});
console.log('Conversation:', cw.conversationId);

await removerLabels(cw.conversationId, ['mql-em-cadencia', 'mql-respondeu']);
await aplicarLabelsAditivo(cw.conversationId, ['mql-qualificado']);
console.log('  ✅ label mql-qualificado aplicada');

await addNotaPrivada(cw.conversationId, `🚨 MQL qualificado por Lúcio — handoff (TESTE)

*Lead:* Joao Teste (ACME)
*Urgência:* agora
*Dor:* Caiu energia 4h, prejuízo 80k

*Sinais:* pediu preço, urgência, janela fechar essa semana.
*Resumo pro closer:* Lead quente, fechar essa semana. Confirmar capacidade do gerador.`);
console.log('  ✅ nota privada postada');

await atribuirTeam(cw.conversationId, TEAM_ID);
console.log(`  ✅ atribuído ao team ${TEAM_ID}`);

await atualizarAtributosContato(cw.contactId, {
  dor_identificada: 'Caiu energia 4h, prejuízo 80k',
  urgencia: 'agora',
});
console.log('  ✅ custom attributes atualizados');
