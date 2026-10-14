const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodexEvent, friendlyError } = require('../src/main/codex');
const { engineOf, engineName } = require('../src/main/ai');

test('parseCodexEvent: formato atual (thread/turn/item)', () => {
  assert.match(parseCodexEvent({ type: 'thread.started', thread_id: 'x' }).status, /conectado/);
  assert.match(parseCodexEvent({ type: 'turn.started' }).status, /Aguardando/);
  assert.match(parseCodexEvent({ type: 'item.started', item: { id: '1', type: 'reasoning', text: '' } }).status, /analisando/);
  assert.deepEqual(parseCodexEvent({ type: 'item.updated', item: { type: 'agent_message', text: 'parcial' } }), { text: 'parcial' });
  assert.deepEqual(parseCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: '📋 RESUMO' } }), { final: '📋 RESUMO' });
  // nome antigo do campo (item_type / assistant_message)
  assert.deepEqual(parseCodexEvent({ type: 'item.completed', item: { item_type: 'assistant_message', text: 'ok' } }), { final: 'ok' });
  assert.match(parseCodexEvent({ type: 'item.started', item: { type: 'command_execution' } }).status, /consultando/);
  assert.deepEqual(parseCodexEvent({ type: 'turn.completed', usage: { input_tokens: 10 } }), { usage: { input_tokens: 10 } });
  assert.equal(parseCodexEvent({ type: 'turn.failed', error: { message: 'boom' } }).error, 'boom');
  assert.equal(parseCodexEvent({ type: 'error', message: 'falhou' }).error, 'falhou');
  assert.equal(parseCodexEvent({ type: 'item.completed', item: { type: 'todo_list' } }), null);
  assert.equal(parseCodexEvent(null), null);
});

test('parseCodexEvent: formato antigo ({ msg })', () => {
  assert.equal(parseCodexEvent({ id: '0', msg: { type: 'session_configured', model: 'gpt-x' } }).model, 'gpt-x');
  assert.deepEqual(parseCodexEvent({ msg: { type: 'agent_message_delta', delta: 'ab' } }), { delta: 'ab' });
  assert.deepEqual(parseCodexEvent({ msg: { type: 'agent_message', message: 'fim' } }), { final: 'fim' });
  assert.deepEqual(parseCodexEvent({ msg: { type: 'task_complete', last_agent_message: 'fim' } }), { final: 'fim' });
  assert.equal(parseCodexEvent({ msg: { type: 'task_complete' } }), null);
  assert.equal(parseCodexEvent({ msg: { type: 'error', message: 'x' } }).error, 'x');
  assert.match(parseCodexEvent({ msg: { type: 'agent_reasoning' } }).status, /analisando/);
});

test('friendlyError traduz os erros mais comuns do Codex', () => {
  assert.match(friendlyError('Error: Not logged in. Run codex login'), /codex login/);
  assert.match(friendlyError('unexpected status 401 Unauthorized'), /autenticado/);
  assert.match(friendlyError("You've hit your usage limit"), /Limite de uso/);
  assert.match(friendlyError('stream disconnected before completion'), /conexão/);
  assert.match(friendlyError('The model `xyz` does not exist'), /modelo/);
  assert.equal(friendlyError('algo estranho'), null);
});

test('engineOf / engineName', () => {
  assert.equal(engineOf({ aiEngine: 'codex' }), 'codex');
  assert.equal(engineOf({}), 'claude');
  assert.equal(engineOf({ aiEngine: 'qualquer' }), 'claude');
  assert.equal(engineName({ aiEngine: 'codex' }), 'Codex');
  assert.equal(engineName(undefined), 'Claude');
});
