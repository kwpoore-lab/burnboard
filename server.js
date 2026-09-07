#!/usr/bin/env node
'use strict';

/*
 * burnboard — live + historical monitor for Codex CLI and Claude Code usage
 * Zero dependencies. Node stdlib only.
 *
 *   node server.js [--port 4317] [--root ~/.codex] [--claude-root ~/.claude] [--no-ai]
 *
 *   --no-ai   never call an assistant. No CLI is probed for, none is offered,
 *             and /api/deepen refuses. Everything else is unaffected: findings
 *             are measured from your own history and need no model.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(argVal('--port', process.env.PORT || '4317'), 10);
// Opting out of the model layer entirely. Off means off: no probing for an
// assistant CLI, nothing offered in the UI, and the endpoint refuses — so
// burnboard cannot spend a token on your behalf even by accident.
const AI_DISABLED = args.includes('--no-ai') || process.env.BURNBOARD_NO_AI === '1';

const TICK_MS = 2000;          // rescan cadence
const LIVE_WINDOW_MS = 15 * 60 * 1000;   // show in live feed if touched within this
// The "hour" view is for watching work in progress, and agent runs are minutes
// long, not hours — so it covers the last hour in 5-minute slots.
const HOUR_WINDOW_MS = 1 * 3600 * 1000;
const HOUR_SLOT_MIN = 5;
const RUNNING_MS = 15 * 1000;  // green dot
const IDLE_MS = 5 * 60 * 1000; // yellow dot

// ---------------------------------------------------------------------------
// sources: Codex CLI (~/.codex/sessions) and Claude Code (~/.claude/projects)
// ---------------------------------------------------------------------------
const createCodexSource = require('./lib/sources/codex');
const createClaudeSource = require('./lib/sources/claude');
const { tallyStats } = require('./lib/cmdtally');
const { rateFor, costOf } = require('./lib/pricing');
const SOURCES = [createCodexSource({ argVal }), createClaudeSource({ argVal })];
// How far back per-command timestamps go. A source reporting null keeps them for
// the whole transcript, so sub-day drilling is exact over all history; one that
// reports a window makes older sub-day ranges fall back to bucketing each session
// at its start, the way day/week/month do.
const CMD_DETAIL_MS = SOURCES.some((s) => s.recentCmdMs == null)
  ? Infinity : Math.min(...SOURCES.map((s) => s.recentCmdMs));
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

// per-turn cost, for sessions that run no commands at all: cum is the running
// sum of billed tokens, so consecutive turns difference cleanly
function buildTurns(sum) {
  const out = [];
  let prev = 0;
  for (const t of sum.turns || []) {
    out.push({ ts: t.ts, endTs: t.endTs, n: t.n, text: t.text, cum: t.cum, delta: Math.max(0, t.cum - prev) });
    prev = t.cum;
  }
  return out;
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
  const rate = rateFor(sum.primaryModel);
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
    repoKey: repoKeyFrom(sum.git && sum.git.repo, sum.cwd, sum.project),
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
    turns: cmds && !cmds.length ? buildTurns(sum).slice(-150) : undefined,
    // whole-session, not just the 300 commands the ring buffer still holds
    commandStats: cmds ? tallyStats(sum).map((g) => ({ ...g, cost: costOf(g.cls, rate) })) : undefined,
    // token counts split by billing class, and what they cost at this model's
    // rates — null rate means the model isn't in the table, and the UI says so
    tokenClasses: sum.tokClasses,
    rate,
    cost: costOf(sum.tokClasses, rate),
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

const ROLLUP_VERSION = 21;   // bump to force a full re-scan when the parser changes
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
    if (changed) {
      forgetRepoKeys();
      saveRollupCache();
      console.log(`  rollups: ${changed} sessions (re)scanned, ${rollupCache.sessions.size} total`);
    }
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
  if (period === 'hourly') return `${ymd}T${p2(d.getHours())}`;
  if (period === 'hour' || period === 'slot') {   // the finest filter = even 5-minute slots
    const q = Math.floor(d.getMinutes() / HOUR_SLOT_MIN) * HOUR_SLOT_MIN;
    return `${ymd}T${p2(d.getHours())}:${p2(q)}`;
  }
  return ymd;
}

// Periods finer than a day place each *command* in the slot it ran in; the
// coarser ones bucket a session's whole total at its start time.
const CMD_TIME_PERIODS = new Set(['hour', 'hourly', 'slot']);
const PERIODS = ['month', 'week', 'day', 'hourly', 'slot', 'hour'];

// A sub-day range can only be bucketed by command time while the sources still
// hold per-command timestamps for it. Infinity means they always do.
const hasCmdTimes = (from) => from == null || CMD_DETAIL_MS === Infinity
  || from >= Date.now() - CMD_DETAIL_MS;

// ?from=&to= (epoch ms) scope a chart drill-down to one clicked bucket
function drillRange(q) {
  const from = Number(q.get('from')), to = Number(q.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [null, null];
  return [from, to];
}

// Every bucket between two instants, so a drilled-into range shows its empty
// slots instead of silently closing the gaps.
function seedRange(period, from, to) {
  if (from == null || !isFinite(to)) return [];
  const d = new Date(from);
  if (period === 'month') { d.setDate(1); d.setHours(0, 0, 0, 0); }
  else if (period === 'week' || period === 'day') d.setHours(0, 0, 0, 0);
  else if (period === 'hourly') d.setMinutes(0, 0, 0);
  else { d.setSeconds(0, 0); d.setMinutes(Math.floor(d.getMinutes() / HOUR_SLOT_MIN) * HOUR_SLOT_MIN); }
  const out = [];
  for (let guard = 0; d.getTime() < to && guard < 4000; guard++) {
    out.push(bucketKey(period, d));
    if (period === 'month') d.setMonth(d.getMonth() + 1);
    else if (period === 'week') d.setDate(d.getDate() + 7);
    else if (period === 'day') d.setDate(d.getDate() + 1);
    else if (period === 'hourly') d.setHours(d.getHours() + 1);
    else d.setMinutes(d.getMinutes() + HOUR_SLOT_MIN);
  }
  return out;
}

// distinct model / effort values for the filter dropdowns
function rollupFacets() {
  const models = new Set(), efforts = new Set(), repos = new Set();
  for (const r of rollupCache.sessions.values()) {
    if (r.model) models.add(r.model);
    if (r.autoReview) models.add('codex-auto-review');
    if (r.effort) efforts.add(r.effort);
    const rk = repoKeyOf(r);
    if (rk) repos.add(rk);
  }
  const order = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4 };
  return {
    models: [...models].sort(),
    efforts: [...efforts].sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9)),
    repos: [...repos].sort(),
    sources: SOURCES.map((s) => ({ id: s.id, label: s.label })),
  };
}

// ---------------------------------------------------------------------------
// Which repo a session belongs to
// ---------------------------------------------------------------------------
// Sessions run inside a git worktree report the worktree directory, so a naive
// filter lists every branch folder as its own repo. Fold those back into the
// checkout they belong to: <repo>/.codex/worktrees/<branch> -> <repo>.
const WORKTREE_DIR = /^(.*?)\/(?:\.[^/]+\/)?worktrees\/[^/]+\/?$/;
const topLevelDir = (cwd) => {
  const m = WORKTREE_DIR.exec(cwd || '');
  return m ? m[1] : (cwd || '');
};

// A checkout's directory name is not the repo name ("sonde" vs "sondeinc/sonde"),
// but sessions that *did* report a remote from the same directory tell us what it
// is called. Learn that mapping from the rollups rather than guessing.
let repoAlias = null;
function repoAliases() {
  if (repoAlias) return repoAlias;
  // the live snapshot can ask before the rollups have loaded — answer with what we
  // have and leave the real map to be built (and cached) once they are there
  if (!rollupCache) return new Map();
  repoAlias = new Map();
  for (const r of rollupCache.sessions.values()) if (r.repo && r.project) repoAlias.set(r.project, r.repo);
  return repoAlias;
}

function repoKeyFrom(repo, cwd, project) {
  if (repo) return repo;
  const dir = topLevelDir(cwd);
  const name = dir ? path.basename(dir) : (project || '');
  return repoAliases().get(name) || name || null;
}

// The rollup record keeps only the directory's basename, which is not enough to
// spot a worktree. The full cwd is in the session file's opening metadata, so
// read just the head of it — and only for the few sessions that reported no
// remote of their own.
function sessionCwd(rec) {
  try {
    const fd = fs.openSync(rec.file, 'r');
    const buf = Buffer.alloc(65536);
    const len = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, len).toString('utf8').split('\n').slice(0, 8)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      const cwd = (o.payload && o.payload.cwd) || o.cwd;
      if (cwd) return cwd;
    }
  } catch (_) {}
  return null;
}

const repoKeyMemo = new Map();
function repoKeyOf(r) {
  if (r.repo) return r.repo;
  if (!repoKeyMemo.has(r.id)) repoKeyMemo.set(r.id, repoKeyFrom(null, sessionCwd(r), r.project));
  return repoKeyMemo.get(r.id);
}
const forgetRepoKeys = () => { repoKeyMemo.clear(); repoAlias = null; };

// filter helper shared by trends / economy / commandTrend
function pickSessions(includeSub, model, effort, source, repo) {
  return [...rollupCache.sessions.values()].filter((r) =>
    r.startedAt
    && (includeSub || !r.isSubagent)
    && (!model || r.model === model || (model === 'codex-auto-review' && r.autoReview))
    && (!effort || r.effort === effort)
    && (!source || r.source === source)
    && (!repo || repoKeyOf(r) === repo));
}

// The "hour" (5-minute) view covers the last hour. A session that started
// earlier but is still working belongs in it, so membership is decided by
// whether it ran any command inside the window — not by its start time.
function windowSessions(recs, period) {
  if (period !== 'hour') return recs;
  const cutoff = Date.now() - HOUR_WINDOW_MS;
  return recs.filter((r) => new Date(r.startedAt).getTime() >= cutoff
    || (r.recentCmds || []).some((c) => Date.parse(c.t) >= cutoff));
}

// commands that ran inside [from, to), newest sessions included
function* rangeCommands(recs, base, from, to) {
  for (const r of recs) {
    for (const c of r.recentCmds || []) {
      const t = Date.parse(c.t);
      if (!(t >= from && t < to)) continue;
      if (base && c.b !== base) continue;
      yield [r, c];
    }
  }
}

// every 5-minute slot in the window, so the hour chart shows the full span
function hourWindowBuckets() {
  const p2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(Math.floor(now.getMinutes() / HOUR_SLOT_MIN) * HOUR_SLOT_MIN);
  const out = [];
  for (let t = now.getTime() - HOUR_WINDOW_MS; t <= now.getTime(); t += HOUR_SLOT_MIN * 60 * 1000) {
    const d = new Date(t);
    out.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`);
  }
  return out;
}
const seedBuckets = (period, from, to) => new Set(
  period === 'hour' ? hourWindowBuckets() : seedRange(period, from, to));

// Bucketing a session's whole total at its start time is useless below a day —
// an hour of work would be one bar an hour ago. Here each command lands in the
// slot it actually ran in. The per-request token breakdown (in/cached/out) is
// only known per session, so it is left out.
function cmdTimeTrends(recs, period, from, to) {
  const buckets = seedBuckets(period, from, to);
  const totals = {};
  const cmdMap = new Map();
  const promptMap = new Map();
  const seenInBucket = {};
  const sessionIds = new Set();
  for (const [r, c] of rangeCommands(recs, null, from, to)) {
    const b = bucketKey(period, c.t);
    buckets.add(b);
    const T = totals[b] || (totals[b] = { tokens: 0, sessions: 0, commands: 0 });
    T.tokens += c.k; T.commands++;
    const seen = seenInBucket[b] || (seenInBucket[b] = new Set());
    if (!seen.has(r.id)) { seen.add(r.id); T.sessions++; }
    sessionIds.add(r.id);

    const g = cmdMap.get(c.b) || (cmdMap.set(c.b, { base: c.b, total: 0, count: 0, per: {} }).get(c.b));
    g.total += c.k; g.count++;
    const pc = g.per[b] || (g.per[b] = { tokens: 0, count: 0 });
    pc.tokens += c.k; pc.count++;

    if (r.prompt) {
      const key = r.prompt.toLowerCase().slice(0, 120);
      const pg = promptMap.get(key)
        || (promptMap.set(key, { prompt: r.prompt, project: r.project, total: 0, count: 0, ids: new Set(), per: {} }).get(key));
      pg.total += c.k;
      pg.ids.add(r.id); pg.count = pg.ids.size;
      if (!pg.project && r.project) pg.project = r.project;
      const pb = pg.per[b] || (pg.per[b] = { tokens: 0, count: 0 });
      pb.tokens += c.k; pb.count++;
    }
  }
  const grand = Object.values(totals).reduce((a, t) => {
    for (const k of Object.keys(t)) a[k] = (a[k] || 0) + t[k];
    return a;
  }, {});
  grand.sessions = sessionIds.size;
  return {
    period,
    byCommandTime: true,
    building: !rollupReady,
    progress: buildProgress,
    buckets: [...buckets].sort(),
    totals,
    grand,
    byCommand: [...cmdMap.values()].sort((a, b) => b.total - a.total),
    byPrompt: [...promptMap.values()].map(({ ids, ...p }) => p).sort((a, b) => b.total - a.total).slice(0, 400),
    sessions: sessionIds.size,
    facets: rollupFacets(),
  };
}

function trends(period, includeSub, model, effort, source, from, to, repo) {
  let recs = windowSessions(pickSessions(includeSub, model, effort, source, repo), period);
  if (CMD_TIME_PERIODS.has(period) && hasCmdTimes(from)) {
    const lo = from == null ? Date.now() - HOUR_WINDOW_MS : from;
    return cmdTimeTrends(recs, period, lo, to == null ? Infinity : to);
  }
  if (from != null) recs = recs.filter((r) => {
    const t = Date.parse(r.startedAt);
    return t >= from && t < to;
  });
  const buckets = seedBuckets(period, from, to);
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

// ---------------------------------------------------------------------------
// Agents — the same spend cut by *who* spent it, so agent types can be compared
// on efficiency rather than just volume.
// ---------------------------------------------------------------------------
// Commands grouped into what they are for: "reading costs me 40% of my tool
// budget" is actionable in a way that a list of forty binaries is not.
const CMD_CLASS = [
  ['poll', ['write_stdin', 'wait', 'wait_agent', 'exec_command', 'sleep']],
  ['read', ['cat', 'sed', 'head', 'tail', 'rg', 'grep', 'find', 'ls', 'less', 'awk', 'wc', 'jq',
    'Read', 'Grep', 'Glob', 'NotebookRead']],
  ['edit', ['apply_patch', 'patch', 'tee', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']],
  ['vcs', ['git', 'gh', 'rtk']],
  ['build', ['pnpm', 'npm', 'yarn', 'node', 'python', 'python3', 'pytest', 'cargo', 'go', 'make',
    'tsc', 'eslint', 'ruff', 'bash', 'sh', 'timeout', 'export']],
  ['net', ['curl', 'wget', 'ssh', 'scp', 'WebFetch', 'WebSearch']],
  ['agent', ['Task', 'Agent', 'SendMessage', 'Skill']],
];
const CLASS_OF = new Map();
for (const [cls, bases] of CMD_CLASS) for (const b of bases) CLASS_OF.set(b, cls);
const classOf = (base) => CLASS_OF.get(String(base).split(' ')[0]) || 'other';

// role = what this agent was doing, not which model ran it
function roleOf(r) {
  if (r.autoReview || r.agentKind === 'guardian') return 'guardian';
  if (r.isSubagent) return r.agentKind || 'subagent';
  return 'main';
}
// auto-review sessions report no model of their own — they are Codex's reviewer
const modelOf = (r) => r.model || (r.autoReview || r.agentKind === 'guardian' ? 'codex-auto-review' : '?');
const AGENT_KEYS = {
  agent: (r) => `${r.source}·${roleOf(r)}·${modelOf(r)}`,
  role: (r) => `${r.source}·${roleOf(r)}`,
  model: (r) => modelOf(r),
  effort: (r) => `${modelOf(r)} · effort:${r.effort || '–'}`,
  project: (r) => r.project || '–',
};

function agents(sinceMs, includeSub, source, groupBy, repo) {
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const recs = pickSessions(includeSub, '', '', source, repo).filter((r) =>
    !cutoff || new Date(r.startedAt).getTime() >= cutoff);
  const keyOf = AGENT_KEYS[groupBy] || AGENT_KEYS.agent;

  const groups = new Map();
  const blank = (key, r) => ({
    key,
    source: r.source, role: roleOf(r), model: modelOf(r), effort: r.effort || null,
    sessions: 0, tokens: 0, input: 0, cached: 0, output: 0, reasoning: 0,
    commands: 0, outTokens: 0, truncated: 0, dupeRuns: 0, dupeTokens: 0,
    compactions: 0, lastSeen: null,
    _bases: new Map(), classes: {},
  });

  for (const r of recs) {
    const key = keyOf(r);
    const g = groups.get(key) || groups.set(key, blank(key, r)).get(key);
    g.sessions++;
    g.tokens += r.totals.billed || r.totals.total || 0;
    g.input += r.totals.input || 0;
    g.cached += r.totals.cached || 0;
    g.output += r.totals.output || 0;
    g.reasoning += r.totals.reasoning || 0;
    g.commands += r.toolCalls || 0;
    g.outTokens += r.outTokens || 0;
    g.compactions += r.compactions || 0;
    if (!g.lastSeen || r.startedAt > g.lastSeen) g.lastSeen = r.startedAt;
    if (g.model && g.model !== modelOf(r)) g.model = null;               // mixed
    if (g.effort && r.effort && g.effort !== r.effort) g.effort = null;
    if (g.role !== roleOf(r)) g.role = null;

    for (const c of r.cmds || []) {
      const e = g._bases.get(c.base) || (g._bases.set(c.base,
        { base: c.base, cls: classOf(c.base), tokens: 0, calls: 0, out: 0, truncated: 0 }).get(c.base));
      e.tokens += c.tokens; e.calls += c.count;
    }
    for (const [base, ob] of Object.entries(r.outByBase || {})) {
      const e = g._bases.get(base) || (g._bases.set(base,
        { base, cls: classOf(base), tokens: 0, calls: 0, out: 0, truncated: 0 }).get(base));
      e.out += ob.tokens; e.truncated += ob.truncated;
      if (!e.calls) e.calls += ob.calls;
      g.truncated += ob.truncated;
    }
    for (const d of r.dupes || []) {
      g.dupeRuns += d.count - 1;
      g.dupeTokens += Math.round(d.tokens * (d.count - 1) / d.count);
    }
  }

  const out = [...groups.values()].map((g) => {
    const bases = [...g._bases.values()].sort((a, b) => (b.tokens + b.out) - (a.tokens + a.out));
    const classes = {};
    for (const b of bases) {
      const c = classes[b.cls] || (classes[b.cls] = { cls: b.cls, tokens: 0, out: 0, calls: 0 });
      c.tokens += b.tokens; c.out += b.out; c.calls += b.calls;
    }
    delete g._bases;
    const ctxIn = g.input + g.cached;
    return {
      ...g,
      classes: Object.values(classes).sort((a, b) => (b.tokens + b.out) - (a.tokens + a.out)),
      topBases: bases.slice(0, 12),
      perSession: g.sessions ? Math.round(g.tokens / g.sessions) : 0,
      perCommand: g.commands ? Math.round(g.tokens / g.commands) : 0,
      cacheRate: ctxIn ? g.cached / ctxIn : null,
      reasonShare: g.output ? g.reasoning / g.output : null,
      outShare: g.tokens ? g.outTokens / g.tokens : null,
      truncRate: g.commands ? g.truncated / g.commands : null,
      dupeShare: g.outTokens ? g.dupeTokens / g.outTokens : null,
    };
  }).sort((a, b) => b.tokens - a.tokens);

  const grand = out.reduce((a, g) => {
    a.tokens += g.tokens; a.sessions += g.sessions; a.commands += g.commands;
    a.outTokens += g.outTokens; a.dupeTokens += g.dupeTokens;
    a.cached += g.cached; a.input += g.input; a.reasoning += g.reasoning; a.output += g.output;
    return a;
  }, { tokens: 0, sessions: 0, commands: 0, outTokens: 0, dupeTokens: 0, cached: 0, input: 0, reasoning: 0, output: 0 });

  return { groupBy, groups: out, grand, classes: CMD_CLASS.map(([c]) => c).concat('other') };
}

// "Where are the tokens going, and what looks wasteful?"
function economy(sinceMs, includeSub, model, effort, source, repo) {
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const recs = pickSessions(includeSub, model, effort, source, repo).filter((r) =>
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
// same idea as hourTrends: at 5-minute resolution a command belongs in the slot
// it ran in, not in its session's start slot
function cmdTimeCommandTrend(base, recs, period, from, to) {
  const buckets = seedBuckets(period, from, to);
  const series = { outTokens: {}, calls: {}, truncated: {}, delta: {} };
  const bump = (k, b, v) => { series[k][b] = (series[k][b] || 0) + v; };
  const sampMap = new Map();
  const pollMap = new Map();
  const totals = { outTokens: 0, calls: 0, truncated: 0, delta: 0, sessions: 0 };
  const sessionIds = new Set();
  const tally = (map, key, c, b) => {
    const e = map.get(key) || (map.set(key, { cmd: key, count: 0, out: 0, trunc: 0, per: {} }).get(key));
    e.count++; e.out += c.o; e.trunc += c.tr;
    const pb = e.per[b] || (e.per[b] = { outTokens: 0, calls: 0, truncated: 0 });
    pb.outTokens += c.o; pb.calls++; pb.truncated += c.tr;
  };
  for (const [r, c] of rangeCommands(recs, base, from, to)) {
    const b = bucketKey(period, c.t);
    buckets.add(b);
    sessionIds.add(r.id);
    bump('outTokens', b, c.o); bump('calls', b, 1); bump('truncated', b, c.tr); bump('delta', b, c.k);
    totals.outTokens += c.o; totals.calls++; totals.truncated += c.tr; totals.delta += c.k;
    tally(sampMap, c.c || base, c, b);
    // polls are interesting for *what* they were waiting on, not the poll call
    if (c.g) tally(pollMap, c.g, c, b);
  }
  totals.sessions = sessionIds.size;
  return {
    base,
    period,
    byCommandTime: true,
    buckets: [...buckets].sort(),
    series,
    totals,
    samples: [...sampMap.values()].sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 15),
    pollTargets: [...pollMap.values()].sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 12),
    facets: rollupFacets(),
  };
}

function commandTrend(base, period, includeSub, model, effort, source, from, to, repo) {
  let recs = windowSessions(pickSessions(includeSub, model, effort, source, repo), period);
  if (CMD_TIME_PERIODS.has(period) && hasCmdTimes(from)) {
    const lo = from == null ? Date.now() - HOUR_WINDOW_MS : from;
    return cmdTimeCommandTrend(base, recs, period, lo, to == null ? Infinity : to);
  }
  if (from != null) recs = recs.filter((r) => {
    const t = Date.parse(r.startedAt);
    return t >= from && t < to;
  });
  const buckets = seedBuckets(period, from, to);
  const series = { outTokens: {}, calls: {}, truncated: {}, delta: {}, cost: {} };
  const bump = (k, b, v) => { series[k][b] = (series[k][b] || 0) + v; };
  const sampMap = new Map();
  const pollMap = new Map();
  const isPoll = ['write_stdin', 'wait', 'wait_agent', 'exec_command'].includes(base);
  let totals = { outTokens: 0, calls: 0, truncated: 0, delta: 0, sessions: 0 };
  // Cost has to be priced per session, not once at the end: this window mixes
  // models, and an hour of Haiku next to an hour of Opus has no single rate.
  // Sessions on models missing from the table are counted in `unpriced` so the
  // UI can say the total is partial rather than quietly under-reporting.
  const cls = { i: 0, cc: 0, o: 0 };
  const cost = { i: 0, cc: 0, o: 0, total: 0 };
  const priced = { sessions: 0, unpriced: 0, models: new Set() };

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
    if (dc && dc.cls) {
      cls.i += dc.cls.i || 0; cls.cc += dc.cls.cc || 0; cls.o += dc.cls.o || 0;
      const rate = rateFor(r.model);
      if (!rate) priced.unpriced++;
      else {
        priced.sessions++; priced.models.add(rate.id);
        const c = costOf(dc.cls, rate);
        cost.i += c.i; cost.cc += c.cc; cost.o += c.o; cost.total += c.total;
        bump('cost', b, c.total);
      }
    }

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
  // A total on a single-command screen answers nothing — $11.85 is neither good
  // nor bad. What makes it readable is the unit (cost per call) set against the
  // same unit for every other command in this window, so "expensive" means
  // expensive *compared to what you otherwise run*.
  const peers = [];
  for (const r of recs) {
    const rate = rateFor(r.model);
    if (!rate) continue;
    for (const c of r.cmds || []) {
      if (!c.cls || !c.count) continue;
      const p = peers.find((x) => x.base === c.base) || (peers.push({ base: c.base, cost: 0, calls: 0 }), peers[peers.length - 1]);
      p.cost += costOf(c.cls, rate).total;
      p.calls += c.count;
    }
  }
  const rated = peers.filter((p) => p.calls && p.cost > 0)
    .map((p) => ({ base: p.base, per: p.cost / p.calls }))
    .sort((a, b) => b.per - a.per);
  const mid = rated.length ? rated[Math.floor(rated.length / 2)].per : 0;
  const me = rated.find((p) => p.base === base);
  const peer = {
    perCall: me ? me.per : null,
    median: mid || null,
    rank: me ? rated.indexOf(me) + 1 : null,
    of: rated.length,
    dearest: rated.length ? rated[0] : null,
  };
  return {
    base, period,
    buckets: [...buckets].sort(),
    series, totals,
    cls, cost, priced: { ...priced, models: [...priced.models] }, peer,
    samples: [...sampMap.values()].sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 15),
    pollTargets: [...pollMap.values()].sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 12),
    facets: rollupFacets(),
  };
}

// ---------------------------------------------------------------------------
// Advice — the same rollups the Economy tab shows, turned into things to change
// ---------------------------------------------------------------------------
// The unit of cost is the turn, not the byte. Every tool call resends the
// context, so what a call *returns* is dwarfed by the fact that it happened at
// all. Findings are therefore ranked by turns saved first, carried tokens
// second, and one-shot output volume last.

// What one more tool call costs, measured per session rather than globally —
// polls cluster late in a session when the context is largest, so a per-session
// average understates them. Conservative on purpose.
function turnCost(recs) {
  let billed = 0, calls = 0;
  for (const r of recs) {
    if (!r.toolCalls) continue;
    billed += r.totals.billed || r.totals.total || 0;
    calls += r.toolCalls;
  }
  return calls ? Math.round(billed / calls) : 0;
}

// A tool result is not paid once — it sits in context and is resent on every
// later turn of that session. Exact where per-command timestamps survive; the
// coverage is reported so the number is never mistaken for the whole picture.
function carryCost(recs) {
  const byBase = new Map();
  let covered = 0, totalCalls = 0;
  for (const r of recs) {
    totalCalls += r.toolCalls || 0;
    const cmds = r.recentCmds || [];
    if (!cmds.length) continue;
    covered += cmds.length;
    for (let i = 0; i < cmds.length; i++) {
      const remaining = cmds.length - 1 - i;
      if (!remaining) continue;
      const e = byBase.get(cmds[i].b) || (byBase.set(cmds[i].b, { base: cmds[i].b, carried: 0, out: 0, calls: 0 }).get(cmds[i].b));
      e.carried += (cmds[i].o || 0) * remaining;
      e.out += cmds[i].o || 0;
      e.calls++;
    }
  }
  return {
    coverage: totalCalls ? covered / totalCalls : 0,
    byBase: [...byBase.values()].sort((a, b) => b.carried - a.carried),
  };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// ---------------------------------------------------------------------------
// Sequence mining — patterns a per-command total cannot see
// ---------------------------------------------------------------------------
// Aggregates say "wait cost you 17M tokens". They cannot say "242 of those calls
// were consecutive". Now that every command keeps its timestamp, the order is
// there to be read, and order is where the turn waste actually shows up.
const POLL_BASES = new Set(['write_stdin', 'wait', 'wait_agent', 'exec_command', 'sleep']);

// a path-shaped token: at least one slash and a file extension. Deliberately
// conservative — a missed path is a quiet undercount, a false one is a wrong claim
const PATH_RE = /(?:[\w.@~-]+\/)+[\w.@-]+\.[A-Za-z]\w{0,8}/g;
const pathsIn = (cmd) => [...new Set(String(cmd || '').match(PATH_RE) || [])];

function sequences(recs) {
  const runs = [];
  const reread = new Map();
  const idiom = new Map();
  let runTurns = 0;

  for (const r of recs) {
    const c = r.recentCmds || [];
    if (!c.length) continue;

    // unbroken stretches of polling: nothing else happened in between
    for (let i = 0; i < c.length;) {
      if (!POLL_BASES.has(c[i].b)) { i++; continue; }
      let j = i;
      while (j < c.length && POLL_BASES.has(c[j].b)) j++;
      const n = j - i;
      if (n >= 8) {
        runTurns += n - 1;                       // one call would have sufficed
        runs.push({
          n, base: c[i].b, sessionId: r.id, prompt: r.prompt, project: r.project,
          mins: Math.round((Date.parse(c[j - 1].t) - Date.parse(c[i].t)) / 60000),
        });
      }
      i = j;
    }

    // the same file read more than once in one session — the content is already
    // in context the second time
    const seen = new Map();
    for (const x of c) {
      if (classOf(x.b) !== 'read') continue;
      for (const p of pathsIn(x.c)) {
        const n = (seen.get(p) || 0) + 1;
        seen.set(p, n);
        if (n > 1) {
          const e = reread.get(p) || (reread.set(p, { path: p, extra: 0, sessions: new Set() }).get(p));
          e.extra++; e.sessions.add(r.id);
        }
      }
    }

    // two different read commands back to back — the search-then-read idiom,
    // which one ranged read usually replaces
    for (let k = 1; k < c.length; k++) {
      const a = c[k - 1].b, b = c[k].b;
      if (a === b || classOf(a) !== 'read' || classOf(b) !== 'read') continue;
      const key = a + ' → ' + b;
      idiom.set(key, (idiom.get(key) || 0) + 1);
    }
  }

  return {
    runs: runs.sort((a, b) => b.n - a.n).slice(0, 5), runTurns,
    reread: [...reread.values()].sort((a, b) => b.extra - a.extra).slice(0, 5),
    rereadTurns: [...reread.values()].reduce((a, e) => a + e.extra, 0),
    idiom: [...idiom.entries()].map(([pair, n]) => ({ pair, n })).sort((a, b) => b.n - a.n).slice(0, 3),
  };
}


// Remedies are drawn from what detectToolchain() actually found. A suggestion
// naming a tool that is not installed is worse than saying nothing.
function remediesFor(kind, ctx, tc) {
  const out = [];
  const filterFor = (base) => tc.filters && tc.filters.commands.includes(String(base).split(' ')[0])
    ? `${tc.filters.tool} ${String(base).split(' ')[0]}` : null;

  if (kind === 'polls') {
    out.push('Wait longer per poll — each check costs a full turn whatever it returns.');
    out.push('Chain dependent steps with && into one call instead of polling between them.');
    if (tc.agents.length) out.push(`Hand long-running work to a subagent (${tc.agents.slice(0, 3).join(', ')}) so its polling does not sit in this context.`);
  }
  if (kind === 'dupes') {
    out.push('A repeated read is already in context — carry the answer forward instead of asking again.');
    out.push('A repeated write or check usually means a retry loop: fix the failure rather than re-running.');
    if (ctx.cmd) out.push(`Most repeated: ${ctx.cmd} (${ctx.n}× beyond the first run)`);
  }
  if (kind === 'carry') {
    // a poll's output is an accumulating stdout buffer, not a query result —
    // "add a path filter" would be nonsense advice for it
    if (classOf(ctx.base) === 'poll') {
      out.push('This is the polling above, seen from the context side: every check leaves its output behind for the rest of the session.');
      out.push('Fewer, longer waits shrink both the turn count and what they leave in context.');
    } else {
      out.push('Narrow the command so less lands in context: path filters, --stat, -n limits, or a specific field instead of the whole document.');
    }
    const f = filterFor(ctx.base);
    if (f) out.push(`${f} would filter this output before it reaches the context.`);
  }
  if (kind === 'truncation') {
    out.push('Truncated output is paid for and then discarded — narrow the query rather than clipping it.');
    const f = filterFor(ctx.base);
    if (f) out.push(`${f} compacts before the limit is hit.`);
  }
  if (kind === 'pollrun') {
    out.push(`One wait covering the whole span replaces the run — the longest here was ${ctx.n} calls over ${ctx.mins} minutes.`);
    out.push('If the runtime supports a blocking wait or a longer timeout, a single call ends the loop.');
    if (tc.agents.length) out.push(`Or hand the job to a subagent (${tc.agents.slice(0, 3).join(', ')}) so its waiting is not billed against this context.`);
  }
  if (kind === 'reread') {
    out.push('If the same slice came back twice it is already in context — refer to it rather than reading again.');
    out.push('If each read took a different range, the file is being consumed piecemeal: read the section that matters once, or split the file so a whole read is cheap.');
  }
  if (kind === 'idiom') {
    out.push('Locating then reading is two turns for one question — a single ranged read (offset + limit) does both.');
    const f = filterFor(ctx.first);
    if (f) out.push(`${f} also trims what the search half returns.`);
  }
  if (kind === 'hookmiss') {
    out.push(`Your ${ctx.event} hook (${ctx.matcher}) runs "${ctx.runs}" but these calls still ran unfiltered — check why they fall through.`);
  }
  return out;
}

function advice(sinceMs, includeSub, model, effort, source, repo) {
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const recs = pickSessions(includeSub, model, effort, source, repo)
    .filter((r) => !cutoff || new Date(r.startedAt).getTime() >= cutoff);
  const tc = detectToolchain();
  const perTurn = turnCost(recs);

  let calls = 0, polls = 0, dupeRuns = 0, billed = 0;
  const worstDupe = { cmd: null, n: 0 };
  const trunc = new Map();
  for (const r of recs) {
    calls += r.toolCalls || 0;
    polls += r.pollTurns || 0;
    billed += r.totals.billed || r.totals.total || 0;
    for (const d of r.dupes || []) {
      dupeRuns += d.count - 1;
      if (d.count - 1 > worstDupe.n) { worstDupe.n = d.count - 1; worstDupe.cmd = d.cmd; }
    }
    for (const [base, g] of Object.entries(r.outByBase || {})) {
      const e = trunc.get(base) || (trunc.set(base, { base, truncated: 0, calls: 0, tokens: 0 }).get(base));
      e.truncated += g.truncated; e.calls += g.calls; e.tokens += g.tokens;
    }
  }
  const carry = carryCost(recs);
  const findings = [];

  // Two different currencies, never added together: a turn is billed at full
  // context price, while carried output is resent as cached input. Findings
  // report whichever applies and are ranked turns first.
  const F = (o) => findings.push({ turns: 0, turnTokens: 0, carried: 0, ...o });

  if (polls) F({
    id: 'polls', kind: 'turns', title: 'Turns spent waiting rather than working',
    detail: `${polls.toLocaleString()} of ${calls.toLocaleString()} tool calls (${pct(polls, calls)}%) were polls or waits. Each one resends the whole context whatever it returns.`,
    turns: polls, turnTokens: polls * perTurn,
    evidence: { pollTurns: polls, toolCalls: calls, sharePct: pct(polls, calls), perTurn },
    remedies: remediesFor('polls', {}, tc),
  });

  if (dupeRuns) F({
    id: 'dupes', kind: 'turns', title: 'Commands re-run without their output changing',
    detail: `${dupeRuns.toLocaleString()} repeat runs of commands that returned what they had already returned.`,
    turns: dupeRuns, turnTokens: dupeRuns * perTurn,
    evidence: { repeats: dupeRuns, worst: worstDupe.cmd, worstRepeats: worstDupe.n, perTurn },
    remedies: remediesFor('dupes', { cmd: worstDupe.cmd, n: worstDupe.n }, tc),
  });

  const seq = sequences(recs);
  if (seq.runs.length) {
    const top = seq.runs[0];
    F({
      id: 'pollrun', kind: 'turns',
      title: 'Polling in unbroken runs, nothing else happening',
      detail: `Of those poll turns, ${seq.runTurns.toLocaleString()} sat inside unbroken runs with nothing `
        + `in between — the longest ${top.n} consecutive ${top.base} calls over ${top.mins} minutes, `
        + 'which one wait would have covered. (A subset of the finding above, not extra cost.)',
      turns: seq.runTurns, turnTokens: seq.runTurns * perTurn,
      evidence: { longestRun: top.n, minutes: top.mins, base: top.base, sessionId: top.sessionId,
        prompt: top.prompt, runs: seq.runs.length, turnsInRuns: seq.runTurns },
      remedies: remediesFor('pollrun', top, tc),
    });
  }
  if (seq.rereadTurns) {
    const top = seq.reread[0];
    F({
      id: 'reread', kind: 'turns',
      title: 'The same file read more than once in one session',
  detail: `${seq.rereadTurns.toLocaleString()} reads of a file this session had already opened — usually a `
        + `different slice each time rather than the identical command. Most re-read: ${top.path} `
        + `(${top.extra}× beyond the first, across ${top.sessions.size} session${top.sessions.size > 1 ? 's' : ''}).`,
      turns: seq.rereadTurns, turnTokens: seq.rereadTurns * perTurn,
      evidence: { repeatReads: seq.rereadTurns, top: seq.reread.map((e) => ({ path: e.path, extra: e.extra, sessions: e.sessions.size })) },
      remedies: remediesFor('reread', {}, tc),
    });
  }
  if (seq.idiom.length && seq.idiom[0].n >= 50) {
    const top = seq.idiom[0];
    F({
      id: 'idiom', kind: 'turns',
      title: `"${top.pair}" run back to back`,
      detail: `${top.n.toLocaleString()} times one read command was followed straight by another — `
        + 'locating something, then reading around it, at two turns a go.',
      turns: top.n, turnTokens: top.n * perTurn,
      evidence: { pairs: seq.idiom },
      remedies: remediesFor('idiom', { first: top.pair.split(' ')[0] }, tc),
    });
  }

  const cov = Math.round(carry.coverage * 100);
  for (const e of carry.byBase.slice(0, 3)) {
    if (!e.carried || !e.out) continue;
    F({
      id: 'carry:' + e.base, kind: 'carry',
      title: `${e.base} output is carried for the rest of the session`,
      detail: `Each token it returns is resent about ${Math.round(e.carried / e.out).toLocaleString()}× as context before the session ends`
        + ` — ${(e.carried / 1e9).toFixed(1)}B cached tokens across the ${cov}% of calls with per-command timing.`,
      carried: e.carried,
      evidence: { base: e.base, outTokens: e.out, carriedTokens: e.carried, multiple: Math.round(e.carried / e.out), calls: e.calls, coveragePct: cov },
      remedies: remediesFor('carry', { base: e.base }, tc),
    });
  }

  for (const e of [...trunc.values()].filter((x) => x.calls >= 20 && x.truncated / x.calls > 0.1)
    .sort((a, b) => b.truncated - a.truncated).slice(0, 3)) {
    const avg = Math.round(e.tokens / Math.max(e.calls, 1));
    F({
      id: 'trunc:' + e.base, kind: 'waste',
      title: `${e.base} output is being cut off`,
      detail: `${e.truncated.toLocaleString()} of ${e.calls.toLocaleString()} calls (${pct(e.truncated, e.calls)}%) hit the output limit — about ${(e.truncated * avg / 1e6).toFixed(1)}M tokens paid for and then discarded, and the answer still incomplete.`,
      carried: e.truncated * avg,
      evidence: { base: e.base, truncated: e.truncated, calls: e.calls, ratePct: pct(e.truncated, e.calls), avgOut: avg },
      remedies: remediesFor('truncation', { base: e.base }, tc),
    });
  }

  findings.sort((a, b) => (b.turnTokens - a.turnTokens) || (b.carried - a.carried));
  // a finding with nothing to show a model must not offer to show one
  for (const f of findings) f.deepenable = !!evidenceFor(f.id, recs);
  return {
    building: !rollupReady, progress: buildProgress,
    scope: { sessions: recs.length, toolCalls: calls, billed, perTurn, carryCoveragePct: Math.round(carry.coverage * 100) },
    findings, toolchain: tc, facets: rollupFacets(),
  };
}

// ---------------------------------------------------------------------------
// Deepening a finding with a model
// ---------------------------------------------------------------------------
// The model annotates a finding, it never adds one. Rules own what a thing costs
// and how often it happened; the model only reads the actual commands and says
// what the loop was doing and what to change. So it inherits the finding's
// numbers, cannot reorder the list, and is given no field to put a figure in.
const deepCache = new Map();

// A small, targeted window per finding — never the corpus. Each kind knows what
// evidence would let a reader judge it.
function evidenceFor(id, recs) {
  const kind = id.split(':')[0], arg = id.slice(kind.length + 1);
  const lines = [];
  const short = (c) => String(c || '').replace(/\s+/g, ' ').slice(0, 160);

  if (kind === 'pollrun') {
    let best = null;
    for (const r of recs) {
      const c = r.recentCmds || [];
      for (let i = 0; i < c.length;) {
        if (!POLL_BASES.has(c[i].b)) { i++; continue; }
        let j = i;
        while (j < c.length && POLL_BASES.has(c[j].b)) j++;
        if (!best || j - i > best.n) best = { n: j - i, i, j, c, r };
        i = j;
      }
    }
    if (best) {
      lines.push(`Session prompt: ${short(best.r.prompt)}`);
      lines.push(`The ${best.n} commands before the run:`);
      for (const x of best.c.slice(Math.max(0, best.i - 8), best.i)) lines.push(`  ${x.t} ${x.b}  ${short(x.c)}`);
      lines.push(`The run itself (${best.n} calls, first and last three):`);
      for (const x of [...best.c.slice(best.i, best.i + 3), ...best.c.slice(best.j - 3, best.j)]) {
        lines.push(`  ${x.t} ${x.b}  ${short(x.c)}`);
      }
      lines.push('What followed the run:');
      for (const x of best.c.slice(best.j, best.j + 5)) lines.push(`  ${x.t} ${x.b}  ${short(x.c)}`);
    }
  }

  if (kind === 'polls') {
    // what is being polled, and what started it — the useful question here is
    // whether the thing being waited on could have been waited on once
    const targets = new Map();
    const worst = [];
    for (const r of recs) {
      for (const pt of r.pollTargets || []) {
        targets.set(pt.cmd, (targets.get(pt.cmd) || 0) + (pt.count || 0));
      }
      if ((r.toolCalls || 0) >= 40 && (r.pollTurns || 0) / r.toolCalls > 0.4) {
        worst.push({ pct: Math.round(100 * r.pollTurns / r.toolCalls), n: r.pollTurns, prompt: r.prompt });
      }
    }
    const top = [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (top.length) {
      lines.push('Processes being polled, and how many polls each drew:');
      for (const [cmd, n] of top) lines.push(`  ${n}x  ${short(cmd)}`);
    }
    lines.push('', 'Poll calls as they were actually issued:');
    const samples = new Set();
    for (const r of recs) {
      for (const x of r.recentCmds || []) {
        if (POLL_BASES.has(x.b) && samples.size < 8) samples.add(`  ${x.b}  ${short(x.c)}`);
      }
      if (samples.size >= 8) break;
    }
    lines.push(...samples);
    if (worst.length) {
      lines.push('', 'Sessions that spent most of their turns polling:');
      for (const w of worst.sort((a, b) => b.pct - a.pct).slice(0, 5)) {
        lines.push(`  ${w.pct}% of turns (${w.n} polls) — ${short(w.prompt)}`);
      }
    }
  }

  if (kind === 'reread') {
    const counts = new Map();
    for (const r of recs) {
      const seen = new Set();
      for (const x of r.recentCmds || []) {
        if (classOf(x.b) !== 'read') continue;
        for (const pth of pathsIn(x.c)) {
          if (seen.has(pth)) counts.set(pth, (counts.get(pth) || 0) + 1);
          seen.add(pth);
        }
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      lines.push(`Most re-read file: ${top[0]}`);
      lines.push('Distinct commands that read it:');
      const uniq = new Set();
      for (const r of recs) for (const x of r.recentCmds || []) {
        if (String(x.c || '').includes(top[0]) && uniq.size < 14) uniq.add(`  ${x.b}  ${short(x.c)}`);
      }
      lines.push(...uniq);
    }
  }

  if (kind === 'idiom') {
    lines.push('Consecutive read-then-read pairs, as they actually ran:');
    let n = 0;
    for (const r of recs) {
      const c = r.recentCmds || [];
      for (let k = 1; k < c.length && n < 10; k++) {
        if (c[k - 1].b === c[k].b) continue;
        if (classOf(c[k - 1].b) !== 'read' || classOf(c[k].b) !== 'read') continue;
        lines.push(`  1) ${short(c[k - 1].c)}`);
        lines.push(`  2) ${short(c[k].c)}`);
        lines.push('  --');
        n++;
      }
      if (n >= 10) break;
    }
  }

  if (kind === 'dupes') {
    lines.push('Commands a session ran repeatedly without their output changing:');
    const all = [];
    for (const r of recs) for (const d of r.dupes || []) all.push(d);
    for (const d of all.sort((a, b) => b.count - a.count).slice(0, 10)) {
      lines.push(`  ${d.count}x  ${short(d.cmd)}`);
    }
  }

  if (kind === 'carry' || kind === 'trunc') {
    lines.push(`Largest invocations of "${arg}" by output size:`);
    const all = [];
    for (const r of recs) for (const x of r.recentCmds || []) if (x.b === arg) all.push(x);
    for (const x of all.sort((a, b) => (b.o || 0) - (a.o || 0)).slice(0, 12)) {
      lines.push(`  ${x.o} output tokens${x.tr ? ' (truncated)' : ''}  ${short(x.c)}`);
    }
  }

  return lines.join('\n').slice(0, 6000);
}

// Any figure the model states that is not in the evidence it was given is a
// number it made up. Cheap to check, so check it.
function unsupportedNumbers(text, evidence, finding) {
  const known = new Set();
  for (const m of (evidence + ' ' + JSON.stringify(finding)).matchAll(/\d[\d,]*/g)) {
    known.add(m[0].replace(/,/g, ''));
  }
  const bad = [];
  for (const m of String(text).matchAll(/\d[\d,]*(?:\.\d+)?\s*[BMk]?/g)) {
    const raw = m[0].trim().replace(/,/g, '').replace(/[BMk]$/, '');
    if (Number(raw) >= 100 && !known.has(raw)) bad.push(m[0].trim());
  }
  return [...new Set(bad)];
}

