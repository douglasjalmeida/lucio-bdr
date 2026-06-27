// Preview LOCAL e READ-ONLY do dashboard, sem subir o bridge inteiro.
//
// Por que existe: `node src/server.js` sobe também os ticks de outbound +
// watchdog, que podem disparar mensagem em produção. Este preview serve só o
// HTML + os endpoints GET de leitura (chamando as MESMAS funções do server),
// sem nenhum tick, sem auth (é local). Pra você ver as mudanças do dash antes
// de deployar.
//
// Uso:  node --env-file=.env scripts/preview-dashboard.js   (abre em :8799)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { montarMetricas, listarCadenciasParaSeletor } from '../src/metrics.js';
import { resolverJanela } from '../src/periodo.js';
import { getSnapshotTrafego, getFunilBruno, getBrunoDashboard, getSlaAlertas } from '../src/dashboard-tabs.js';
import { listarTemperaturas } from '../src/temperatura-analyzer.js';
import { listarMensagensEnviadas, getOutboundEstado } from '../src/supabase-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const PORT = process.env.PREVIEW_PORT || 8799;

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  const q = u.searchParams;
  try {
    if (p === '/' || p === '/dashboard' || p === '/dashboard.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HTML);
    }
    const janela = resolverJanela({ periodo: q.get('periodo') || '7d', de: q.get('de'), ate: q.get('ate') });

    if (p === '/api/metrics') {
      const cadenciaId = q.get('cadencia') ? parseInt(q.get('cadencia'), 10) : null;
      return send(res, 200, { ok: true, ...(await montarMetricas({ periodo: q.get('periodo') || '7d', de: q.get('de'), ate: q.get('ate'), cadenciaId })) });
    }
    if (p === '/api/cadencias') return send(res, 200, { ok: true, cadencias: await listarCadenciasParaSeletor() });
    if (p === '/api/mensagens') {
      const cadenciaId = q.get('cadencia') ? parseInt(q.get('cadencia'), 10) : null;
      const limit = Math.min(parseInt(q.get('limit') || '100', 10), 300);
      return send(res, 200, { ok: true, mensagens: await listarMensagensEnviadas({ desde: janela.desde, ate: janela.ate, cadenciaId, limit }) });
    }
    if (p === '/api/outbound-estado') return send(res, 200, { ok: true, ...(await getOutboundEstado()) });
    if (p === '/api/sla') return send(res, 200, { ok: true, sla: await getSlaAlertas() });
    if (p === '/api/trafego') return send(res, 200, { ok: true, snapshot: await getSnapshotTrafego({ desde: janela.desde, ate: janela.ate }), janela });
    if (p === '/api/bruno') {
      const [funil, painel] = await Promise.all([
        getFunilBruno({ desde: janela.desde, ate: janela.ate }),
        getBrunoDashboard({ desde: janela.desde, ate: janela.ate }),
      ]);
      return send(res, 200, { ok: true, funil, ...painel });
    }
    if (p === '/api/leads-temperatura') return send(res, 200, { ok: true, leads: await listarTemperaturas() });
    // POST /api/outbound-estado é bloqueado de propósito (preview é read-only).
    if (p === '/api/outbound-estado' && req.method === 'POST') return send(res, 405, { ok: false, erro: 'preview é read-only' });
    res.writeHead(404); res.end('nope');
  } catch (err) {
    send(res, 500, { ok: false, erro: err.message });
  }
});

server.listen(PORT, () => console.log(`Preview read-only em http://localhost:${PORT}/dashboard  (Ctrl+C pra parar)`));
