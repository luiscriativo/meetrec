// Motor do resumo: Claude Code ou Codex CLI, escolhido em Configurações → Resumo.
// O resto do app (pipeline, perguntas, pastas) chama só runAI e não sabe qual CLI está por trás.
const { runClaude, claudeInfo } = require('./claude');
const { runCodex, codexInfo } = require('./codex');

const ENGINES = {
  claude: { name: 'Claude', cli: 'Claude Code', docs: 'https://docs.claude.com/en/docs/claude-code/setup', install: 'npm i -g @anthropic-ai/claude-code' },
  codex: { name: 'Codex', cli: 'Codex CLI', docs: 'https://developers.openai.com/codex/cli', install: 'npm i -g @openai/codex' },
};

const engineOf = (settings) => (settings?.aiEngine === 'codex' ? 'codex' : 'claude');
const engineName = (settings) => ENGINES[engineOf(settings)].name;

function runAI(opts) {
  return engineOf(opts.settings) === 'codex' ? runCodex(opts) : runClaude(opts);
}

function aiInfo(settings, engine = engineOf(settings)) {
  return engine === 'codex' ? codexInfo(settings) : claudeInfo(settings);
}

module.exports = { ENGINES, engineOf, engineName, runAI, aiInfo };
