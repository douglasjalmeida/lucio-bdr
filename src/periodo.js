// Resolvedor único da janela de período do dashboard (filtro GLOBAL).
//
// Aceita os presets do seletor (24h | 7d | 15d | 30d) e 'custom' com de/ate
// (datas YYYY-MM-DD). Devolve { periodo, desde, ate } onde desde/ate são ISO.
// ate === null => "sem limite superior" (até agora). Default seguro = 7 dias.
//
// BR é UTC-3 fixo (sem horário de verão desde 2019), então os limites de dia do
// modo personalizado usam o offset -03:00 — 00:00 BR do início, 23:59 BR do fim.

const DIAS = { '24h': 1, '7d': 7, '15d': 15, '30d': 30 };

export function resolverJanela({ periodo = '7d', de = null, ate = null } = {}) {
  const agora = Date.now();

  // Personalizado: precisa de data inicial; sem ela, cai no default.
  if (periodo === 'custom' && de) {
    const desdeISO = new Date(`${de}T00:00:00.000-03:00`).toISOString();
    const ateISO = ate
      ? new Date(`${ate}T23:59:59.999-03:00`).toISOString()
      : new Date(agora).toISOString();
    return { periodo: 'custom', desde: desdeISO, ate: ateISO };
  }

  const dias = DIAS[periodo] ?? 7;
  const periodoOk = DIAS[periodo] ? periodo : '7d';
  const desdeISO = new Date(agora - dias * 86400_000).toISOString();
  return { periodo: periodoOk, desde: desdeISO, ate: null };
}
