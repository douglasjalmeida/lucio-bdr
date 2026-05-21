// Setup idempotente das etapas do CRM externo (funis Marketing + Vendas).
// Cria no CRM as mesmas etapas que o Lúcio usa internamente, pra o espelho
// (crm-client.espelharTransicao) ter destino válido.
//
// Pré-requisito: CRM_BASE_URL + CRM_API_TOKEN preenchidos no .env.
// Uso: node scripts/crm-setup.js
//
// Roda quantas vezes quiser — etapas que já existem são puladas.

import 'dotenv/config';
import { crmEnabled, crmConfig, garantirStages, listarStages } from '../src/crm-client.js';

async function main() {
  if (!crmEnabled()) {
    console.error('✗ CRM off: preencha CRM_BASE_URL e CRM_API_TOKEN no .env.');
    process.exit(1);
  }
  console.log(`→ CRM: ${crmConfig().base}`);

  // Sanidade: lê as etapas atuais dos dois funis antes de mexer.
  for (const funil of ['marketing', 'sales']) {
    const atuais = await listarStages(funil);
    console.log(`  ${funil}: ${atuais.length} etapa(s) hoje — ${atuais.map(s => s.name).join(', ') || '(nenhuma)'}`);
  }

  console.log('\n→ Garantindo etapas...');
  const rel = await garantirStages();
  for (const funil of ['marketing', 'sales']) {
    console.log(`\n  [${funil}]`);
    for (const r of rel[funil]) console.log(`    ${r.status === 'criada' ? '＋' : '·'} ${r.name} — ${r.status}`);
  }
  console.log('\n✓ Setup concluído.');
}

main().catch(e => { console.error('✗ Falhou:', e.message); process.exit(1); });
