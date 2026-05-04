// Stub do MCP Chatwoot. Construção fica pra F3 (decisão B4 da spec).
// No MVP, exporta no-ops que o server.js chama "como se" Chatwoot estivesse plugado.
// Ativar tudo quando CHATWOOT_BASE_URL estiver definido no .env e o MCP custom existir.

const enabled = !!process.env.CHATWOOT_BASE_URL;

export function chatwootEnabled() {
  return enabled;
}

export async function espelharMensagem(_args) {
  if (!enabled) return null;
  // TODO F3: criar contato/conversa se não existir, mandar mensagem como agent.
  return null;
}

export async function aplicarLabel(_leadId, _label) {
  if (!enabled) return null;
  // TODO F3.
  return null;
}

export async function escreverNotaPrivada(_leadId, _texto) {
  if (!enabled) return null;
  // TODO F3.
  return null;
}

export async function atribuirCloser(_leadId) {
  if (!enabled) return null;
  // TODO F3: round-robin sobre CHATWOOT_CLOSER_IDS.
  return null;
}

export async function moverPipeline(_leadId, _estagio) {
  if (!enabled) return null;
  // TODO F3.
  return null;
}
