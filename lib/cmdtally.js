// ---------------------------------------------------------------------------
// per-base-command tally
//
// sum.commands is a ring buffer capped at the last 300 calls, so any rollup
// derived from it silently covers only the tail of a long session. The
// "Consumption by base command" table is meant to describe the whole session,
// so it is tallied here as commands arrive — before anything can be evicted.
// ---------------------------------------------------------------------------
function tallyCommand(sum, base, entry) {
  if (!sum.cmdTally) sum.cmdTally = new Map();
  const g = sum.cmdTally.get(base)
    || { base, count: 0, tokens: 0, lastReq: 0, lastTs: null, cls: { i: 0, cc: 0, o: 0 } };
  g.count++;
  g.tokens += entry.newTokens || 0;
  // classes kept apart so the Cost view prices each at its own rate; cache read
  // is deliberately absent — no single command owns the context resent for all
  const c = entry.cls || {};
  g.cls.i += c.i || 0; g.cls.cc += c.cc || 0; g.cls.o += c.o || 0;
  g.lastReq += entry.last || 0;
  if (!g.lastTs || entry.ts > g.lastTs) g.lastTs = entry.ts;
  sum.cmdTally.set(base, g);
}

function tallyStats(sum) {
  if (!sum.cmdTally) return [];
  return [...sum.cmdTally.values()]
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count);
}

module.exports = { tallyCommand, tallyStats };