function deepenPrompt(finding, evidence, tc) {
  return `You are reading one finding from a token-usage audit of an AI coding agent's own command history.
The finding, its counts and its cost are already computed and are NOT yours to restate or recompute.

FINDING: ${finding.title}
WHAT THE RULES MEASURED: ${finding.detail}

THE ACTUAL COMMANDS BEHIND IT:
${evidence}

AVAILABLE HERE: ${tc.filters ? tc.filters.tool + ' (' + tc.filters.commands.join(' ') + ')' : 'no output-filter proxy'}
MCP servers: ${tc.mcpServers.join(', ') || 'none'}. Subagents defined: ${tc.agents.join(', ') || 'none'}.
Hooks: ${tc.hooks.map((h) => h.matcher + ' -> ' + h.runs).join('; ') || 'none'}

Say what this loop was actually trying to do, and what to change. Be concrete and specific to
these commands — quote them. Only suggest tooling listed as available. Do not state any quantity,
cost or count: those are already known and yours would be a guess.

Reply with only this JSON:
{"pattern":"<what the agent was doing, one or two sentences>",
 "why":"<why it costs turns, specific to these commands>",
 "fix":["<a concrete change, naming the actual command or file>", "..."],
 "confidence":"high|medium|low"}`;
}

// argv, not stdin: execFile's `input` is sync-only, and these CLIs otherwise sit
// waiting on a pipe that never fills. No shell, so nothing in the prompt is
// interpreted. Neither runner is allowed to touch the filesystem — it is being
// asked to read evidence it has already been handed, not to go looking.
function runnerArgv(runner, model, effort, prompt) {
  const eff = effortsFor(runner).includes(effort) ? effort : '';
  if (runner === 'codex') {
    return ['codex', ['exec', '--skip-git-repo-check', '-s', 'read-only',
      ...(model ? ['-m', model] : []),
      ...(eff ? ['-c', `model_reasoning_effort="${eff}"`] : []), prompt]];
  }
  return ['claude', ['-p', prompt, '--output-format', 'json',
    '--disallowed-tools', 'Bash', 'Edit', 'Write',
    ...(model ? ['--model', model] : []),
    ...(eff ? ['--effort', eff] : [])]];
}

