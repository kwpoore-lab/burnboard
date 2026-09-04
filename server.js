#!/usr/bin/env node
'use strict';

/*
 * codexmon — live + historical monitor for ~/.codex/sessions
 * Zero dependencies. Node stdlib only.
 *
 *   node server.js [--port 4317] [--root ~/.codex]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

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

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Resolve the Codex home directory. Codex itself honours $CODEX_HOME and
// otherwise uses ~/.codex, so mirror that, then fall back to a few common
// spots and finally a shallow scan. A valid root contains a `sessions/` dir.
function looksLikeCodexHome(dir) {
  try { return fs.statSync(path.join(dir, 'sessions')).isDirectory(); } catch (_) { return false; }
}

function resolveCodexRoot() {
  const home = os.homedir();
  const explicit = argVal('--root', null);
  const candidates = [
    explicit && { dir: expandHome(explicit), src: 'given' },
    process.env.CODEX_HOME && { dir: expandHome(process.env.CODEX_HOME), src: '$CODEX_HOME' },
    process.env.XDG_CONFIG_HOME && { dir: path.join(expandHome(process.env.XDG_CONFIG_HOME), 'codex'), src: '$XDG_CONFIG_HOME/codex' },
    { dir: path.join(home, '.codex'), src: '~/.codex' },
    { dir: path.join(home, '.config', 'codex'), src: '~/.config/codex' },
    process.platform === 'darwin' && { dir: path.join(home, 'Library', 'Application Support', 'codex'), src: 'app support' },
    process.platform === 'win32' && process.env.APPDATA && { dir: path.join(process.env.APPDATA, 'codex'), src: '%APPDATA%' },
    process.platform === 'win32' && process.env.LOCALAPPDATA && { dir: path.join(process.env.LOCALAPPDATA, 'codex'), src: '%LOCALAPPDATA%' },
  ].filter(Boolean);

  for (const c of candidates) {
    if (looksLikeCodexHome(c.dir)) return { root: c.dir, why: c.src };
  }
  // fresh install: a dir that exists but has no sessions/ yet
  for (const c of candidates) {
    try { if (fs.statSync(c.dir).isDirectory()) return { root: c.dir, why: c.src + ' (no sessions yet)' }; } catch (_) {}
  }
  if (explicit) return { root: expandHome(explicit), why: 'given — not found!' };
  return { root: path.join(home, '.codex'), why: 'default — not found, is Codex installed?' };
}

const { root: CODEX_ROOT, why: ROOT_WHY } = resolveCodexRoot();
const SESSIONS_DIR = path.join(CODEX_ROOT, 'sessions');
const ARCHIVED_DIR = path.join(CODEX_ROOT, 'archived_sessions');
const SESSION_INDEX = path.join(CODEX_ROOT, 'session_index.jsonl');

// ---------------------------------------------------------------------------
// session_index.jsonl -> { id: thread_name }
// ---------------------------------------------------------------------------
let threadNames = {};
let threadNamesMtime = 0;
function loadThreadNames() {
  try {
    const st = fs.statSync(SESSION_INDEX);
    if (st.mtimeMs === threadNamesMtime) return;
    threadNamesMtime = st.mtimeMs;
    const out = {};
    for (const line of fs.readFileSync(SESSION_INDEX, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id) out[o.id] = o.thread_name || null;
      } catch (_) {}
    }
    threadNames = out;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// per-file incremental parser
// ---------------------------------------------------------------------------
// cache: filePath -> { offset, remainder, mtimeMs, size, summary }
const cache = new Map();

function fileUuid(filePath) {
  const m = path.basename(filePath).match(/rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return m ? m[1] : path.basename(filePath);
}

function emptySummary(filePath) {
  return {
    file: filePath,
    id: fileUuid(filePath),
    parentId: null,
    depth: 0,
    agentNickname: null,
    isSubagent: false,
    cwd: null,
    project: null,
    git: null,
    originator: null,
    cliVersion: null,
    startedAt: null,
    lastEventAt: null,
    primaryModel: null,
    models: [],
    autoReview: false,
    effort: null,
    personality: null,
    serviceTier: null,
    contextWindow: null,
    tokens: null,          // total_token_usage object
    tokenSeries: [],       // [{t, total, last}]
    lastTotalTokens: 0,
    lastReqTokens: 0,
    lastReqInput: 0,
    lastReqNewTokens: 0,
    messageCount: 0,
    userMessageCount: 0,
    toolCallCount: 0,
    turnsStarted: 0,
    turnsCompleted: 0,
    firstUserText: null,
    lastUserText: null,
    lastAssistantText: null,
    lastExec: null,        // {name, first, ts}
    commands: [],          // [{ts, name, cmd, total, last}] chronological
    taskActive: false,
  };
}

function isTagText(t) {
  return typeof t === 'string' && /^\s*<[a-zA-Z_]/.test(t.trim());
}

const unesc = (s) => s.replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();

// tool-call payloads carry their args as `input` (custom_tool_call) or a JSON
// string `arguments` (function_call).
function toolInput(p) {
  if (typeof p.input === 'string') return p.input;
  if (typeof p.arguments === 'string') return p.arguments;
  return JSON.stringify(p.input || p.arguments || '');
}

// Codex tool inputs are usually JS snippets calling tools.exec_command({...}).
// Dig out the actual shell command; fall back to something readable.
// strip shell wrappers that bury the real command: (cd … &&), leading env
// assignments (VAR=val, possibly with `env` and possibly repeated), bash -lc '…'
function cleanCmd(s) {
  if (!s) return s;
  const orig = s.trim();
  let t = orig;
  const hadParen = /^\(/.test(t);
  t = t.replace(/^\(\s*/, '');
  t = t.replace(/^cd\s+\S+\s*&&\s*/, '');
  let prev;
  do {                                   // peel `env`? VAR=val prefixes one at a time
    prev = t;
    t = t.replace(/^(?:env\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+/, '');
  } while (t !== prev);
  t = t.replace(/^env\s+/, '');
  t = t.replace(/^(?:bash|sh|zsh)\s+-[a-z]*c\s+['"]?/, '').trim();
  if (hadParen) t = t.replace(/\)[\s;]*$/, '').trim();
  return t || orig;
}

const EXEC_TOOLS = new Set(['exec', 'shell', 'local_shell', 'container.exec']);
function extractCmd(name, input) {
  if (!input) return name || '';
  if (/\*\*\*\s*Begin Patch/.test(input) || name === 'apply_patch') return 'apply_patch';
  // a non-shell tool with no embedded command → just name it
  if (name && !EXEC_TOOLS.has(name) && !/["']?(?:cmd|command)["']?\s*:/.test(input)) return name;
  // cmd: "…"  or  "cmd": "…"
  let m = input.match(/["']?cmd["']?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return cleanCmd(unesc(m[1]));
  // cmd: `…` (template literal)
  m = input.match(/["']?cmd["']?\s*:\s*`([^`]*)`/);
  if (m) return cleanCmd(unesc(m[1]));
  // cmd: ["bash","-lc","…"]  or  ["git","status"]
  m = input.match(/["']?cmd["']?\s*:\s*\[([^\]]*)\]/);
  if (m) {
    const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unesc(x[1]));
    if (parts.length) {
      if (/^(?:bash|sh|zsh)$/.test(parts[0]) && /^-[a-z]*c$/.test(parts[1] || '') && parts[2]) return cleanCmd(parts[2]);
      return cleanCmd(parts.join(' '));
    }
  }
  // cmd: '…' (single-quoted)
  m = input.match(/["']?cmd["']?\s*:\s*'((?:[^'\\]|\\.)*)'/);
  if (m) return cleanCmd(unesc(m[1]));
  // command: "…" (some tools)
  m = input.match(/["']?command["']?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return cleanCmd(unesc(m[1]));
  // Codex tool call: `const r = await tools.<toolname>({...})`
  m = input.match(/tools\.([A-Za-z0-9_]+)\s*\(/);
  if (m) return m[1];
  // inline JS scripting with no shell / tool call
  if (/^\s*(const |let |var |text\(|[A-Z_]{3,}\.|await |for \(|if \()/.test(input)) return 'js';
  // last resort: first non-empty, non-boilerplate line
  const line = input.split('\n').map((l) => l.trim())
    .find((l) => l && !/^(const|let|var|await|tools\.|text\(|return|\}|\/\/)/.test(l));
  return cleanCmd(line || input.split('\n')[0].trim());
}

function textFromContent(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const c of content) {
    if (c && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.length ? parts.join('\n') : null;
}

function applyLine(sum, raw) {
  let o;
  try { o = JSON.parse(raw); } catch (_) { return; }
  const p = o.payload || {};
  const ts = o.timestamp || null;
  if (ts) sum.lastEventAt = ts;

  // --- session_meta (line 1) ---
  // Forked/resumed threads replay the PARENT's original session_meta record
  // later in the file (as history context) — only the first session_meta
  // line describes *this* file's own thread; later ones must be ignored or
  // they clobber this thread's id/cwd/git/startedAt with the parent's.
  if (o.type === 'session_meta') {
    if (sum._sawSessionMeta) return;
    sum._sawSessionMeta = true;
    if (p.id) sum.id = p.id;
    sum.cwd = p.cwd || null;
    sum.project = p.cwd ? path.basename(p.cwd) : null;
    sum.originator = p.originator || null;
    sum.cliVersion = p.cli_version || null;
    sum.startedAt = p.timestamp || ts;
    if (p.git && typeof p.git === 'object') {
      sum.git = {
        branch: p.git.branch || null,
        repo: p.git.repository_url
          ? p.git.repository_url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
          : null,
        commit: p.git.commit_hash ? p.git.commit_hash.slice(0, 8) : null,
      };
    }
    const src = p.source;
    if (src && typeof src === 'object' && src.subagent) {
      sum.isSubagent = true;
      const sp = src.subagent.thread_spawn;
      if (sp) {
        sum.parentId = sp.parent_thread_id || p.parent_thread_id || null;
        sum.depth = sp.depth || 1;
        sum.agentNickname = sp.agent_nickname || null;
        sum.agentKind = sp.agent_role || 'subagent';
      }
      // e.g. { subagent: { other: "guardian" } } — Codex's auto-approval reviewer
      if (typeof src.subagent.other === 'string') sum.agentKind = src.subagent.other;
      if (!sum.parentId && p.parent_thread_id && p.parent_thread_id !== sum.id) {
        sum.parentId = p.parent_thread_id;
      }
      if (!sum.depth) sum.depth = 1;
    } else if (p.parent_thread_id && p.parent_thread_id !== sum.id) {
      sum.parentId = p.parent_thread_id;
      sum.isSubagent = true;
      sum.depth = sum.depth || 1;
    }
    return;
  }

  // --- turn context: model / effort ---
  if (o.type === 'turn_context') {
    const m = p.model;
    if (m === 'codex-auto-review') {
      sum.autoReview = true;
    } else if (m) {
      sum.primaryModel = m;
      if (!sum.models.includes(m)) sum.models.push(m);
    }
    if (p.effort) sum.effort = p.effort;
    if (p.personality) sum.personality = p.personality;
    return;
  }

  if (o.type === 'event_msg' && p.type === 'thread_settings_applied') {
    const s = p.thread_settings || {};
    if (s.model && s.model !== 'codex-auto-review') {
      sum.primaryModel = sum.primaryModel || s.model;
      if (!sum.models.includes(s.model)) sum.models.push(s.model);
    }
    if (s.service_tier) sum.serviceTier = s.service_tier;
    return;
  }

  if (o.type === 'event_msg' && p.type === 'token_count') {
    const info = p.info || {};
    if (info.total_token_usage) {
      const newTotal = info.total_token_usage.total_tokens || 0;
      // total_token_usage is a session-cumulative counter (it can occasionally
      // drop on compaction, but otherwise only grows — it is NOT bounded by the
      // context window). Track our own monotonic running sum of per-request
      // tokens (what's actually billed) and flag the reset points.
      const compacted = sum.lastTotalTokens > 1000 && newTotal < sum.lastTotalTokens * 0.5;
      sum.tokens = info.total_token_usage;
      sum.lastTotalTokens = newTotal;
      const lastUsage = info.last_token_usage || {};
      sum.lastReqTokens = lastUsage.total_tokens || 0;
      sum.lastReqInput = lastUsage.input_tokens || sum.lastReqInput;
      // "new" tokens = what this one request actually cost beyond resending
      // cached prior context — input tokens not served from cache, plus output.
      sum.lastReqNewTokens = Math.max(0, (lastUsage.input_tokens || 0) - (lastUsage.cached_input_tokens || 0))
        + (lastUsage.output_tokens || 0);
      sum.cumReqTokens = (sum.cumReqTokens || 0) + sum.lastReqTokens;
      if (compacted) sum.compactions = (sum.compactions || 0) + 1;
      sum.tokenSeries.push({ t: ts, total: newTotal, last: sum.lastReqTokens, cum: sum.cumReqTokens, reset: compacted || undefined });
      if (sum.tokenSeries.length > 4000) sum.tokenSeries.shift();
    }
    if (info.model_context_window) sum.contextWindow = info.model_context_window;
    // rate-limit / quota readout (only present on some token_count events)
    if (p.rate_limits) { sum.rateLimits = p.rate_limits; sum.rateLimitsAt = ts; }
    return;
  }

  if (o.type === 'event_msg' && p.type === 'task_started') {
    sum.turnsStarted++; sum.taskActive = true; sum.curTurn = sum.turnsStarted;
    sum.turnStartTs = ts;
    return;
  }
  if (o.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_complete')) { sum.turnsCompleted++; sum.taskActive = false; return; }

  // --- response items ---
  if (o.type === 'response_item') {
    if (p.type === 'message') {
      sum.messageCount++;
      const txt = textFromContent(p.content);
      if (p.role === 'user') {
        sum.userMessageCount++;
        if (txt && !isTagText(txt)) {
          sum.lastUserText = txt.slice(0, 2000);
          if (!sum.firstUserText) sum.firstUserText = txt.slice(0, 2000);
        }
      } else if (p.role === 'assistant') {
        if (txt) sum.lastAssistantText = txt.slice(0, 600);
      }
      return;
    }
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      sum.toolCallCount++;
      const input = toolInput(p);
      const entry = { ts, name: p.name || p.type, cmd: extractCmd(p.name, input).slice(0, 400),
        total: sum.lastTotalTokens, cum: sum.cumReqTokens || 0, last: sum.lastReqTokens,
        newTokens: sum.lastReqNewTokens || 0, turn: sum.curTurn || 0 };
      sum.lastExec = { name: entry.name, first: entry.cmd, ts };
      sum.commands.push(entry);
      if (sum.commands.length > 300) sum.commands.shift();
      return;
    }
    if (p.type === 'agent_message') {
      const txt = textFromContent(p.content) || p.text;
      if (txt) sum.lastAssistantText = String(txt).slice(0, 600);
    }
  }
}

function refreshFile(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { cache.delete(filePath); return null; }
  let ent = cache.get(filePath);
  if (ent && ent.mtimeMs === st.mtimeMs && ent.size === st.size) {
    ent.summary.mtimeMs = st.mtimeMs;
    return ent.summary;
  }
  if (!ent || st.size < ent.offset) {
    ent = { offset: 0, remainder: '', summary: emptySummary(filePath) };
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
        if (line.trim()) applyLine(ent.summary, line);
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
// directory discovery
// ---------------------------------------------------------------------------
function safeReaddir(d) {
  try { return fs.readdirSync(d); } catch (_) { return []; }
}

// returns array of "YYYY-MM-DD" that have a folder
function availableDates() {
  const dates = [];
  for (const y of safeReaddir(SESSIONS_DIR)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of safeReaddir(path.join(SESSIONS_DIR, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of safeReaddir(path.join(SESSIONS_DIR, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        dates.push(`${y}-${m}-${d}`);
      }
    }
  }
  dates.sort();
  dates.reverse();
  return dates;
}

function filesForDate(date) {
  const [y, m, d] = date.split('-');
  const dir = path.join(SESSIONS_DIR, y, m, d);
  return safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
}

function recentFiles(sinceMs) {
  // Session folders are dated by UTC; scan today + yesterday in BOTH the
  // local and UTC calendars so we never miss the current folder near midnight.
  const now = Date.now();
  const dates = new Set();
  for (let i = 0; i < 2; i++) {
    const dt = new Date(now - i * 86400000);
    dates.add(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
    dates.add(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`);
  }
  const out = [];
  for (const date of dates) {
    for (const fp of filesForDate(date)) {
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs <= sinceMs) out.push({ fp, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// snapshot builders
// ---------------------------------------------------------------------------
// tools whose first arg is a sub-verb worth keeping in the "base command"
const MULTI_VERB = new Set([
  'git', 'cargo', 'npm', 'npx', 'pnpm', 'yarn', 'go', 'docker', 'kubectl', 'gh',
  'poetry', 'pip', 'uv', 'bundle', 'rake', 'make', 'terraform', 'aws', 'systemctl',
  'apt', 'apt-get', 'brew', 'rustup', 'deno', 'bun',
]);

const SHELL_TOOLS = new Set(['exec', 'shell', 'local_shell', 'container.exec', 'exec_command']);
function baseCommand(entry) {
  const name = entry.name || 'exec';
  if (!SHELL_TOOLS.has(name)) return name;
  let s = (entry.cmd || '').trim();
  // a bare shell-tool call with no command = reading more output from a running process
  if (!s || s === name) return name === 'exec_command' ? 'exec_command' : name;
  // unwrap: leading "(cd path &&", "cd path &&", env VAR=val, "bash -lc '...'"
  s = s.replace(/^\(\s*/, '');
  s = s.replace(/^cd\s+\S+\s*&&\s*/, '');
  s = s.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  s = s.replace(/^(?:bash|sh|zsh)\s+-[a-z]*c\s+['"]/, '');
  // take up to first shell operator
  s = s.split(/\s*(?:\||&&|\|\||;|>|<)\s*/)[0].trim();
  const toks = s.split(/\s+/).filter(Boolean);
  if (!toks.length) return name;
  let w1 = toks[0].replace(/^['"]/, '');
  w1 = w1.split('/').pop(); // /usr/bin/git -> git
  if (MULTI_VERB.has(w1) && toks[1] && !toks[1].startsWith('-')) {
    return `${w1} ${toks[1].replace(/[^\w:-].*$/, '')}`;
  }
  return w1;
}

function buildCommands(sum) {
  // per-command tokens = the request's genuinely NEW tokens (input tokens not
  // served from cache, plus output) — e.total and e.cum both resend the full
  // context on every request, so differencing either just reproduces that
  // request's full (mostly-cached) cost, not what this command actually added;
  // running total = the sum of those per-command deltas within the current
  // prompt/turn, resetting to 0 at the start of each new prompt
  let runSum = 0, curTurn = null;
  const out = [];
  for (const e of sum.commands) {
    const delta = e.newTokens || 0;
    if (e.turn !== curTurn) { curTurn = e.turn; runSum = 0; }
    runSum += delta;
    out.push({ ts: e.ts, name: e.name, cmd: e.cmd, base: baseCommand(e),
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
  if (threadNames[id]) out.title = threadNames[id];
  const rec = rollupCache && rollupCache.sessions.get(id);
  if (rec) {
    if (!out.title && rec.prompt) out.title = rec.prompt.slice(0, 80);
    out.kind = rec.agentKind || (rec.isSubagent ? 'subagent' : 'main');
    out.project = rec.project;
  }
  const ent = [...cache.values()].find((e) => e.summary && e.summary.id === id);
  if (ent) {
    const s = ent.summary;
    if (!out.title) out.title = threadNames[id] || s.firstUserText && s.firstUserText.slice(0, 80) || null;
    if (!out.kind) out.kind = s.agentKind || (s.isSubagent ? 'subagent' : 'main');
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
  loadThreadNames();
  const age = Date.now() - (sum.mtimeMs || 0);
  const cmds = full ? buildCommands(sum) : null;
  return {
    id: sum.id,
    title: threadNames[sum.id] || null,
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
    .map(({ fp }) => refreshFile(fp))
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

  return { now: Date.now(), threads: rows, rateLimits, rateLimitsAt: rlAt || null, usage };
}

function historySnapshot(date) {
  const rows = filesForDate(date)
    .map((fp) => refreshFile(fp))
    .filter(Boolean)
    .map((s) => decorate(s, false))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  return { date, threads: rows };
}

// full timeline for one session
function timeline(uuid) {
  // locate the file
  let found = null;
  for (const date of availableDates()) {
    for (const fp of filesForDate(date)) {
      if (fileUuid(fp) === uuid) { found = fp; break; }
    }
    if (found) break;
  }
  if (!found) {
    for (const f of safeReaddir(ARCHIVED_DIR)) {
      if (f.endsWith('.jsonl') && fileUuid(f) === uuid) { found = path.join(ARCHIVED_DIR, f); break; }
    }
  }
  if (!found) return null;

  const sum = emptySummary(found);
  const events = [];
  const raw = fs.readFileSync(found, 'utf8').split('\n');
  for (const line of raw) {
    if (!line.trim()) continue;
    applyLine(sum, line);
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    const p = o.payload || {};
    const ts = o.timestamp;
    if (o.type === 'response_item' && p.type === 'message') {
      const txt = textFromContent(p.content);
      if (txt && !isTagText(txt) && p.role !== 'developer' && p.role !== 'system')
        events.push({ ts, kind: 'message', role: p.role, text: txt.slice(0, 4000) });
    } else if (o.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      events.push({ ts, kind: 'tool', name: p.name || p.type, input: toolInput(p).slice(0, 4000) });
    } else if (o.type === 'response_item' && p.type === 'reasoning' && Array.isArray(p.summary) && p.summary.length) {
      events.push({ ts, kind: 'reasoning', text: p.summary.join('\n').slice(0, 2000) });
    } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
      events.push({ ts, kind: 'tokens', total: p.info.total_token_usage.total_tokens });
    } else if (o.type === 'event_msg' && (p.type === 'task_started' || p.type === 'task_complete')) {
      events.push({ ts, kind: p.type });
    }
  }
  sum.mtimeMs = fs.statSync(found).mtimeMs;
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

function allSessionFiles() {
  const out = [];
  for (const date of availableDates()) out.push(...filesForDate(date));
  for (const f of safeReaddir(ARCHIVED_DIR)) {
    if (f.endsWith('.jsonl')) out.push(path.join(ARCHIVED_DIR, f));
  }
  return out;
}

const ROLLUP_VERSION = 14;   // bump to force a full re-scan when the parser changes
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

// Lightweight streaming scan — only JSON.parse lines that can matter.
function scanSession(file, st) {
  return new Promise((resolve) => {
    const rec = {
      id: fileUuid(file), file, mtime: st.mtimeMs, size: st.size,
      startedAt: null, prompt: null, project: null, isSubagent: false,
      model: null, effort: null, repo: null, branch: null, agentNickname: null, depth: 0,
      parentId: null, agentKind: null,
      autoReview: false, compactions: 0, originator: null,
      totals: { total: 0, input: 0, output: 0, cached: 0, reasoning: 0, billed: 0 },
      cmds: [],
      // economy signals
      toolCalls: 0, pollTurns: 0, outTokens: 0,
      outByBase: {},        // base -> {tokens, calls, truncated}
      bigOutputs: [],        // top few { base, cmd, tokens }
      dupes: {},             // exact cmd -> { count, tokens }
      samples: {},           // base -> { fullCmd -> {count, out, trunc} }
      pollTargets: {},       // cmd of exec sessions that got polled -> count
    };
    let lastTotal = 0, firstUser = null;
    const seq = [];
    const pending = new Map();   // call_id -> { base, cmd, cap, poll }
    const sessionCmd = new Map();  // exec session_id -> the cmd that started it
    const estTok = (s) => Math.ceil((s || 0) / 4);   // ~4 chars/token
    const outText = (o) => Array.isArray(o) ? o.map((x) => (x && x.text) || '').join('')
      : (typeof o === 'string' ? o : (o && (o.text || o.content)) || '');
    let rl;
    try {
      rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    } catch (_) { return resolve(rec); }
    rl.on('line', (line) => {
      if (!line) return;
      const tok = line.indexOf('"token_count"') !== -1;
      const tool = line.indexOf('custom_tool_call') !== -1 || line.indexOf('function_call') !== -1;
      const meta = line.indexOf('"session_meta"') !== -1;
      const tctx = line.indexOf('"turn_context"') !== -1;
      const user = firstUser === null && line.indexOf('"role":"user"') !== -1;
      if (!tok && !tool && !meta && !tctx && !user) return;
      let o; try { o = JSON.parse(line); } catch (_) { return; }
      const p = o.payload || {};
      if (o.type === 'session_meta') {
        rec.startedAt = p.timestamp || o.timestamp;
        rec.project = p.cwd ? path.basename(p.cwd) : null;
        rec.originator = p.originator || null;
        if (p.git && typeof p.git === 'object') {
          rec.branch = p.git.branch || null;
          rec.repo = p.git.repository_url
            ? p.git.repository_url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') : null;
        }
        const src = p.source;
        if (src && typeof src === 'object' && src.subagent) {
          rec.isSubagent = true;
          const sp = src.subagent.thread_spawn;
          if (sp) {
            rec.agentNickname = sp.agent_nickname || null;
            rec.depth = sp.depth || 1;
            rec.parentId = sp.parent_thread_id || p.parent_thread_id || null;
            rec.agentKind = sp.agent_role || 'subagent';
          }
          if (typeof src.subagent.other === 'string') rec.agentKind = src.subagent.other;
        }
        if (!rec.parentId && p.parent_thread_id && p.parent_thread_id !== rec.id) {
          rec.parentId = p.parent_thread_id;
          rec.isSubagent = true;
        }
      } else if (o.type === 'turn_context') {
        if (p.model === 'codex-auto-review') rec.autoReview = true;
        else if (p.model && !rec.model) rec.model = p.model;
        if (p.effort && !rec.effort) rec.effort = p.effort;
      } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
        const u = p.info.total_token_usage;
        if (lastTotal > 1000 && (u.total_tokens || 0) < lastTotal * 0.5) rec.compactions++;
        lastTotal = u.total_tokens || lastTotal;
        rec.totals.total = u.total_tokens || rec.totals.total;
        rec.totals.input = u.input_tokens || rec.totals.input;
        rec.totals.output = u.output_tokens || rec.totals.output;
        rec.totals.cached = u.cached_input_tokens || rec.totals.cached;
        rec.totals.reasoning = u.reasoning_output_tokens || rec.totals.reasoning;
        // monotonic billed total (raw counter resets on context compaction)
        rec.totals.billed = (rec.totals.billed || 0) +
          ((p.info.last_token_usage && p.info.last_token_usage.total_tokens) || 0);
      } else if (o.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
        const input = toolInput(p);
        const cmd = extractCmd(p.name, input);
        const base = baseCommand({ name: p.name, cmd });
        seq.push({ base, total: lastTotal });
        rec.toolCalls++;
        // empty write_stdin / wait / bare exec_command = the agent is just
        // polling output from an already-running process, not doing new work
        const isPoll = (/write_stdin/.test(input) && /chars["'\s:]*["'`]{2}/.test(input))
          || /^wait(_agent)?$/.test(p.name || '')
          || (p.name === 'exec_command' && !/["']?cmd["']?\s*:/.test(input));
        if (isPoll) rec.pollTurns++;
        const capM = input.match(/max_output_tokens["'\s:]*?(\d{3,})/);
        const cap = capM ? +capM[1] : 0;
        const sidM = input.match(/session_id["'\s:]*"?(\d+)/);
        if (p.call_id) pending.set(p.call_id, { base, cmd, cap, poll: isPoll, sid: sidM ? sidM[1] : null });
      } else if (o.type === 'response_item' && (p.type === 'custom_tool_call_output' || p.type === 'function_call_output')) {
        const call = p.call_id && pending.get(p.call_id);
        pending.delete(p.call_id);
        const text = outText(p.output);
        // Codex prints an explicit marker when it clips a command's output
        const tm = text.match(/truncated output \(original token count:\s*(\d+)\)/);
        const t = tm ? +tm[1] : estTok(text.length);
        rec.outTokens += t;
        const base = call ? call.base : 'other';
        const g = rec.outByBase[base] || (rec.outByBase[base] = { tokens: 0, calls: 0, truncated: 0 });
        g.tokens += t; g.calls++;
        const truncated = !!tm || (call && call.cap ? t >= call.cap * 0.9 : t >= 9000);
        if (truncated) g.truncated++;
        // remember which exec session a still-running command opened
        const sidNew = text.match(/"session_id"\s*:\s*(\d+)/);
        if (sidNew && call && call.cmd && !call.poll) sessionCmd.set(sidNew[1], call.cmd.slice(0, 120));

        if (call && call.cmd) {
          if (call.poll && call.sid && sessionCmd.has(call.sid)) {
            const tgt = sessionCmd.get(call.sid);
            const pt = rec.pollTargets[tgt] || (rec.pollTargets[tgt] = { count: 0, out: 0 });
            pt.count++; pt.out += t;
          }
          // per-base sample of the actual command strings
          const s = rec.samples[base] || (rec.samples[base] = {});
          const key = call.cmd.slice(0, 200);
          const e = s[key] || (s[key] = { count: 0, out: 0, trunc: 0 });
          e.count++; e.out += t; if (truncated) e.trunc++;
        }
        const isPoll = base === 'wait' || base === 'wait_agent' || base === 'write_stdin' || base === 'exec_command';
        if (call && t >= 4000 && !isPoll) {
          rec.bigOutputs.push({ base, cmd: call.cmd.slice(0, 160), tokens: t, truncated: !!truncated });
        }
        if (call && call.cmd && !isPoll) {
          const key = call.cmd.slice(0, 200);
          const d = rec.dupes[key] || (rec.dupes[key] = { count: 0, tokens: 0 });
          d.count++; d.tokens += t;
        }
      } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user' && firstUser === null) {
        const txt = textFromContent(p.content);
        if (txt && !isTagText(txt)) firstUser = txt.replace(/\s+/g, ' ').trim().slice(0, 240);
      }
    });
    rl.on('close', () => {
      rec.prompt = firstUser;
      const agg = new Map();
      let prev = null;
      for (const c of seq) {
        let d = 0;
        if (prev != null && c.total >= prev) d = c.total - prev;
        if (c.total > 0) prev = c.total;
        const g = agg.get(c.base) || { base: c.base, tokens: 0, count: 0 };
        g.tokens += d; g.count++;
        agg.set(c.base, g);
      }
      rec.cmds = [...agg.values()];
      rec.bigOutputs.sort((a, b) => b.tokens - a.tokens);
      rec.bigOutputs = rec.bigOutputs.slice(0, 8);
      rec.dupes = Object.entries(rec.dupes)
        .filter(([, v]) => v.count >= 3)
        .map(([cmd, v]) => ({ cmd, count: v.count, tokens: v.tokens }))
        .sort((a, b) => b.tokens - a.tokens).slice(0, 12);
      // keep only the top ~10 distinct command strings per base
      for (const base of Object.keys(rec.samples)) {
        rec.samples[base] = Object.entries(rec.samples[base])
          .map(([cmd, v]) => ({ cmd, count: v.count, out: v.out, trunc: v.trunc }))
          .sort((a, b) => b.out - a.out || b.count - a.count)
          .slice(0, 10);
      }
      rec.pollTargets = Object.entries(rec.pollTargets)
        .map(([cmd, v]) => ({ cmd, count: v.count, out: v.out }))
        .sort((a, b) => b.out - a.out || b.count - a.count).slice(0, 8);
      resolve(rec);
    });
    rl.on('error', () => resolve(rec));
  });
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
    for (const f of files) {
      let st; try { st = fs.statSync(f); } catch (_) { buildProgress.done++; continue; }
      const id = fileUuid(f);
      live.add(id);
      const ex = rollupCache.sessions.get(id);
      if (!ex || ex.mtime !== st.mtimeMs || ex.size !== st.size) {
        rollupCache.sessions.set(id, await scanSession(f, st));
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
  };
}

// filter helper shared by trends / economy / commandTrend
function pickSessions(includeSub, model, effort) {
  return [...rollupCache.sessions.values()].filter((r) =>
    r.startedAt
    && (includeSub || !r.isSubagent)
    && (!model || r.model === model || (model === 'codex-auto-review' && r.autoReview))
    && (!effort || r.effort === effort));
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

function trends(period, includeSub, model, effort) {
  const recs = windowSessions(pickSessions(includeSub, model, effort), period);
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
function economy(sinceMs, includeSub, model, effort) {
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const recs = pickSessions(includeSub, model, effort).filter((r) =>
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
function commandTrend(base, period, includeSub, model, effort) {
  const recs = windowSessions(pickSessions(includeSub, model, effort), period);
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
  try { return fs.readFileSync(INDEX_PATH, 'utf8'); } catch (_) { return '<!doctype html><title>codexmon</title>index.html missing'; }
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
    return json(res, 200, trends(period, includeSub, q.get('model') || '', q.get('effort') || ''));
  }

  if (pathn === '/api/history') {
    ensureRollups();
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    loadThreadNames();
    const rows = [...rollupCache.sessions.values()]
      .filter((r) => r.startedAt)
      .map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        title: threadNames[r.id] || null,
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
    return json(res, 200, economy(sinceMs, includeSub, q.get('model') || '', q.get('effort') || ''));
  }

  if (pathn === '/api/command') {
    ensureRollups();
    const q = url.searchParams;
    const base = q.get('base');
    const period = ['hour', 'day', 'week', 'month'].includes(q.get('period')) ? q.get('period') : 'week';
    const includeSub = q.get('subagents') !== '0';
    if (!base) return json(res, 400, { error: 'base required' });
    if (!rollupReady) return json(res, 200, { building: true, progress: buildProgress });
    return json(res, 200, commandTrend(base, period, includeSub, q.get('model') || '', q.get('effort') || ''));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — codexmon may already be running.`);
    console.error(`open http://localhost:${PORT}, or start on another port:  node server.js --port 4318`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`codexmon → ${CODEX_ROOT}  [${ROOT_WHY}]`);
  if (!looksLikeCodexHome(CODEX_ROOT)) {
    console.warn(`  warning: no "sessions/" dir here. Set CODEX_HOME or pass --root /path/to/.codex`);
  }
  console.log(`  watching ${SESSIONS_DIR}`);
  console.log(`  http://localhost:${PORT}`);
});
