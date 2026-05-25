// Smoke test do outbound: prepara o lead de teste (395, número do Douglas) pra
// disparo IMEDIATO e deixa o tick do bridge enviar. NÃO envia direto — só agenda.
import 'dotenv/config';
import { supabase } from '../src/supabase-client.js';

const LEAD = 395;
// 1) cancela pendentes antigos do lead
await supabase.from('agendamentos_disparos').update({ status: 'cancelado' })
  .eq('lead_id', LEAD).eq('status', 'pendente');
// 2) reseta pra elegível
await supabase.from('leads').update({ modo: 'bot', status: 'em_cadencia', passo_atual: 0, cadencia_id: 1 }).eq('id', LEAD);
// 3) agenda passo 1 pra agora (vencido)
const { data, error } = await supabase.from('agendamentos_disparos')
  .insert({ lead_id: LEAD, passo: 1, agendado_para: new Date(Date.now() - 60000).toISOString(), status: 'pendente' })
  .select().single();
if (error) { console.error('erro:', error.message); process.exit(1); }
console.log('Smoke agendado: agendamento', data.id, 'lead', LEAD, '→ tick deve disparar em até ~60s');
process.exit(0);
