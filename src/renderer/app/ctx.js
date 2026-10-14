// Estado global compartilhado entre as telas.
export const state = {
  settings: {},
  info: {},
  list: [],
  folders: [],        // [{ name, count, description, hasContext, hasDraft, glossary, hasHistory }]
  rec: { active: false },
  levels: { mic: 0, system: 0 },
  bridge: {},
  detectorApps: [],
  progress: {},       // id -> { step -> {state, progress, message, eta} }
  summaryStream: {},  // id -> texto parcial do resumo
  recWarnings: [],
  health: null,       // resultado do diagnóstico
  update: { state: 'idle' }, // status da atualização automática
  route: { view: 'home' },
};

export const ctx = {
  navigate: () => {},
  refreshSidebar: () => {},
  reloadList: async () => {},
  runHealth: async () => {},
  reloadFolders: async () => {},
};

export const api = window.api;

// Motor do resumo escolhido (Claude Code ou Codex CLI) — para os textos da interface
export const aiName = () => (state.settings.aiEngine === 'codex' ? 'Codex' : 'Claude');
export const aiHealth = () => (state.health || []).find((c) => c.ai && c.selected);
