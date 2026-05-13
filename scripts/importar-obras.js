// Importador: arquivos .xlsx de "pesquisa de obras" → Supabase (obras + leads + lead_obras).
//
// Estratégia:
//   - Cada linha do xlsx é uma OBRA. Insere em `obras` usando "Código" como chave externa.
//   - Cada obra tem até 22 contatos (colunas "Nome do Contato N" / "Telefone do Contato N" etc).
//   - Pra cada contato com nome+telefone:
//       * normaliza telefone E.164 (+55 prefix se faltar)
//       * upsert em `leads` por telefone (cria se novo; atualiza só campos vazios)
//       * insere link em `lead_obras` (lead_id, obra_id, posicao) — idempotente por unique
//   - Por padrão NÃO enriquece CNPJ (--enriquecer faz consulta BrasilAPI 1/s, em fluxo serial).
//
// NÃO dispara cadência. NÃO envia mensagem. Só popula schema.
//
// Uso:
//   node scripts/importar-obras.js [opções]
//     --dir <pasta>           default: docs/inbox/
//     --dry-run               mostra estatísticas, não escreve
//     --enriquecer-cnpj       consulta BrasilAPI pra cada CNPJ novo
//     --filtro-estagio "EM CONSTRUÇÃO,FUNDAÇÕES"   (CSV uppercase)
//     --limite-obras N        processa só N obras (debug)
//     --verbose

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { supabase, supabaseEnabled } from '../src/supabase-client.js';
import { classificaTipoEmpresa, derivaTagsPreToque } from '../src/cnpj-enrichment.js';

const require = createRequire(import.meta.url);
let XLSX;
try { XLSX = require('xlsx'); } catch {
  console.error('Falta dep "xlsx". Rode: npm install xlsx');
  process.exit(1);
}

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const DIR = path.resolve(arg('dir', 'docs/inbox'));
const DRY = flag('dry-run');
const FILTRO_ESTAGIO = (arg('filtro-estagio', '') || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const LIMITE_OBRAS = arg('limite-obras', null) ? parseInt(arg('limite-obras'), 10) : null;
const VERBOSE = flag('verbose');

if (!supabaseEnabled() && !DRY) {
  console.error('Supabase não configurado. Verifica .env ou rode com --dry-run.');
  process.exit(1);
}

// ─── Normalização ───────────────────────────────────────────────────────────
function normalizaTelefoneBR(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\D/g, '');
  if (!s) return null;
  // Remove zero à esquerda do DDD ("048..." → "48...")
  if (s.length >= 11 && s.startsWith('0')) s = s.slice(1);
  // Adiciona 55 se faltar (10 ou 11 dígitos = nº brasileiro sem código país)
  if (s.length === 10 || s.length === 11) s = '55' + s;
  // Validação básica
  if (s.length < 12 || s.length > 13) return null;
  return '+' + s;
}

function safe(v) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v.trim() : v;
  return s === '' ? null : s;
}

