// Testa só o qualifier (Haiku), sem tocar Supabase.
import 'dotenv/config';
import { avaliarQualificacao } from '../src/qualifier.js';

const casos = [
  {
    titulo: 'CASO 1 — sinal forte (preço + dor + urgência)',
    historico: [
      { autor: 'ia', texto: 'Oi! Se cair energia, quanto tempo aguenta?' },
      { autor: 'lead', texto: 'Cai 4h semana passada, perdi 80 mil. Preciso de gerador URGENTE, manda preço e prazo, fecho essa semana.' },
    ],
    esperado: true,
  },
  {
    titulo: 'CASO 2 — curiosidade rasa',
    historico: [
      { autor: 'ia', texto: 'Oi! Aqui é o Lúcio da Luminus.' },
      { autor: 'lead', texto: 'quem é vc?' },
    ],
    esperado: false,
  },
  {
    titulo: 'CASO 3 — pediu pra parar',
    historico: [
      { autor: 'ia', texto: 'Oi! Faz sentido falarmos de gerador?' },
      { autor: 'lead', texto: 'Não tenho interesse, para de mandar mensagem' },
    ],
    esperado: false,
  },
  {
    titulo: 'CASO 4 — pediu humano',
    historico: [
      { autor: 'ia', texto: 'Oi! Aqui é o Lúcio, bot da Luminus.' },
      { autor: 'lead', texto: 'prefiro falar com vendedor humano, pode passar contato?' },
    ],
    esperado: true,
  },
];

const lead = { nome: 'Teste', empresa: 'ACME', cadencia_id: 'geradores-b2b-v1', passo_atual: 1 };

for (const c of casos) {
  console.log(`\n${c.titulo}`);
  const r = await avaliarQualificacao({ lead, historico: c.historico, ultimaRespostaLucio: '' });
  const ok = r.qualified === c.esperado ? '✅' : '❌';
  console.log(`  ${ok} qualified=${r.qualified} (esperado=${c.esperado})`);
  console.log(`     urgencia=${r.urgencia} dor="${r.dor_identificada}"`);
  console.log(`     sinais: ${r.sinais}`);
}
