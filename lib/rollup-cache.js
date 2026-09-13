'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { encode, decode } = require('@msgpack/msgpack');

// Each session is independent: no whole-history string, index, or rewrite.
// Version/policy namespaces invalidate derived data without touching other runs.
module.exports = function createRollupCache({ root, version, policy, warn = console.warn }) {
  const namespace = createHash('sha256').update(JSON.stringify({ version, policy })).digest('hex');
  const dir = path.join(root, 'rollups', namespace);
  const pending = new Map();
  const filename = id => `${createHash('sha256').update(id).digest('hex')}.msgpack`;

  function load() {
    const sessions = new Map();
    let files;
    try { files = fs.readdirSync(dir); }
    catch (e) {
      if (e.code !== 'ENOENT') warn('rollup cache load failed:', e.message);
      return sessions;
    }
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.msgpack$/.test(name)) continue;
      try {
        const entry = decode(fs.readFileSync(path.join(dir, name)));
        if (!entry || typeof entry.id !== 'string' || filename(entry.id) !== name
          || !entry.record || typeof entry.record !== 'object' || Array.isArray(entry.record)) {
          throw new Error('invalid session cache entry');
        }
        sessions.set(entry.id, entry.record);
      } catch (e) { warn(`rollup cache load failed (${name}):`, e.message); }
    }
    return sessions;
  }

  function save() {
    if (!pending.size) return;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    catch (e) { warn('rollup cache save failed:', e.message); return; }
    for (const [id, record] of pending) {
      const destination = path.join(dir, filename(id));
      let temporary;
      try {
        if (record === null) fs.rmSync(destination, { force: true });
        else {
          const bytes = encode({ id, record }, { ignoreUndefined: true });
          temporary = `${destination}.${randomUUID()}.tmp`;
          fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, destination);
        }
        pending.delete(id);
      } catch (e) {
        warn(`rollup cache save failed (${filename(id)}):`, e.message);
      } finally {
        if (temporary) {
          try { fs.rmSync(temporary, { force: true }); }
          catch (e) { warn('rollup cache temporary cleanup failed:', e.message); }
        }
      }
    }
  }

  return { load, save, set: (id, record) => pending.set(id, record),
    delete: id => pending.set(id, null) };
};