function toDate(v) {
  if (!v) return null;
  // xlsx pode entregar como Date, string ou número serial
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // serial Excel → JS
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const m = String(v).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let [_, dd, mm, yyyy] = m;
    if (yyyy.length === 2) yyyy = (+yyyy > 50 ? '19' : '20') + yyyy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ─── Mapeamento de colunas → coluna `obras` ─────────────────────────────────
function montaObra(row) {
  const codigo = safe(row['Código']);
  if (!codigo) return null;
  return {
    codigo_externo: String(codigo),
    nome: safe(row['Nome da Obra']),
    segmento: safe(row['Segmento de Atuação']),
    subtipo: safe(row['Subtipo']),
    estagio_atual: safe(row['Estágio Atual']),
    fase: safe(row['Fase']),
    valor_investimento: toNum(row['Valor do Investimento R$']),
    area_construida_m2: toNum(row['Área total construída (m2)']),
    endereco: safe(row['Endereço']),
    bairro: safe(row['Bairro']),
    cidade: safe(row['Cidade']),
    estado: safe(row['Estado']),
    cep: safe(row['Cep']),
    inicio_obra: toDate(row['Início da Obra']),
    termino_obra: toDate(row['Término da Obra']),
    n_edificios: toNum(row['N° de Edifícios']),
    n_pavimentos: toNum(row['Nº de Pavimentos']),
    n_unidades: toNum(row['Total de Unidades']),
    detalhes: safe(row['Detalhes']),
    raw_json: row,
  };
}

function extraiContatos(row) {
  const contatos = [];
  for (let n = 1; n <= 22; n++) {
    const nome = safe(row[`Nome do Contato ${n}`]);
    const tel = normalizaTelefoneBR(safe(row[`Telefone do Contato ${n}`]));
    if (!nome || !tel) continue;
    contatos.push({
      posicao: n,
      nome,
      telefone: tel,
      cargo: safe(row[`Cargo ${n}`]),
      email: safe(row[`Email do Contato ${n}`]),
      empresa_nome: safe(row[`Nome Fantasia da Empresa ${n}`]),
      cnpj: safe(row[`CNPJ ${n}`]),
    });
  }
  return contatos;
}

// ─── Upserts ────────────────────────────────────────────────────────────────
async function upsertObra(obra) {
  if (DRY) return { id: -1, _dry: true };
  const { data, error } = await supabase
    .from('obras')
    .upsert(obra, { onConflict: 'codigo_externo' })
    .select('id').single();
  if (error) throw new Error(`obra upsert ${obra.codigo_externo}: ${error.message}`);
  return data;
}

async function upsertLead(contato, obraInfo, enriquecimento) {
  if (DRY) return { id: -1, _dry: true };

  // Busca lead existente por telefone
  const { data: existente } = await supabase
    .from('leads').select('*').eq('telefone', contato.telefone).maybeSingle();

  const tags = enriquecimento
    ? derivaTagsPreToque({ enriquecimento, obra: obraInfo })
    : [];

  if (existente) {
    // Atualiza só campos vazios (não sobrescreve nome/empresa preenchidos manualmente)
    const patch = {};
    if (!existente.nome && contato.nome) patch.nome = contato.nome;
    if (!existente.cargo && contato.cargo) patch.cargo = contato.cargo;
    if (!existente.email && contato.email) patch.email = contato.email;
    if (!existente.empresa && contato.empresa_nome) patch.empresa = contato.empresa_nome;
    if (!existente.cnpj && contato.cnpj) patch.cnpj = String(contato.cnpj).replace(/\D/g, '');
    if (enriquecimento) {
      if (!existente.razao_social && enriquecimento.razao_social) patch.razao_social = enriquecimento.razao_social;
      if (!existente.cnae_primario && enriquecimento.cnae_primario) patch.cnae_primario = enriquecimento.cnae_primario;
      if (!existente.tipo_empresa && enriquecimento.tipo_empresa) patch.tipo_empresa = enriquecimento.tipo_empresa;
      if (existente.capital_social == null && enriquecimento.capital_social != null) patch.capital_social = enriquecimento.capital_social;
      if (!existente.situacao_cadastral && enriquecimento.situacao_cadastral) patch.situacao_cadastral = enriquecimento.situacao_cadastral;
      if (!existente.data_abertura_empresa && enriquecimento.data_abertura_empresa) patch.data_abertura_empresa = enriquecimento.data_abertura_empresa;
      if (tags.length) {
        const atuais = Array.isArray(existente.tags) ? existente.tags : [];
        patch.tags = [...new Set([...atuais, ...tags])];
      }
    }
    if (Object.keys(patch).length) {
      patch.atualizado_em = new Date().toISOString();
      const { error } = await supabase.from('leads').update(patch).eq('id', existente.id);
      if (error) throw new Error(`lead update ${contato.telefone}: ${error.message}`);
    }
    return existente;
  }

  // Cria novo
  const novo = {
    nome: contato.nome,
    telefone: contato.telefone,
    empresa: contato.empresa_nome,
    cargo: contato.cargo,
    email: contato.email,
    cnpj: contato.cnpj ? String(contato.cnpj).replace(/\D/g, '') : null,
    razao_social: enriquecimento?.razao_social || null,
    cnae_primario: enriquecimento?.cnae_primario || null,
    tipo_empresa: enriquecimento?.tipo_empresa || null,
    capital_social: enriquecimento?.capital_social || null,
    situacao_cadastral: enriquecimento?.situacao_cadastral || null,
    data_abertura_empresa: enriquecimento?.data_abertura_empresa || null,
    tags,
    origem: 'xlsx-obras',
    segmento: obraInfo?.segmento || null,
  };
  const { data, error } = await supabase.from('leads').insert(novo).select('id').single();
  if (error) throw new Error(`lead insert ${contato.telefone}: ${error.message}`);
  return data;
}

async function linkLeadObra(lead_id, obra_id, contato) {
  if (DRY) return;
  const { error } = await supabase
    .from('lead_obras')
    .upsert({
      lead_id, obra_id,
      posicao: contato.posicao,
      papel: 'contato_obra',
      contato_nome: contato.nome,
      contato_cargo: contato.cargo,
      contato_email: contato.email,
    }, { onConflict: 'lead_id,obra_id,posicao' });
  if (error) throw new Error(`lead_obras ${lead_id}<>${obra_id}: ${error.message}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const arquivos = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.xlsx'))
    .map(f => path.join(DIR, f)).sort();
  if (!arquivos.length) { console.error(`Sem xlsx em ${DIR}`); process.exit(1); }

  let obrasTotais = 0, obrasFiltradas = 0, contatosTotais = 0, contatosImportados = 0;
  const telefonesDedup = new Set();
  const tiposDist = {};

  for (const f of arquivos) {
    console.log(`\n=== ${path.basename(f)} ===`);
    const wb = XLSX.readFile(f);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

    for (const row of rows) {
      if (LIMITE_OBRAS && obrasFiltradas >= LIMITE_OBRAS) break;
      obrasTotais++;
      const estagio = (row['Estágio Atual'] || '').toString().toUpperCase();
      if (FILTRO_ESTAGIO.length && !FILTRO_ESTAGIO.includes(estagio)) continue;

      const obraDado = montaObra(row);
      if (!obraDado) continue;
      obrasFiltradas++;

      let obra;
      try { obra = await upsertObra(obraDado); }
      catch (err) { console.error(`  obra erro: ${err.message}`); continue; }

      const contatos = extraiContatos(row);
      for (const c of contatos) {
        contatosTotais++;
        telefonesDedup.add(c.telefone);

        // Classificação 100% por dado local (sem provider externo): heurística de
        // texto sobre nome fantasia. Sem CNAE/Receita/score nesta fase.
        const tipo = classificaTipoEmpresa({
          cnaePrimario: null,
          razaoSocial: null,
          nomeFantasia: c.empresa_nome,
        });
        const enriquecimento = c.empresa_nome ? {
          razao_social: null,
          nome_fantasia: c.empresa_nome,
          cnae_primario: null,
          capital_social: null,
          situacao_cadastral: null,
          data_abertura_empresa: null,
          tipo_empresa: tipo,
        } : null;

        try {
          const lead = await upsertLead(c, obraDado, enriquecimento);
          if (!DRY && lead?.id) await linkLeadObra(lead.id, obra.id, c);
          contatosImportados++;
          tiposDist[tipo] = (tiposDist[tipo] || 0) + 1;
          if (VERBOSE) console.log(`  + ${c.telefone}  ${c.nome}  [${tipo}]  (obra ${obraDado.codigo_externo})`);
        } catch (err) {
          console.error(`  contato erro ${c.telefone}: ${err.message}`);
        }
      }
    }
  }

  console.log('\n──────────────── RESUMO ────────────────');
  console.log(`Obras lidas:           ${obrasTotais}`);
  console.log(`Obras dentro do filtro:${obrasFiltradas}`);
  console.log(`Contatos lidos:        ${contatosTotais}`);
  console.log(`Contatos importados:   ${contatosImportados}`);
  console.log(`Telefones únicos:      ${telefonesDedup.size}`);
  console.log(`Tipos (por contato):   ${JSON.stringify(tiposDist)}`);
  console.log(`Modo:                  ${DRY ? 'DRY-RUN (nada gravado)' : 'gravado em prod'}`);
}

main().catch(err => { console.error('[importar-obras] erro fatal:', err); process.exit(1); });
