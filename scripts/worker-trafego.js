// Worker standalone de tráfego (opcional) — se um dia quiser rodar a coleta como
// service Node separado no Easypanel em vez de embutida no dashboard server.
// Em produção hoje quem roda é o loop dentro do src/server.js (iniciarColetaAutomatica),
// então este arquivo é só um atalho pra `node scripts/worker-trafego.js`.

import { iniciarColetaAutomatica } from '../src/trafego-coletor.js';

iniciarColetaAutomatica();
