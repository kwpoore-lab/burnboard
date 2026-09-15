'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { countText } = require('../lib/text-tokens');
const codex = require('../lib/sources/codex');
const claude = require('../lib/sources/claude');
const timestamp = '2026-09-12T12:00:00Z';

async function scan(factory, rows, localTokens) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-source-test-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, rows.map(row => JSON.stringify({ timestamp, ...row })).join('\n'));
    return await factory({ argVal: (_, fallback) => fallback, localTokens }).scanSession(file, fs.statSync(file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const record = (type, payload) => ({ type, payload });
const call = id => record('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"test"}', call_id: id });
const output = (id, text) => record('response_item', { type: 'function_call_output', call_id: id, output: text });

test('Codex counts delivered text rather than original truncation marker, with turn/call model custody', async () => {
  const clipped = 'Warning: truncated output (original token count: 999999)\nFAIL';
  const rows = [record('turn_context', { model: 'gpt-5' }), call('a'),
    record('turn_context', { model: 'gpt-6-astra' }), output('a', clipped), call('b'), output('b', 'hello world'),
    record('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 123, input_tokens: 100, output_tokens: 23 }, last_token_usage: { total_tokens: 123 } } })];
  const result = await scan(codex, rows, true);
  assert.equal(result.recentCmds[0].textTokens.model, 'gpt-5');
  assert.equal(result.recentCmds[0].textTokens.status, 'tokenized');
  assert.equal(result.recentCmds[0].originalOutputTokens, 999999);
  assert.equal(result.recentCmds[0].o, countText(clipped, { model: 'gpt-5' }).tokens);
  assert.equal(result.recentCmds[0].tr, 1);
  assert.equal(result.recentCmds[1].textTokens.status, 'estimated');
  assert.equal(result.totals.billed, 123);
  const estimated = await scan(codex, rows, false);
  assert.deepEqual(estimated.totals, result.totals);
  assert.equal(estimated.recentCmds[0].textTokens.reason, 'local-counting-disabled');
  const unmatched = await scan(codex, [output('absent', 'hello')], true);
  assert.equal(Object.values(unmatched.textTokenMeasurements)[0].reason, 'model-not-recorded');
});

test('Claude never uses the OpenAI tokenizer; request billing remains recorded separately', async () => {
  const rows = [{ type: 'assistant', message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'hello world' }] } }];
  const result = await scan(claude, rows, true);
  assert.equal(result.recentCmds[0].textTokens.model, 'claude-sonnet-4');
  assert.equal(result.recentCmds[0].textTokens.status, 'estimated');
  assert.equal(result.outTokens, 3);
  assert.equal(result.totals.billed, 15);
});