// A CLI's stdout is not necessarily JSON. Codex prints a banner, the reply, then
// a token footer; taking everything between the first "{" and the last "}" spans
// all of it. Walk the string instead and collect whole balanced objects.
function extractJson(text) {
  const str = String(text || '');
  const found = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < str.length; j++) {
      const ch = str[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { found.push(JSON.parse(str.slice(i, j + 1))); } catch (_) {}
        i = j;
        break;
      }
    }
  }
  // the answer is the last object that looks like the shape we asked for
  return found.reverse().find((o) => o && (o.pattern || o.fix)) || found[0] || null;
}

// codex reports usage as a "tokens used" line rather than in a JSON envelope
function codexTokens(text) {
  const m = /tokens used[\s\S]{0,20}?([\d,]+)/i.exec(String(text || ''));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function deepen(finding, recs, tc, runner, model, effort, cb) {
  const evidence = evidenceFor(finding.id, recs);
  if (!evidence) return cb({ error: 'no evidence to show a model for this finding' });
  if (!tc.runners.some((r) => r.id === runner)) {
    invalidateToolchain();
    return cb({ error: `no ${runner} CLI found on this machine`, runnerGone: true });
  }
  const prompt = deepenPrompt(finding, evidence, tc);
  const started = Date.now();
  const [bin, args] = runnerArgv(runner, model, effort, prompt);
  const child = cp.execFile(bin, args,
    { encoding: 'utf8', timeout: 180000, maxBuffer: 8 << 20 },
    (err, stdout, stderr) => {
      if (err && !stdout) {
        // ENOENT means it was uninstalled since we looked. Re-detect so the next
        // page load stops offering it, and say so rather than showing exec noise.
        const gone = err.code === 'ENOENT' || /ENOENT|not found/i.test(String(err.message));
        if (gone) invalidateToolchain();
        return cb({
          error: gone ? `${bin} is no longer installed — the list has been refreshed`
            : `${bin} failed: ${String(err.message).slice(0, 200)}`,
          runnerGone: gone,
        });
      }
      let env = null, text = stdout;
      try { const j = JSON.parse(stdout); if (j && typeof j === 'object' && 'result' in j) { env = j; text = j.result || ''; } }
      catch (_) { /* not an envelope — the raw transcript is the text */ }
      // some CLIs put their banner and any complaint on stderr, so when stdout
      // is silent that is where the reason lives
      const body = extractJson(text) || extractJson(stderr);
      if (!body) {
        const shown = (String(text).trim() || String(stderr).trim() || '(both stdout and stderr were empty)');
        return cb({
          error: `${bin} did not answer in the requested shape`,
          raw: shown.slice(-600),
        });
      }
      const flagged = unsupportedNumbers(JSON.stringify(body), evidence, finding);
      cb({
        pattern: body.pattern, why: body.why, fix: Array.isArray(body.fix) ? body.fix : [],
        confidence: body.confidence || 'unknown',
        flagged,                                     // figures with no basis in the evidence
        ranBy: { runner, model: model || 'default' },
        cost: { tokens: (env && env.usage) ? (env.usage.input_tokens || 0) + (env.usage.output_tokens || 0)
          : codexTokens(text) || codexTokens(stderr),   // codex reports usage on stderr
          usd: env && env.total_cost_usd != null ? env.total_cost_usd : null,
          ms: Date.now() - started },
      });
    });
  // The prompt is already in argv, but a CLI whose stdin is an open pipe may sit
  // waiting for more of it — codex prints "Reading additional input from stdin"
  // and blocks forever. Give it EOF immediately.
  if (child.stdin) child.stdin.end();
}

// ---------------------------------------------------------------------------
// Toolchain inventory — what remedies are actually available here
// ---------------------------------------------------------------------------
// Advice that names a tool you do not have is worse than no advice, so findings
// are only allowed to suggest what this machine can actually do. Read names, never
// values: these files hold credentials.
const cp = require('child_process');
let toolchainCache = null;
// Detection is cheap and the answer changes when someone installs or removes a
// CLI, so it is re-taken at startup, every few minutes, and immediately after a
// runner fails to launch — the case where the cache is provably wrong.
const TOOLCHAIN_TTL_MS = 5 * 60 * 1000;
const invalidateToolchain = () => { toolchainCache = null; };

function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}
function listNames(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length));
  } catch (_) { return []; }
}
// fixed argv only, never anything derived from a request. A probe that does not
// answer immediately is treated as absent: burnboard's own features must never
// wait on an optional tool.
function tryExec(bin, args, timeout = 1500) {
  try {
    return cp.execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) { return null; }
}

