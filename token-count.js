#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { TextDecoder } = require('util');
const { countText } = require('./lib/text-tokens');
const MAX_BYTES = 8 * 1024 * 1024;

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node token-count.js (--model ID | --encoding NAME) [FILE|-]\n'
      + 'Counts UTF-8 text locally. Maximum 8 MiB; no truncation, inference, API key, or upload.\n'
      + 'Unmapped models return an explicitly labeled estimate and exit 2.');
    return;
  }
  let model, encoding, file;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '--encoding') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--model') model = value; else encoding = value;
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option: ${arg}`);
    else if (file !== undefined) throw new Error('Provide only one file');
    else file = arg;
  }
  if ((!model && !encoding) || (model && encoding)) throw new Error('Provide exactly one of --model or --encoding');
  const stream = !file || file === '-' ? process.stdin : fs.createReadStream(file);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) { stream.destroy(); throw new Error('Input exceeds 8 MiB; nothing was counted'); }
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  const result = countText(text, { model, encoding, fingerprint: true });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'tokenized') process.exitCode = 2;
}
main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
