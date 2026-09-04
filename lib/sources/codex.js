'use strict';

// ---------------------------------------------------------------------------
// Codex CLI source — reads ~/.codex/sessions/*.jsonl rollout files.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = function createCodexSource({ argVal }) {
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

  // -- session_index.jsonl -> { id: thread_name } --
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
  function titleFor(id) {
    loadThreadNames();
    return threadNames[id] || null;
  }

  function fileId(filePath) {
    const m = path.basename(filePath).match(/rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
    return m ? m[1] : path.basename(filePath);
  }

  function emptySummary(filePath) {
    return {
      source: 'codex',
      file: filePath,
      id: fileId(filePath),
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
      turns: [],
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

  // Turn one already-JSON.parsed line into a timeline event, for the
  // full-session detail view. Mirrors applyLine's dispatch but returns a
  // display event instead of mutating a running summary.
  function eventFromParsed(o) {
    const p = o.payload || {};
    const ts = o.timestamp;
    if (o.type === 'response_item' && p.type === 'message') {
      const txt = textFromContent(p.content);
      if (txt && !isTagText(txt) && p.role !== 'developer' && p.role !== 'system')
        return { ts, kind: 'message', role: p.role, text: txt.slice(0, 4000) };
    } else if (o.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      return { ts, kind: 'tool', name: p.name || p.type, input: toolInput(p).slice(0, 4000) };
    } else if (o.type === 'response_item' && p.type === 'reasoning' && Array.isArray(p.summary) && p.summary.length) {
      return { ts, kind: 'reasoning', text: p.summary.join('\n').slice(0, 2000) };
    } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
      return { ts, kind: 'tokens', total: p.info.total_token_usage.total_tokens };
    } else if (o.type === 'event_msg' && (p.type === 'task_started' || p.type === 'task_complete')) {
      return { ts, kind: p.type };
    }
    return null;
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
    if (o.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_complete')) {
      sum.turnsCompleted++;
      sum.taskActive = false;
      // Review agents (codex-auto-review) never call a tool, so the command
      // tables have nothing to show for them — keep the turns themselves, with
      // what the agent said, so an expanded panel still has detail.
      sum.turns.push({
        ts: sum.turnStartTs || ts,
        endTs: ts,
        n: sum.curTurn || sum.turnsCompleted,
        text: (sum.lastAssistantText || '').slice(0, 400),
        cum: sum.cumReqTokens || 0,
      });
      if (sum.turns.length > 300) sum.turns.shift();
      return;
    }

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

  // -- directory discovery: sessions/YYYY/MM/DD/*.jsonl --
  function safeReaddir(d) {
    try { return fs.readdirSync(d); } catch (_) { return []; }
  }

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

  function archivedFiles() {
    return safeReaddir(ARCHIVED_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(ARCHIVED_DIR, f));
  }

  function allSessionFiles() {
    const out = [];
    for (const date of availableDates()) out.push(...filesForDate(date));
    out.push(...archivedFiles());
    return out;
  }

  function findFile(uuid) {
    for (const date of availableDates()) {
      for (const fp of filesForDate(date)) {
        if (fileId(fp) === uuid) return fp;
      }
    }
    for (const fp of archivedFiles()) {
      if (fileId(fp) === uuid) return fp;
    }
    return null;
  }

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

  // Lightweight streaming scan — only JSON.parse lines that can matter.
  function scanSession(file, st) {
    return new Promise((resolve) => {
      const rec = {
        source: 'codex',
        id: fileId(file), file, mtime: st.mtimeMs, size: st.size,
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

  return {
    id: 'codex',
    label: 'Codex CLI',
    root: CODEX_ROOT,
    rootWhy: ROOT_WHY,
    watching: SESSIONS_DIR,
    looksLikeHome: () => looksLikeCodexHome(CODEX_ROOT),
    fileId,
    titleFor,
    emptySummary,
    applyLine,
    eventFromParsed,
    toolInput,
    baseCommand,
    availableDates,
    filesForDate,
    recentFiles,
    allSessionFiles,
    findFile,
    scanSession,
  };
};
