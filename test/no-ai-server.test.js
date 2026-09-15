'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');

test('--no-ai server serves local counting metadata and refuses model analysis', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-no-ai-test-'));
  // Copy the server into an isolated root so its rollup cache cannot touch the user's.
  const root = path.resolve(__dirname, '..');
  for (const name of ['server.js', 'index.html', 'lib']) fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(dir, 'codex', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'claude', 'projects'), { recursive: true });
  const child = spawn(process.execPath, [path.join(dir, 'server.js'), '--no-ai', '--local-tokens', '--port', '0',
    '--root', path.join(dir, 'codex'), '--claude-root', path.join(dir, 'claude')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let logs = '';
  try {
    const url = await new Promise((resolve, reject) => {
      child.stdout.on('data', data => {
        logs += data;
        const match = logs.match(/http:\/\/localhost:(\d+)/);
        if (match) resolve(`http://127.0.0.1:${match[1]}`);
      });
      child.stderr.on('data', data => { logs += data; });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited ${code}: ${logs}`)));
    });
    const deepen = await fetch(`${url}/api/deepen?id=test`);
    assert.equal(deepen.status, 403);
    assert.equal((await deepen.json()).disabled, true);
    const economy = await (await fetch(`${url}/api/economy?range=all`)).json();
    assert.equal(economy.textTokenPolicy.local, true);
    assert.equal(economy.textTokenPolicy.tokenizer, 'js-tiktoken@1.0.21');
    assert.deepEqual(economy.textTokenMeasurements, {});
    const page = await (await fetch(url)).text();
    assert.match(page, /logged text only/);
  } finally {
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