// Which assistants are installed and could read a finding. Presence costs a
// process spawn so it is cached; the model list is derived from the rollups and
// so is recomputed every time — at startup the inventory is taken before the
// rollups have loaded, and a cached empty list would outlive the reason for it.
// efforts are each CLI's own vocabulary: Claude Code takes --effort, Codex takes
// a model_reasoning_effort config override. Both lists are allowlists — the value
// reaches an argv, and for Codex it is a config key, so an unchecked string there
// could set any other config too.
const RUNNERS = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', aliases: ['opus', 'sonnet', 'haiku'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', label: 'Codex CLI', bin: 'codex', aliases: [],
    efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'] },
];
const effortsFor = (id) => (RUNNERS.find((r) => r.id === id) || {}).efforts || [];

function modelsFor(id) {
  const seen = new Set();
  for (const r of (rollupCache ? rollupCache.sessions.values() : [])) {
    // "<synthetic>" and the auto-review label are bookkeeping, not models you
    // can ask for
    if (r.model && r.source === id && !r.model.startsWith('<') && r.model !== 'codex-auto-review') {
      seen.add(r.model);
    }
  }
  const def = RUNNERS.find((r) => r.id === id);
  return [...new Set([...(def ? def.aliases : []), ...seen])];
}

const detectRunners = () => AI_DISABLED ? []
  : RUNNERS.filter((r) => tryExec(r.bin, ['--version']))
    .map((r) => ({ id: r.id, label: r.label, models: [], efforts: r.efforts || [] }));

