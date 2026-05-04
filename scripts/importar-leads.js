// CSV -> Supabase. Formato esperado: nome,telefone,empresa,segmento,cadencia_id
// Telefone é deduplicado por chave única `leads.telefone` (E.164).
// Uso: node scripts/importar-leads.js docs/inbox/<arquivo>.csv

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { supabase, supabaseEnabled } from '../src/supabase-client.js';

function parseCSV(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines.shift().split(',').map(s => s.trim());
  return lines.map(line => {
    const cols = line.split(',').map(s => s.trim());
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
}

function normalizarTelefoneE164(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('55')) return `+${digits}`;
  if (digits.length === 11 || digits.length === 10) return `+55${digits}`;
  return `+${digits}`;
}

async function main() {
  if (!supabaseEnabled()) {
    console.error('Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.');
    process.exit(1);
  }
  const arquivo = process.argv[2];
  if (!arquivo) {
    console.error('uso: node scripts/importar-leads.js <caminho-do-csv>');
    process.exit(1);
  }
  const abs = path.resolve(arquivo);
  const content = fs.readFileSync(abs, 'utf8');
  const rows = parseCSV(content);
  console.log(`[importar-leads] ${rows.length} linha(s) lidas de ${abs}`);

  let inseridos = 0, dup = 0, invalidos = 0;
  for (const row of rows) {
    const telefone = normalizarTelefoneE164(row.telefone);
    if (!telefone) { invalidos++; continue; }
    const payload = {
      nome: row.nome || null,
      telefone,
      empresa: row.empresa || null,
      segmento: row.segmento || null,
      origem: 'csv-manual',
      cadencia_id: row.cadencia_id ? parseInt(row.cadencia_id, 10) : null,
    };
    const { error } = await supabase.from('leads').insert(payload);
    if (error) {
      if (error.code === '23505') dup++;
      else { console.error(`[importar-leads] erro ${telefone}:`, error.message); invalidos++; }
    } else {
      inseridos++;
    }
  }

  console.log(`[importar-leads] inseridos=${inseridos} duplicados=${dup} inválidos=${invalidos}`);
}

main().catch(err => { console.error(err); process.exit(1); });
