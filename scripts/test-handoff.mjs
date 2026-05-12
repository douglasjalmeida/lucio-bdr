// Teste end-to-end do qualifier + handoff (sem WhatsApp real).
// Usa lead fictício, simula histórico com sinais fortes de intenção,
// roda qualifier (Haiku), e se qualified=true dispara handoff (Chatwoot + Supabase + notify).
import 'dotenv/config';
import { avaliarQualificacao } from '../src/qualifier.js';
import { executarHandoff } from '../src/handoff.js';
import { garantirLeadNoChatwoot, espelharMensagemConversa } from '../src/chatwoot-client.js';
import { criarLead, buscarLeadPorTelefone, gravarMensagem } from '../src/supabase-client.js';

const TEL = '+5511977776666';
const NOME = 'Joao Teste Handoff';

console.log('1) garantindo lead no Supabase...');
let lead = await buscarLeadPorTelefone(TEL);
if (!lead) lead = await criarLead({ nome: NOME, telefone: TEL, empresa: 'Industria Teste SA', segmento: 'industria', origem: 'teste-handoff' });
console.log('   lead_id=', lead.id, 'status=', lead.status, 'modo=', lead.modo);

console.log('\n2) garantindo conversa no Chatwoot...');
const cw = await garantirLeadNoChatwoot({ telefone: TEL, nome: NOME, customAttrs: { empresa: 'Industria Teste SA', setor: 'industria' } });
console.log('   ->', cw);

console.log('\n3) montando histórico simulado com sinal forte (lead pediu preço + dor concreta)...');
const historico = [
  { autor: 'ia',   texto: 'Oi João! Aqui é o Lúcio da Luminus. Se cair a energia agora, quanto tempo vocês aguentam antes de virar prejuízo?', enviada_em: '2026-05-12T17:00:00Z' },
  { autor: 'lead', texto: 'Cara, semana passada caiu 4h e perdi 80 mil em produção. Tô precisando de gerador URGENTE.', enviada_em: '2026-05-12T17:05:00Z' },
  { autor: 'ia',   texto: 'Putz, 80k é dor real. Pra fugir desse risco, a Luminus tem gerador + manutenção como serviço (MPaaS). Faz sentido eu te explicar?', enviada_em: '2026-05-12T17:10:00Z' },
  { autor: 'lead', texto: 'Sim, manda preço e prazo. Preciso fechar essa semana.', enviada_em: '2026-05-12T17:15:00Z' },
];

const ultimaRespostaLucio = 'Beleza, vou te conectar com nosso closer pra alinhar preço e prazo. Te ligo em seguida.';

console.log('\n4) rodando qualifier (Haiku)...');
const q = await avaliarQualificacao({ lead, historico, ultimaRespostaLucio });
console.log('   resultado:', q);

if (!q.qualified) {
  console.error('\n❌ Qualifier disse que NÃO é MQL. Esperado: SIM. Conferir prompt.');
  process.exit(1);
}

console.log('\n5) executando handoff...');
const r = await executarHandoff({ lead, qualificacao: q, chatwootCtx: cw });
console.log('   resultado:', r);

console.log('\n6) re-checa lead no Supabase (deve estar modo=mudo, status=handoff)...');
const leadAtt = await buscarLeadPorTelefone(TEL);
console.log('   lead_id=', leadAtt.id, 'status=', leadAtt.status, 'modo=', leadAtt.modo);

console.log('\n✅ Teste E2E handoff concluído.');
