'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { countText } = require('../lib/text-tokens');
const root = path.resolve(__dirname, '..');

test('offline known encoding counts ordinary text, Unicode, empty text, and special spellings', () => {
  assert.equal(countText('hello world', { model: 'gpt-5' }).tokens, 2);
  assert.equal(countText('', { model: 'gpt-5' }).tokens, 0);
  const text = '你好 👩🏽‍💻\r\n<|endoftext|>\n';
  const result = countText(text, { model: 'gpt-5', fingerprint: true });
  assert.equal(result.status, 'tokenized');
  assert.equal(result.bytes, Buffer.byteLength(text));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.assetsSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.consumerMappingVerified, false);
  assert.equal(result.billedTokens, null);
  const lib = require('js-tiktoken');
  const encoding = lib.getEncoding('o200k_base');
  const ids = encoding.encode(text, [], []);
  assert.equal(encoding.decode(ids), text);
  assert.equal(result.tokens, ids.length);
});

test('unknown/Claude/future model never silently inherits a GPT encoding', () => {
  for (const model of [null, 'claude-sonnet-4', 'gpt-5.6-sol', 'gpt-6-astra', 'invented-model']) {
    const result = countText('hello world', { model });
    assert.equal(result.status, 'estimated');
    assert.equal(result.encoding, null);
    assert.equal(result.tokens, 3);
    assert.match(result.reason, /^model-not-/);
  }
  assert.equal(countText('hello', { local: false }).reason, 'local-counting-disabled');
  assert.equal(countText('x'.repeat(8 * 1024 * 1024 + 1), { model: 'gpt-5' }).reason, 'text-exceeds-local-limit');
});

test('explicit encoding is not represented as a verified model mapping', () => {
  const result = countText('hello world', { encoding: 'cl100k_base' });
  assert.equal(result.mapping, 'explicit-encoding');
  assert.equal(result.consumerMappingVerified, false);
  assert.equal(countText('hello', { encoding: 'invented' }).reason, 'encoding-not-supported');
});

test('file/stdin CLI retains exact UTF-8/BOM/newlines and refuses incomplete measurements', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-token-test-'));
  try {
    const file = path.join(dir, 'report.json');
    const text = '\uFEFF{"status":"failing","message":"你好"}\r\n';
    fs.writeFileSync(file, text);
    const run = (args, input) => spawnSync(process.execPath, ['token-count.js', ...args], { cwd: root, input, encoding: 'utf8' });
    const byFile = run(['--model', 'gpt-5', file]);
    const byStdin = run(['--model', 'gpt-5', '-'], text);
    assert.equal(byFile.status, 0, byFile.stderr);
    assert.equal(byStdin.status, 0, byStdin.stderr);
    assert.deepEqual(JSON.parse(byFile.stdout), JSON.parse(byStdin.stdout));
    assert.equal(JSON.parse(byFile.stdout).bytes, Buffer.byteLength(text));
    assert.equal(run(['--model', 'invented'], text).status, 2);
    assert.equal(run(['--encoding', 'invented'], text).status, 2);
    assert.equal(run(['--model', 'gpt-5', '--encoding', 'o200k_base'], text).status, 1);
    assert.equal(run(['--model']).status, 1);
    assert.equal(run(['--model', 'gpt-5', '--bad']).status, 1);
    assert.equal(run(['--model', 'gpt-5', path.join(dir, 'missing')]).status, 1);
    assert.equal(run(['--model', 'gpt-5'], Buffer.from([0xff])).status, 1);
    assert.equal(run(['--model', 'gpt-5'], Buffer.alloc(8 * 1024 * 1024 + 1)).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('optional tokenizer absence keeps estimates available without importing AI clients', () => {
  const script = `const Module = require('module'); const old = Module._load;
    Module._load = function(name, ...args) { if (name === 'js-tiktoken') {
      const error = new Error("Cannot find module 'js-tiktoken'"); error.code = 'MODULE_NOT_FOUND'; throw error;
    } return old.call(this, name, ...args); };
    console.log(JSON.stringify(require('./lib/text-tokens').countText('hello', {model:'gpt-5'})));`;
  const child = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).reason, 'tokenizer-not-installed');
});
