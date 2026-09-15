'use strict';

// Text payloads only: these counts are not request usage or billing attribution.
// The optional package ships its ranks; no API, credentials, or runtime downloads.
const { createHash } = require('crypto');
const fs = require('fs');
let tokenizer;
function loadTokenizer() {
  if (tokenizer !== undefined) return tokenizer;
  try { tokenizer = require('js-tiktoken'); } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || !e.message.includes("'js-tiktoken'")) throw e;
    tokenizer = null;
  }
  return tokenizer;
}
const encodings = new Map();
function resolveEncoding(model, encoding) {
  const lib = loadTokenizer();
  if (!lib) return { reason: 'tokenizer-not-installed' };
  let name = encoding;
  if (!name) {
    if (!model) return { reason: 'model-not-recorded' };
    try { name = lib.getEncodingNameForModel(model); }
    catch (_) { return { reason: 'model-not-mapped' }; }
  }
  let entry = encodings.get(name);
  if (!entry) {
    let encoder;
    try { encoder = lib.getEncoding(name); }
    catch (_) { return { reason: 'encoding-not-supported' }; }
    entry = { encoder, assetsSha256: createHash('sha256')
      .update(fs.readFileSync(require.resolve(`js-tiktoken/ranks/${name}`))).digest('hex') };
    encodings.set(name, entry);
  }
  return { ...entry, name, mapping: encoding ? 'explicit-encoding' : 'package-model-map' };
}

function countText(text, { model = null, encoding, local = true, fingerprint = false } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const base = { model, bytes: Buffer.byteLength(text, 'utf8'), characters: text.length,
    scope: 'logged-text-only', billedTokens: null };
  if (fingerprint) base.sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const resolved = !local ? { reason: 'local-counting-disabled' }
    : base.bytes > 8 * 1024 * 1024 ? { reason: 'text-exceeds-local-limit' } : resolveEncoding(model, encoding);
  if (!resolved.encoder) return { ...base, status: 'estimated', tokens: Math.ceil(text.length / 4),
    method: 'characters-divided-by-four', reason: resolved.reason, encoding: null };
  // Treat special-token spellings in tool output as ordinary text, not control tokens.
  return { ...base, status: 'tokenized', tokens: resolved.encoder.encode(text, [], []).length,
    method: 'js-tiktoken', version: '1.0.21', encoding: resolved.name, mapping: resolved.mapping,
    assetsSha256: resolved.assetsSha256,
    consumerMappingVerified: false };
}

function addMeasurement(summary, measurement) {
  const key = measurement.status === 'tokenized'
    ? `${measurement.method}@${measurement.version}:${measurement.encoding}:${measurement.mapping}`
    : measurement.reason;
  const row = summary[key] || (summary[key] = { status: measurement.status, calls: 0, tokens: 0, bytes: 0,
    encoding: measurement.encoding, reason: measurement.reason || null });
  row.calls++; row.tokens += measurement.tokens; row.bytes += measurement.bytes;
}

function countingPolicy(local) {
  return { local: !!local, tokenizer: local && loadTokenizer() ? 'js-tiktoken@1.0.21' : null,
    scope: 'logged-text-only', consumerMappingVerified: false };
}
module.exports = { countText, addMeasurement, countingPolicy };