// the models a runner offers change as the history does, so fill them in fresh
const withModels = (tc) => {
  for (const r of tc.runners) r.models = modelsFor(r.id);
  return tc;
};

function detectToolchain() {
  if (toolchainCache && Date.now() - toolchainCache.at < TOOLCHAIN_TTL_MS) return withModels(toolchainCache.data);
  const home = os.homedir();
  const out = { filters: null, mcpServers: [], agents: [], skills: [], hooks: [], plugins: [], runners: [] };
  out.runners = detectRunners();

  // an output-filtering proxy, if one is installed (rtk is the one this project
  // knows by name; absence just means those remedies are not offered)
  const ver = tryExec('rtk', ['--version']);
  if (ver) {
    const help = tryExec('rtk', ['--help']) || '';
    const cmds = help.split('\n')
      .map((l) => /^\s{2}([a-z][a-z0-9-]*)\s{2,}\S/.exec(l))
      .filter(Boolean).map((m) => m[1]);
    // `rtk --version` already prints "rtk 0.43.0" — do not repeat the name
    out.filters = { tool: 'rtk', version: ver.trim().replace(/^rtk\s+/, ''), commands: cmds };
  }

  for (const f of [path.join(home, '.claude/settings.json'), path.join(process.cwd(), '.claude/settings.json')]) {
    const j = readJSON(f);
    if (!j) continue;
    for (const [evt, arr] of Object.entries(j.hooks || {})) {
      for (const h of arr || []) {
        out.hooks.push({ event: evt, matcher: h.matcher || '*', runs: (h.hooks || []).map((x) => x.command).join('; ') });
      }
    }
    for (const p of Object.keys(j.enabledPlugins || {})) out.plugins.push(p);
  }

  const seen = new Set();
  for (const f of [path.join(home, '.claude.json'), path.join(process.cwd(), '.mcp.json')]) {
    const j = readJSON(f);
    if (!j) continue;
    for (const n of Object.keys(j.mcpServers || {})) seen.add(n);
    for (const proj of Object.values(j.projects || {})) {
      for (const n of Object.keys((proj && proj.mcpServers) || {})) seen.add(n);
    }
  }
  out.mcpServers = [...seen];

  for (const d of [path.join(home, '.claude/agents'), path.join(process.cwd(), '.claude/agents')]) {
    out.agents.push(...listNames(d, '.md'));
  }
  for (const d of [path.join(home, '.claude/skills'), path.join(process.cwd(), '.claude/skills')]) {
    try { out.skills.push(...fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)); }
    catch (_) {}
  }
  out.agents = [...new Set(out.agents)];
  out.skills = [...new Set(out.skills)];

  toolchainCache = { at: Date.now(), data: out };
  return withModels(out);
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

  // the header's repo picker needs the list before any tab has loaded
  if (pathn === '/api/facets') {
    ensureRollups();
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, rollupFacets());
  }

  if (pathn === '/api/trends') {
    ensureRollups();
    const q = url.searchParams;
    const period = PERIODS.includes(q.get('period')) ? q.get('period') : 'day';
    const includeSub = q.get('subagents') === '1';
    const [from, to] = drillRange(q);
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, trends(period, includeSub, q.get('model') || '', q.get('effort') || '',
      q.get('source') || '', from, to, q.get('repo') || ''));
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
        repo: r.repo, repoKey: repoKeyOf(r), branch: r.branch,
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
    return json(res, 200, economy(sinceMs, includeSub, q.get('model') || '', q.get('effort') || '',
      q.get('source') || '', q.get('repo') || ''));
  }

  // one finding, read by a model. Explicitly asked for — it spends the user's
  // own quota, which for a token-economy tool should never happen by surprise.
  if (pathn === '/api/deepen') {
    if (AI_DISABLED) return json(res, 403, { error: 'model analysis is switched off (--no-ai)', disabled: true });
    ensureRollups();
    const q = url.searchParams;
    const id = q.get('id') || '';
    const range = q.get('range') || 'all';
    const sinceMs = range === '7d' ? 7 * 864e5 : range === '30d' ? 30 * 864e5 : 0;
    const includeSub = q.get('subagents') !== '0';
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });

    const a = advice(sinceMs, includeSub, q.get('model') || '', q.get('effort') || '',
      q.get('source') || '', q.get('repo') || '');
    const finding = a.findings.find((f) => f.id === id);
    if (!finding) return json(res, 404, { error: 'no such finding in this slice' });

    const runner = q.get('runner') || 'claude';
    const model = q.get('model2') || '';
    const effort2 = q.get('effort2') || '';
    const key = id + '|' + url.search;
    if (deepCache.has(key)) return json(res, 200, { ...deepCache.get(key), cached: true });

    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const recs = pickSessions(includeSub, q.get('model') || '', q.get('effort') || '',
      q.get('source') || '', q.get('repo') || '')
      .filter((r) => !cutoff || new Date(r.startedAt).getTime() >= cutoff);
    return deepen(finding, recs, a.toolchain, runner, model, effort2, (out) => {
      if (!out.error) deepCache.set(key, out);
      json(res, 200, out);
    });
  }

  // the same slice as /api/economy, read as "what should I change"
  if (pathn === '/api/advice') {
    ensureRollups();
    const q = url.searchParams;
    const range = q.get('range') || 'all';
    const sinceMs = range === '7d' ? 7 * 864e5 : range === '30d' ? 30 * 864e5 : 0;
    const includeSub = q.get('subagents') !== '0';
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, advice(sinceMs, includeSub, q.get('model') || '', q.get('effort') || '',
      q.get('source') || '', q.get('repo') || ''));
  }

  if (pathn === '/api/agents') {
    ensureRollups();
    const q = url.searchParams;
    const sinceMs = q.get('range') === '7d' ? 7 * 864e5 : q.get('range') === '30d' ? 30 * 864e5 : 0;
    const includeSub = q.get('subagents') !== '0';
    const groupBy = ['agent', 'role', 'model', 'effort', 'project'].includes(q.get('by')) ? q.get('by') : 'agent';
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, agents(sinceMs, includeSub, q.get('source') || '', groupBy, q.get('repo') || ''));
  }

  if (pathn === '/api/command') {
    ensureRollups();
    const q = url.searchParams;
    const base = q.get('base');
    const period = PERIODS.includes(q.get('period')) ? q.get('period') : 'week';
    const includeSub = q.get('subagents') !== '0';
    const [from, to] = drillRange(q);
    if (!base) return json(res, 400, { error: 'base required' });
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, commandTrend(base, period, includeSub, q.get('model') || '', q.get('effort') || '',
      q.get('source') || '', from, to, q.get('repo') || ''));
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
  // Warm the inventory off the hot path. It only decides which *optional* extras
  // are offered, so it must never delay serving — and none of it is required for
  // burnboard to do its job.
  setTimeout(() => {
    const tc = detectToolchain();
    console.log(`  optional tools → ${AI_DISABLED ? 'model analysis off (--no-ai)'
      : tc.runners.length ? 'can deepen a finding with ' + tc.runners.map((r) => r.id).join(', ')
      : 'none found; findings stay measurement-only'}`
      + `${tc.filters ? ` · ${tc.filters.tool} ${tc.filters.version}` : ''}`);
  }, 0);
});
