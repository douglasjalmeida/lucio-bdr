import 'dotenv/config';
import {
  chatwootEnabled, chatwootConfig,
  garantirLeadNoChatwoot, espelharMensagemConversa, aplicarLabelsAditivo,
} from '../src/chatwoot-client.js';

console.log('Config:', chatwootConfig());
if (!chatwootEnabled()) { console.error('Chatwoot desligado'); process.exit(1); }

const TEL = '+5511988887777';
const NOME = 'Lead Teste Pipeline';

console.log('\n1) garantir lead no Chatwoot...');
const cw = await garantirLeadNoChatwoot({
  telefone: TEL, nome: NOME,
  customAttrs: { empresa: 'ACME Teste', setor: 'industria', cadencia: 'geradores-b2b-v1-teste' },
});
console.log('   ->', cw);

console.log('\n2) espelhando msg incoming (lead "respondeu")...');
const m1 = await espelharMensagemConversa({ conversationId: cw.conversationId, content: 'oi, quem fala?', direction: 'in' });
console.log('   msg id:', m1?.id);

console.log('\n3) espelhando resposta do Lucio (outgoing)...');
const m2 = await espelharMensagemConversa({ conversationId: cw.conversationId, content: 'Oi! Aqui é o Lúcio da Luminus. Tudo bem?', direction: 'out' });
console.log('   msg id:', m2?.id);

console.log('\n4) aplicando label mql-respondeu...');
const lbl = await aplicarLabelsAditivo(cw.conversationId, ['mql-respondeu']);
console.log('   labels agora:', lbl?.payload);

console.log('\nOK');
