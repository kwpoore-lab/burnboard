#!/usr/bin/env node
'use strict';

/*
 * burnboard — live + historical monitor for Codex CLI and Claude Code usage
 * Zero dependencies. Node stdlib only.
 *
 *   node server.js [--port 4317] [--root ~/.codex] [--claude-root ~/.claude]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(argVal('--port', process.env.PORT || '4317'), 10);

const TICK_MS = 2000;          // rescan cadence
const LIVE_WINDOW_MS = 15 * 60 * 1000;   // show in live feed if touched within this
const RUNNING_MS = 15 * 1000;  // green dot
const IDLE_MS = 5 * 60 * 1000; // yellow dot

// ---------------------------------------------------------------------------
// sources: Codex CLI (~/.codex/sessions) and Claude Code (~/.claude/projects)
// ---------------------------------------------------------------------------
const createCodexSource = require('./lib/sources/codex');
const createClaudeSource = require('./lib/sources/claude');
const SOURCES = [createCodexSource({ argVal }), createClaudeSource({ argVal })];
const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// per-file incremental parser
// ---------------------------------------------------------------------------
// cache: filePath -> { offset, remainder, mtimeMs, size, summary }
const cache = new Map();

function refreshFile(filePath, source) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { cache.delete(filePath); return null; }
  let ent = cache.get(filePath);
  if (ent && ent.mtimeMs === st.mtimeMs && ent.size === st.size) {
    ent.summary.mtimeMs = st.mtimeMs;
    return ent.summary;
  }
  if (!ent || st.size < ent.offset) {
    ent = { offset: 0, remainder: '', summary: source.emptySummary(filePath) };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const len = st.size - ent.offset;
    if (len > 0) {
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, ent.offset);
      const chunk = ent.remainder + buf.toString('utf8');
      const lines = chunk.split('\n');
      ent.remainder = lines.pop(); // trailing partial
      for (const line of lines) {
        if (line.trim()) source.applyLine(ent.summary, line);
      }
      ent.offset = st.size;
    }
  } finally {
    fs.closeSync(fd);
  }
  ent.mtimeMs = st.mtimeMs;
  ent.size = st.size;
  ent.summary.mtimeMs = st.mtimeMs;
  cache.set(filePath, ent);
  return ent.summary;
}

// ---------------------------------------------------------------------------
// cross-source directory discovery
// ---------------------------------------------------------------------------
function availableDates() {
  const dates = new Set();
  for (const s of SOURCES) for (const d of s.availableDates()) dates.add(d);
  return [...dates].sort().reverse();
}

function filesForDate(date) {
  const out = [];
  for (const s of SOURCES) for (const fp of s.filesForDate(date)) out.push({ fp, source: s });
  return out;
}

function recentFiles(sinceMs) {
  const out = [];
  for (const s of SOURCES) for (const e of s.recentFiles(sinceMs)) out.push({ fp: e.fp, mtimeMs: e.mtimeMs, source: s });
  return out;
}

function allSessionFiles() {
  const out = [];
  for (const s of SOURCES) for (const fp of s.allSessionFiles()) out.push({ fp, source: s });
  return out;
}

function findFile(uuid) {
  for (const s of SOURCES) {
    const fp = s.findFile(uuid);
    if (fp) return { fp, source: s };
  }
  return null;
}

// ---------------------------------------------------------------------------
// snapshot builders
// ---------------------------------------------------------------------------
function buildCommands(sum) {
  // per-command tokens = the request's genuinely NEW tokens (input tokens not
  // served from cache, plus output) — e.total and e.cum both resend the full
  // context on every request, so differencing either just reproduces that
  // request's full (mostly-cached) cost, not what this command actually added;
  // running total = the sum of those per-command deltas within the current
  // prompt/turn, resetting to 0 at the start of each new prompt
  const source = SOURCE_BY_ID.get(sum.source);
  let runSum = 0, curTurn = null;
  const out = [];
  for (const e of sum.commands) {
    const delta = e.newTokens || 0;
    if (e.turn !== curTurn) { curTurn = e.turn; runSum = 0; }
    runSum += delta;
    out.push({ ts: e.ts, name: e.name, cmd: e.cmd, base: source.baseCommand(e),
      total: e.total || 0, cum: e.cum || 0, last: e.last, delta, runSum, turn: e.turn || 0 });
  }
  return out;
}

function commandStats(cmds) {
  const m = new Map();
  for (const c of cmds) {
    const g = m.get(c.base) || { base: c.base, count: 0, tokens: 0, lastReq: 0, lastTs: null };
    g.count++;
    g.tokens += c.delta;
    g.lastReq += c.last || 0;
    if (!g.lastTs || c.ts > g.lastTs) g.lastTs = c.ts;
    m.set(c.base, g);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count);
}

// Resolve a session id to a short label from whatever we know about it.
function sessionLabel(id) {
  const out = { id };
  const rec = rollupCache && rollupCache.sessions.get(id);
  const ent = [...cache.values()].find((e) => e.summary && e.summary.id === id);
  const src = SOURCE_BY_ID.get((rec && rec.source) || (ent && ent.summary.source));
  if (rec && rec.title) out.title = rec.title;
  if (ent && !out.title && ent.summary.threadTitle) out.title = ent.summary.threadTitle;
  if (!out.title && src) { const t = src.titleFor(id); if (t) out.title = t; }
  if (rec) {
    if (!out.title && rec.prompt) out.title = rec.prompt.slice(0, 80);
    out.kind = rec.agentKind || (rec.isSubagent ? 'subagent' : 'main');
    out.project = rec.project;
    out.source = rec.source;
  }
  if (ent) {
    const s = ent.summary;
    if (!out.title) out.title = s.firstUserText && s.firstUserText.slice(0, 80) || null;
    if (!out.kind) out.kind = s.agentKind || (s.isSubagent ? 'subagent' : 'main');
    if (!out.source) out.source = s.source;
  }
  return out;
}

// Walk parent_thread_id up to the root user prompt (root-first).
function lineageOf(parentId) {
  const chain = [];
  const seen = new Set();
  let cur = parentId, guard = 0;
  while (cur && !seen.has(cur) && guard++ < 12) {
    seen.add(cur);
    chain.push(sessionLabel(cur));
    const rec = rollupCache && rollupCache.sessions.get(cur);
    const ent = rec ? null : [...cache.values()].find((e) => e.summary && e.summary.id === cur);
    cur = rec ? rec.parentId : (ent ? ent.summary.parentId : null);
  }
  return chain.reverse();
}

function decorate(sum, full) {
  const age = Date.now() - (sum.mtimeMs || 0);
  const cmds = full ? buildCommands(sum) : null;
  const src = SOURCE_BY_ID.get(sum.source);
  return {
    id: sum.id,
    source: sum.source,
    sourceLabel: src ? src.label : sum.source,
    title: sum.threadTitle || (src && src.titleFor(sum.id)) || null,
    parentId: sum.parentId,
    isSubagent: sum.isSubagent,
    depth: sum.depth,
    agentNickname: sum.agentNickname,
    agentKind: sum.agentKind || null,
    lineage: sum.parentId ? lineageOf(sum.parentId) : [],
    project: sum.project,
    cwd: sum.cwd,
    git: sum.git,
    originator: sum.originator,
    cliVersion: sum.cliVersion,
    startedAt: sum.startedAt,
    lastEventAt: sum.lastEventAt,
    mtime: sum.mtimeMs,
    ageMs: age,
    status: age <= RUNNING_MS ? 'running' : age <= IDLE_MS ? 'idle' : 'stale',
    primaryModel: sum.primaryModel,
    models: sum.models,
    autoReview: sum.autoReview,
    effort: sum.effort,
    personality: sum.personality,
    serviceTier: sum.serviceTier,
    contextWindow: sum.contextWindow,
    tokens: sum.tokens,
    lastReqTokens: sum.lastReqTokens,
    lastReqInput: sum.lastReqInput,
    cumReqTokens: sum.cumReqTokens || 0,
    compactions: sum.compactions || 0,
    rateLimits: sum.rateLimits || null,
    rateLimitsAt: sum.rateLimitsAt || null,
    contextUsed: sum.contextWindow && sum.lastReqInput
      ? Math.min(100, Math.round(100 * sum.lastReqInput / sum.contextWindow)) : null,
    tokenSeries: full ? sum.tokenSeries.slice(-600) : sum.tokenSeries.slice(-60),
    messageCount: sum.messageCount,
    userMessageCount: sum.userMessageCount,
    toolCallCount: sum.toolCallCount,
    turnsStarted: sum.turnsStarted,
    turnsCompleted: sum.turnsCompleted,
    currentTurn: sum.curTurn || sum.turnsStarted,
    taskActive: sum.taskActive,
    firstUserText: sum.firstUserText,
    lastUserText: sum.lastUserText,
    lastAssistantText: sum.lastAssistantText,
    lastExec: sum.lastExec,
    commands: cmds ? cmds.slice(-150) : undefined,
    commandStats: cmds ? commandStats(cmds) : undefined,
  };
}

function liveSnapshot() {
  const rows = recentFiles(LIVE_WINDOW_MS)
    .map(({ fp, source }) => refreshFile(fp, source))
    .filter(Boolean)
    .map((s) => decorate(s, true))
    .sort((a, b) => b.mtime - a.mtime);

  // freshest rate-limit / quota reading across live threads
  let rateLimits = null, rlAt = '';
  for (const r of rows) {
    if (r.rateLimits && (r.rateLimitsAt || '') > rlAt) { rateLimits = r.rateLimits; rlAt = r.rateLimitsAt; }
  }

  // token totals for today / this week, from the rollup cache when it's ready
  if (Date.now() - (liveSnapshot._lastRollupPoke || 0) > 20000) {
    liveSnapshot._lastRollupPoke = Date.now();
    ensureRollups();
  }
  const usage = { haveRollups: rollupReady, today: 0, week: 0 };
  if (rollupReady) {
    const nowIso = new Date().toISOString();
    const dayKey = bucketKey('day', nowIso);
    const weekKey = bucketKey('week', nowIso);
    for (const rec of rollupCache.sessions.values()) {
      if (!rec.startedAt) continue;
      const billed = rec.totals.billed || rec.totals.total || 0;
      if (bucketKey('day', rec.startedAt) === dayKey) usage.today += billed;
      if (bucketKey('week', rec.startedAt) === weekKey) usage.week += billed;
    }
  }

  // Claude Code keeps its own quota outside the transcripts — read it straight
  // from the source so the header can show both agents' headroom
  const claudeQuota = SOURCE_BY_ID.get('claude');
  const claudeLimits = claudeQuota && claudeQuota.quota ? claudeQuota.quota() : null;

  return { now: Date.now(), threads: rows, rateLimits, rateLimitsAt: rlAt || null, claudeLimits, usage };
}

function historySnapshot(date) {
  const rows = filesForDate(date)
    .map(({ fp, source }) => refreshFile(fp, source))
    .filter(Boolean)
    .map((s) => decorate(s, false))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  return { date, threads: rows };
}

// full timeline for one session
function timeline(uuid) {
  const found = findFile(uuid);
  if (!found) return null;
  const { fp, source } = found;

  const sum = source.emptySummary(fp);
  const events = [];
  const raw = fs.readFileSync(fp, 'utf8').split('\n');
  for (const line of raw) {
    if (!line.trim()) continue;
    source.applyLine(sum, line);
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    const ev = source.eventFromParsed(o);
    if (ev) events.push(ev);
  }
  sum.mtimeMs = fs.statSync(fp).mtimeMs;
  return { summary: decorate(sum, true), events };
}

// ---------------------------------------------------------------------------
// trends — per-session rollups aggregated over day / week / month
// ---------------------------------------------------------------------------
const CACHE_FILE = path.join(__dirname, '.cache', 'rollups.json');
let rollupCache = null;           // { sessions: Map<id, rec> }
let building = false;
let rollupReady = false;
let buildProgress = { done: 0, total: 0 };

const ROLLUP_VERSION = 17;   // bump to force a full re-scan when the parser changes
function loadRollupCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j.version !== ROLLUP_VERSION) throw new Error('stale');
    rollupCache = { sessions: new Map(Object.entries(j.sessions || {})) };
  } catch (_) {
    rollupCache = { sessions: new Map() };
  }
}
function saveRollupCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      version: ROLLUP_VERSION, sessions: Object.fromEntries(rollupCache.sessions),
    }));
  } catch (e) { console.warn('rollup cache save failed:', e.message); }
}

async function refreshRollups() {
  if (!rollupCache) loadRollupCache();
  if (building) return;
  building = true;
  try {
    const files = allSessionFiles();
    buildProgress = { done: 0, total: files.length };
    const live = new Set();
    let changed = 0;
    for (const { fp, source } of files) {
      let st; try { st = fs.statSync(fp); } catch (_) { buildProgress.done++; continue; }
      const id = source.fileId(fp);
      live.add(id);
      const ex = rollupCache.sessions.get(id);
      if (!ex || ex.mtime !== st.mtimeMs || ex.size !== st.size) {
        rollupCache.sessions.set(id, await source.scanSession(fp, st));
        if (++changed % 100 === 0) console.log(`  rollups: scanned ${changed}/${files.length}…`);
      }
      buildProgress.done++;
    }
    for (const id of [...rollupCache.sessions.keys()]) if (!live.has(id)) rollupCache.sessions.delete(id);
    if (changed) { saveRollupCache(); console.log(`  rollups: ${changed} sessions (re)scanned, ${rollupCache.sessions.size} total`); }
    rollupReady = true;
  } finally {
    building = false;
  }
}

function ensureRollups() {
  if (!rollupCache) {
    loadRollupCache();
    if (rollupCache.sessions.size) rollupReady = true;   // serve stale immediately
  }
  if (!building) refreshRollups();                        // (re)scan in background
}

function bucketKey(period, iso) {
  const d = new Date(iso);
  if (isNaN(d)) return 'unknown';
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  if (period === 'month') return ymd.slice(0, 7);
  if (period === 'week') {
    const t = new Date(d);
    t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));      // back to Monday
    return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
  }
  if (period === 'hour') {   // the finest filter = even 15-minute slots
    const q = Math.floor(d.getMinutes() / 15) * 15;
    return `${ymd}T${p2(d.getHours())}:${p2(q)}`;
  }
  return ymd;
}

// distinct model / effort values for the filter dropdowns
function rollupFacets() {
  const models = new Set(), efforts = new Set();
  for (const r of rollupCache.sessions.values()) {
    if (r.model) models.add(r.model);
    if (r.autoReview) models.add('codex-auto-review');
    if (r.effort) efforts.add(r.effort);
  }
  const order = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4 };
  return {
    models: [...models].sort(),
    efforts: [...efforts].sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9)),
    sources: SOURCES.map((s) => ({ id: s.id, label: s.label })),
  };
}

// filter helper shared by trends / economy / commandTrend
function pickSessions(includeSub, model, effort, source) {
  return [...rollupCache.sessions.values()].filter((r) =>
    r.startedAt
    && (includeSub || !r.isSubagent)
    && (!model || r.model === model || (model === 'codex-auto-review' && r.autoReview))
    && (!effort || r.effort === effort)
    && (!source || r.source === source));
}

// the "hour" (15-minute) view only covers the last 24 hours
function windowSessions(recs, period) {
  if (period !== 'hour') return recs;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return recs.filter((r) => new Date(r.startedAt).getTime() >= cutoff);
}

// every 15-minute slot for the last 24h, so the hour chart shows the full span
function hourWindowBuckets() {
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(Math.floor(now.getMinutes() / 15) * 15);
  const out = [];
  for (let t = now.getTime() - 24 * 3600 * 1000; t <= now.getTime(); t += 15 * 60 * 1000) {
    const d = new Date(t);
    out.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`);
  }
  return out;
}
const seedBuckets = (period) => new Set(period === 'hour' ? hourWindowBuckets() : []);

function trends(period, includeSub, model, effort, source) {
  const recs = windowSessions(pickSessions(includeSub, model, effort, source), period);
  const buckets = seedBuckets(period);
  const totals = {};
  const cmdMap = new Map();
  const promptMap = new Map();
  for (const r of recs) {
    const billed = r.totals.billed || r.totals.total;
    const b = bucketKey(period, r.startedAt);
    buckets.add(b);
    const T = totals[b] || (totals[b] = { tokens: 0, sessions: 0, commands: 0, input: 0, output: 0, cached: 0, reasoning: 0 });
    T.tokens += billed; T.sessions++;
    T.input += r.totals.input; T.output += r.totals.output;
    T.cached += r.totals.cached; T.reasoning += r.totals.reasoning;
    for (const c of r.cmds) {
      T.commands += c.count;
      const g = cmdMap.get(c.base) || (cmdMap.set(c.base, { base: c.base, total: 0, count: 0, per: {} }).get(c.base));
      g.total += c.tokens; g.count += c.count;
      const pc = g.per[b] || (g.per[b] = { tokens: 0, count: 0 });
      pc.tokens += c.tokens; pc.count += c.count;
    }
    if (r.prompt) {
      const key = r.prompt.toLowerCase().slice(0, 120);
      const g = promptMap.get(key) || (promptMap.set(key, { prompt: r.prompt, project: r.project, total: 0, count: 0, per: {} }).get(key));
      g.total += billed; g.count += 1;
      if (!g.project && r.project) g.project = r.project;
      const pc = g.per[b] || (g.per[b] = { tokens: 0, count: 0 });
      pc.tokens += billed; pc.count += 1;
    }
  }
  const grand = Object.values(totals).reduce((a, t) => {
    for (const k of Object.keys(t)) a[k] = (a[k] || 0) + t[k];
    return a;
  }, {});
  return {
    period,
    building: !rollupReady,
    progress: buildProgress,
    buckets: [...buckets].sort(),
    totals,
    grand,
    byCommand: [...cmdMap.values()].sort((a, b) => b.total - a.total),
    byPrompt: [...promptMap.values()].sort((a, b) => b.total - a.total).slice(0, 400),
    sessions: recs.length,
    facets: rollupFacets(),
  };
}

// "Where are the tokens going, and what looks wasteful?"
function economy(sinceMs, includeSub, model, effort, source) {
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const recs = pickSessions(includeSub, model, effort, source).filter((r) =>
    !cutoff || new Date(r.startedAt).getTime() >= cutoff);

  const tot = { sessions: recs.length, outTokens: 0, toolCalls: 0, pollTurns: 0,
    truncatedCalls: 0, dupeRuns: 0, dupeTokens: 0, modelOutput: 0, modelReasoning: 0 };
  const byBase = new Map();
  const bigOutputs = [];
  const dupes = [];
  const pollSessions = [];

  for (const r of recs) {
    tot.outTokens += r.outTokens || 0;
    tot.toolCalls += r.toolCalls || 0;
    tot.pollTurns += r.pollTurns || 0;
    tot.modelOutput += r.totals.output || 0;
    tot.modelReasoning += r.totals.reasoning || 0;
    for (const [base, g] of Object.entries(r.outByBase || {})) {
      const e = byBase.get(base) || (byBase.set(base,
        { base, tokens: 0, calls: 0, truncated: 0, _samples: new Map(), _polls: new Map() }).get(base));
      e.tokens += g.tokens; e.calls += g.calls; e.truncated += g.truncated;
      tot.truncatedCalls += g.truncated;
      for (const s of (r.samples && r.samples[base]) || []) {
        const m = e._samples.get(s.cmd) || { cmd: s.cmd, count: 0, out: 0, trunc: 0 };
        m.count += s.count; m.out += s.out; m.trunc += s.trunc;
        e._samples.set(s.cmd, m);
      }
      if (base === 'write_stdin' || base === 'wait' || base === 'wait_agent' || base === 'exec_command') {
        for (const pt of r.pollTargets || []) {
          const m = e._polls.get(pt.cmd) || { count: 0, out: 0 };
          m.count += pt.count; m.out += pt.out || 0;
          e._polls.set(pt.cmd, m);
        }
      }
    }
    for (const b of r.bigOutputs || []) {
      bigOutputs.push({ ...b, sessionId: r.id, prompt: r.prompt, project: r.project });
    }
    for (const d of r.dupes || []) {
      dupes.push({ ...d, sessionId: r.id, prompt: r.prompt, project: r.project });
      tot.dupeRuns += d.count - 1;
      tot.dupeTokens += Math.round(d.tokens * (d.count - 1) / d.count);
    }
    if ((r.toolCalls || 0) >= 15) {
      pollSessions.push({
        sessionId: r.id, prompt: r.prompt, project: r.project,
        pollTurns: r.pollTurns || 0, toolCalls: r.toolCalls,
        pct: Math.round(100 * (r.pollTurns || 0) / r.toolCalls),
      });
    }
  }
  const byCommand = [...byBase.values()].sort((a, b) => b.tokens - a.tokens).map((e) => ({
    base: e.base, tokens: e.tokens, calls: e.calls, truncated: e.truncated,
    samples: [...e._samples.values()].sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 12),
    pollTargets: [...e._polls.entries()].map(([cmd, v]) => ({ cmd, count: v.count, out: v.out }))
      .sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 10),
  }));

  return {
    building: !rollupReady, progress: buildProgress,
    totals: tot,
    byCommand,
    bigOutputs: bigOutputs.sort((a, b) => b.tokens - a.tokens).slice(0, 40),
    dupes: dupes.sort((a, b) => b.tokens - a.tokens).slice(0, 40),
    pollSessions: pollSessions.filter((s) => s.pollTurns > 0).sort((a, b) => b.pct - a.pct).slice(0, 25),
    facets: rollupFacets(),
  };
}

// Time-series for one base command: output tokens / calls / truncated / Δ tokens
// per day|week|month bucket, plus per-invocation and per-polled-process series.
function commandTrend(base, period, includeSub, model, effort, source) {
  const recs = windowSessions(pickSessions(includeSub, model, effort, source), period);
  const buckets = seedBuckets(period);
  const series = { outTokens: {}, calls: {}, truncated: {}, delta: {} };
  const bump = (k, b, v) => { series[k][b] = (series[k][b] || 0) + v; };
  const sampMap = new Map();
  const pollMap = new Map();
  const isPoll = ['write_stdin', 'wait', 'wait_agent', 'exec_command'].includes(base);
  let totals = { outTokens: 0, calls: 0, truncated: 0, delta: 0, sessions: 0 };

  for (const r of recs) {
    const g = (r.outByBase || {})[base];
    const dc = (r.cmds || []).find((c) => c.base === base);
    if (!g && !dc) continue;
    const b = bucketKey(period, r.startedAt);
    buckets.add(b);
    totals.sessions++;
    if (g) {
      bump('outTokens', b, g.tokens); bump('calls', b, g.calls); bump('truncated', b, g.truncated);
      totals.outTokens += g.tokens; totals.calls += g.calls; totals.truncated += g.truncated;
    }
    if (dc) { bump('delta', b, dc.tokens); totals.delta += dc.tokens; }

    for (const s of (r.samples && r.samples[base]) || []) {
      const e = sampMap.get(s.cmd) || (sampMap.set(s.cmd, { cmd: s.cmd, count: 0, out: 0, trunc: 0, per: {} }).get(s.cmd));
      e.count += s.count; e.out += s.out; e.trunc += s.trunc;
      const pb = e.per[b] || (e.per[b] = { outTokens: 0, calls: 0, truncated: 0 });
      pb.outTokens += s.out; pb.calls += s.count; pb.truncated += s.trunc;
    }
    if (isPoll) {
      for (const pt of r.pollTargets || []) {
        const e = pollMap.get(pt.cmd) || (pollMap.set(pt.cmd, { cmd: pt.cmd, count: 0, out: 0, per: {} }).get(pt.cmd));
        e.count += pt.count; e.out += pt.out || 0;
        const pb = e.per[b] || (e.per[b] = { outTokens: 0, calls: 0 });
        pb.outTokens += pt.out || 0; pb.calls += pt.count;
      }
    }
  }
  return {
    base, period,
    buckets: [...buckets].sort(),
    series, totals,
    samples: [...sampMap.values()].sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 15),
    pollTargets: [...pollMap.values()].sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 12),
    facets: rollupFacets(),
  };
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------
const sseClients = new Set();
function broadcast() {
  if (!sseClients.size) return;
  let payload;
  try { payload = JSON.stringify(liveSnapshot()); } catch (e) { return; }
  const frame = `data: ${payload}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) {}
  }
}
setInterval(broadcast, TICK_MS);

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
const INDEX_PATH = path.join(__dirname, 'index.html');
const readIndex = () => {
  try { return fs.readFileSync(INDEX_PATH, 'utf8'); } catch (_) { return '<!doctype html><title>burnboard</title>index.html missing'; }
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathn = url.pathname;

  if (pathn === '/' || pathn === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readIndex());
    return;
  }

  if (pathn === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(liveSnapshot())}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  if (pathn === '/api/dates') {
    return json(res, 200, { dates: availableDates() });
  }

  if (pathn === '/api/sessions') {
    const date = url.searchParams.get('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'bad date' });
    return json(res, 200, historySnapshot(date));
  }

  if (pathn.startsWith('/api/session/')) {
    const uuid = decodeURIComponent(pathn.slice('/api/session/'.length));
    const t = timeline(uuid);
    if (!t) return json(res, 404, { error: 'not found' });
    return json(res, 200, t);
  }

  if (pathn === '/api/trends') {
    ensureRollups();
    const q = url.searchParams;
    const period = ['hour', 'day', 'week', 'month'].includes(q.get('period')) ? q.get('period') : 'day';
    const includeSub = q.get('subagents') === '1';
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, trends(period, includeSub, q.get('model') || '', q.get('effort') || '', q.get('source') || ''));
  }

  if (pathn === '/api/history') {
    ensureRollups();
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    const rows = [...rollupCache.sessions.values()]
      .filter((r) => r.startedAt)
      .map((r) => ({
        id: r.id,
        source: r.source,
        startedAt: r.startedAt,
        title: r.title || ((SOURCE_BY_ID.get(r.source) || {}).titleFor ? SOURCE_BY_ID.get(r.source).titleFor(r.id) : null),
        prompt: r.prompt,
        project: r.project,
        repo: r.repo, branch: r.branch,
        model: r.model, effort: r.effort, autoReview: r.autoReview,
        isSubagent: r.isSubagent, agentNickname: r.agentNickname, depth: r.depth,
        agentKind: r.agentKind, parentId: r.parentId,
        parent: r.parentId ? sessionLabel(r.parentId) : null,
        tokens: r.totals.billed || r.totals.total,
        rawTokens: r.totals.total,
        compactions: r.compactions,
        toolCalls: r.toolCalls,
      }))
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return json(res, 200, { sessions: rows, facets: rollupFacets() });
  }

  if (pathn === '/api/economy') {
    ensureRollups();
    const q = url.searchParams;
    const sinceMs = q.get('range') === '7d' ? 7 * 864e5 : q.get('range') === '30d' ? 30 * 864e5 : 0;
    const includeSub = q.get('subagents') !== '0';   // default: include
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, economy(sinceMs, includeSub, q.get('model') || '', q.get('effort') || '', q.get('source') || ''));
  }

  if (pathn === '/api/command') {
    ensureRollups();
    const q = url.searchParams;
    const base = q.get('base');
    const period = ['hour', 'day', 'week', 'month'].includes(q.get('period')) ? q.get('period') : 'week';
    const includeSub = q.get('subagents') !== '0';
    if (!base) return json(res, 400, { error: 'base required' });
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, commandTrend(base, period, includeSub, q.get('model') || '', q.get('effort') || '', q.get('source') || ''));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — burnboard may already be running.`);
    console.error(`open http://localhost:${PORT}, or start on another port:  node server.js --port 4318`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`burnboard`);
  for (const s of SOURCES) {
    console.log(`  ${s.label} → ${s.root}  [${s.rootWhy}]`);
    if (!s.looksLikeHome()) console.warn(`    warning: no data dir found here for ${s.label}`);
    console.log(`    watching ${s.watching}`);
  }
  console.log(`  http://localhost:${PORT}`);
});
