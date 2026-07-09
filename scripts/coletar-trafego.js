// CLI de coleta manual de tráfego (dev). A lógica mora em src/trafego-coletor.js
// (lá porque o Dockerfile só copia src/). Em produção quem roda é o loop embutido
// no server (iniciarColetaAutomatica). Uso:
//   node --env-file=.env scripts/coletar-trafego.js            # últimos 35 dias
//   node --env-file=.env scripts/coletar-trafego.js --dias=120 # backfill

import { coletarTrafego } from '../src/trafego-coletor.js';

const arg = process.argv.find((a) => a.startsWith('--dias='));
const dias = arg ? Number(arg.split('=')[1]) : 35;
coletarTrafego({ dias })
  .then(() => process.exit(0))
  .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
