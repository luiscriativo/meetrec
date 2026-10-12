// Estado global compartilhado entre as telas.
export const state = {
  settings: {},
  info: {},
  list: [],
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
};

export const api = window.api;
