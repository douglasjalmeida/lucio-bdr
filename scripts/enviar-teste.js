// Teste de envio outbound imediato pro Douglas + Fernando.
// Gera o toque T+0 real (formularToque, cadência geradores-b2b-v1) e:
//   - SEM --send  → dry-run: só imprime a mensagem (preview, NÃO envia)
//   - COM --send  → envia via uazapi /sender/advanced (delay 0, entrega na hora)
//                   e grava em mensagens (out, autor=ia).
//
// Uso: node scripts/enviar-teste.js          (preview)
//      node scripts/enviar-teste.js --send   (dispara de verdade)

import 'dotenv/config';
import { supabase, gravarMensagem } from '../src/supabase-client.js';
import { formularToque } from '../src/cadence-engine.js';
import { enviarTextoImediato, uazapiEnabled } from '../src/uazapi-client.js';

const ALVOS = [395, 396]; // Douglas, Fernando
const ENVIAR = process.argv.includes('--send');

async function main() {
  const { data: passo } = await supabase
    .from('passos_cadencia').select('prompt_orientacao')
    .eq('cadencia_id', 1).eq('ordem', 1).single();

  for (const id of ALVOS) {
    const { data: lead } = await supabase.from('leads').select('*').eq('id', id).single();
    if (!lead) { console.log(`lead ${id} não existe`); continue; }

    const { texto, tokensIn, tokensOut } = await formularToque({
      lead, passo: 1, promptOrientacao: passo?.prompt_orientacao || '', historico: [],
    });

    console.log(`\n──────── ${lead.nome} (${lead.telefone}) ────────`);
    console.log(texto);
    console.log(`──────── (${texto.length} chars) ────────`);

    if (ENVIAR) {
      if (!uazapiEnabled()) { console.error('✗ uazapi off — não enviei'); continue; }
      const r = await enviarTextoImediato({ telefone: lead.telefone, texto });
      await gravarMensagem({
        lead_id: id, chatid: null, direcao: 'out', autor: 'ia', texto,
        passo: 1, modo_no_momento: 'bot', tokens_in: tokensIn, tokens_out: tokensOut,
      });
      console.log(`✓ ENVIADO (folder_id=${r.folderId})`);
    }
  }

  console.log(ENVIAR ? '\n✓ Disparos concluídos.' : '\n→ PREVIEW (nada enviado). Rode com --send pra disparar.');
}

main().catch(e => { console.error('✗ Falhou:', e.message); process.exit(1); });
