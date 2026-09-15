'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encode, decode } = require('@msgpack/msgpack');
const createCache = require('../lib/rollup-cache');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burnboard-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warnings = [];
  const options = { root, version: 22, policy: { local: true }, warn: (...args) => warnings.push(args) };
  return { root, options, warnings, cache: createCache(options), files: () => {
    const namespaces = fs.readdirSync(path.join(root, 'rollups'));
    return namespaces.flatMap(namespace => fs.readdirSync(path.join(root, 'rollups', namespace))
      .map(name => path.join(root, 'rollups', namespace, name)));
  } };
}

test('MessagePack round-trips complete session records without encryption', t => {
  const f = fixture(t);
  const record = { mtime: 123.456, size: 900, textTokenMeasurements: { mapped: { tokens: 12 } },
    recentCmds: [{ c: 'echo 😀\r\n\u0000', textTokens: { billedTokens: null,
      assetsSha256: 'a'.repeat(64), consumerMappingVerified: false, tokens: 4 } }],
    nested: { values: [0, false, null, 1.5] } };
  f.cache.set('../../session/one', record);
  f.cache.save();
  assert.deepEqual(createCache(f.options).load().get('../../session/one'), record);
  assert.deepEqual(decode(fs.readFileSync(f.files()[0])), { id: '../../session/one', record });
  assert.deepEqual(f.warnings, []);
});

test('8101 sessions are saved separately; one changed session writes only one file', t => {
  const f = fixture(t);
  for (let i = 0; i < 8101; i++) f.cache.set(`session-${i}`, { mtime: i, detail: 'x'.repeat(1024) });
  f.cache.save();
  assert.equal(f.files().length, 8101);
  assert.equal(createCache(f.options).load().size, 8101);
  const writes = t.mock.method(fs, 'writeFileSync');
  f.cache.set('session-4000', { mtime: 9000, detail: 'changed' });
  f.cache.save();
  assert.equal(writes.mock.callCount(), 1);
  assert.ok(writes.mock.calls[0].arguments[1] instanceof Uint8Array);
  f.cache.save();
  assert.equal(writes.mock.callCount(), 1);
  f.cache.delete('session-4000');
  f.cache.save();
  assert.equal(createCache(f.options).load().size, 8100);
  assert.deepEqual(f.warnings, []);
});

test('failed atomic replacement preserves previous data and retries without new scans', t => {
  const f = fixture(t);
  f.cache.set('one', { value: 'old' });
  f.cache.save();
  const rename = fs.renameSync;
  let fail = true;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (fail) { fail = false; throw new Error('simulated write failure'); }
    return rename(...args);
  });
  f.cache.set('one', { value: 'new' });
  f.cache.set('two', { value: 'independent' });
  f.cache.save();
  assert.equal(createCache(f.options).load().get('one').value, 'old');
  assert.equal(createCache(f.options).load().get('two').value, 'independent');
  assert.equal(f.files().filter(name => name.endsWith('.tmp')).length, 0);
  assert.equal(f.warnings.length, 1);
  f.cache.save();
  assert.equal(createCache(f.options).load().get('one').value, 'new');
});

test('corrupt and misidentified files are isolated; policy/version changes rescan', t => {
  const f = fixture(t);
  f.cache.set('one', { mtime: 1 });
  f.cache.set('two', { mtime: 2 });
  f.cache.save();
  const [first, second] = f.files();
  fs.writeFileSync(first, Buffer.from([0xc1]));
  assert.equal(createCache(f.options).load().size, 1);
  fs.writeFileSync(first, encode({ id: 'wrong-id', record: {} }));
  assert.equal(createCache(f.options).load().size, 1);
  assert.equal(createCache({ ...f.options, version: 23 }).load().size, 0);
  assert.equal(createCache({ ...f.options, policy: { local: false } }).load().size, 0);
  assert.ok(fs.existsSync(second));
  // The old monolithic cache is left untouched, not parsed into a giant string.
  fs.writeFileSync(path.join(f.root, 'rollups.json'), 'not valid JSON');
  assert.equal(createCache(f.options).load().size, 1);
});
