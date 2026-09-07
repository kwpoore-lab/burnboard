// ---------------------------------------------------------------------------
// rate table — USD per million tokens, by billing class
//
// A session's token count is not its cost: the four classes bill at very
// different rates, and cache read — usually 90%+ of the raw count — is the
// cheapest of them. These rates turn the counts into money.
//
// `write` is what it costs to PUT a prefix in cache, which is dearer than
// sending those tokens uncached (Anthropic charges 1.25x input at the default
// 5-minute TTL, 2x at 1h — we assume the default). OpenAI has no write premium:
// caching is a discount on reads only, so write === input there.
//
// Rates checked 2026-09-07 against anthropic.com/pricing and
// developers.openai.com/api/docs/pricing. They change; keep this table honest
// or the Cost view lies quietly.
// ---------------------------------------------------------------------------
const RATES = [
  // --- Anthropic: read = 0.1x input (0.025x on Fable 5.1), write = 1.25x input
  { id: 'claude-fable-5-1',  in: 10, out: 50, read: 0.25, write: 12.5 },
  { id: 'claude-fable-5',    in: 10, out: 50, read: 1,    write: 12.5 },
  { id: 'claude-opus-5',     in: 5,  out: 25, read: 0.5,  write: 6.25 },
  { id: 'claude-opus-4-8',   in: 5,  out: 25, read: 0.5,  write: 6.25 },
  { id: 'claude-opus-4-7',   in: 5,  out: 25, read: 0.5,  write: 6.25 },
  { id: 'claude-opus-4-6',   in: 5,  out: 25, read: 0.5,  write: 6.25 },
  { id: 'claude-sonnet-5',   in: 2,  out: 10, read: 0.2,  write: 2.5 },
  { id: 'claude-sonnet-4-6', in: 3,  out: 15, read: 0.3,  write: 3.75 },
  { id: 'claude-haiku-4-5',  in: 1,  out: 5,  read: 0.1,  write: 1.25 },
  // --- OpenAI: cached input is a flat discounted rate, no write premium
  { id: 'gpt-5.6-astra', in: 10,   out: 50,  read: 1,     write: 10 },
  { id: 'gpt-5.6-sol',   in: 4,    out: 20,  read: 0.4,   write: 4 },
  { id: 'gpt-5.6-terra', in: 2,    out: 12,  read: 0.2,   write: 2 },
  { id: 'gpt-5.6-luna',  in: 0.2,  out: 1.2, read: 0.02,  write: 0.2 },
  { id: 'gpt-5.5',       in: 5,    out: 30,  read: 0.5,   write: 5 },
  { id: 'gpt-5.4',       in: 2.5,  out: 15,  read: 0.25,  write: 2.5 },
  { id: 'gpt-5.4-mini',  in: 0.75, out: 4.5, read: 0.075, write: 0.75 },
  { id: 'gpt-5.4-nano',  in: 0.2,  out: 1.25, read: 0.02, write: 0.2 },
  { id: 'gpt-5.2',       in: 1.75, out: 14,  read: 0.175, write: 1.75 },
  { id: 'gpt-5.1',       in: 1.25, out: 10,  read: 0.125, write: 1.25 },
  { id: 'gpt-5',         in: 1.25, out: 10,  read: 0.125, write: 1.25 },
  { id: 'gpt-5-mini',    in: 0.25, out: 2,   read: 0.025, write: 0.25 },
  { id: 'gpt-5-nano',    in: 0.05, out: 0.4, read: 0.005, write: 0.05 },
];
// longest id first, so claude-opus-4-8 wins over a hypothetical claude-opus-4
const BY_LEN = RATES.slice().sort((a, b) => b.id.length - a.id.length);

// Model strings carry date suffixes (claude-haiku-4-5-20251001) and occasional
// placeholders (<synthetic>), so match on prefix rather than equality. An
// unknown model returns null — the UI says "no rates" rather than inventing a
// number, which is the whole point of keeping this table explicit.
function rateFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  return BY_LEN.find((r) => m.startsWith(r.id)) || null;
}

// cls: {i, cc, cr, o} raw token counts -> dollars, per class and total
function costOf(cls, rate) {
  if (!rate || !cls) return null;
  const per = {
    i: (cls.i || 0) / 1e6 * rate.in,
    cc: (cls.cc || 0) / 1e6 * rate.write,
    cr: (cls.cr || 0) / 1e6 * rate.read,
    o: (cls.o || 0) / 1e6 * rate.out,
  };
  return { ...per, total: per.i + per.cc + per.cr + per.o };
}

module.exports = { RATES, rateFor, costOf };
