'use strict';

// ---------------------------------------------------------------------------
// Claude Code source — reads ~/.claude/projects/<slug>/*.jsonl transcripts.
//
// Unlike Codex, there's no per-context-window "total_token_usage" counter and
// no dedicated session_meta line — cwd/gitBranch/version repeat on almost
// every record instead. Token usage is self-contained per assistant turn
// (input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens)
// so no cumulative-counter reconstruction is needed the way Codex requires.
//
// v1 scope: root-session-level data only. Claude Code marks subagent turns
// via `isSidechain`/`parentUuid` interleaved in the SAME file as the parent
// (unlike Codex's separate-rollout-file-per-subagent model) — those turns'
// tokens/commands are folded into the parent session's totals for now rather
// than split into a separate lineage tree.
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

// how far back per-command timestamps are kept for the short-window views
const RECENT_CMD_MS = 24 * 3600 * 1000;

module.exports = function createClaudeSource({ argVal }) {
  const home = os.homedir();
  const explicit = argVal('--claude-root', null);
  const CLAUDE_ROOT = explicit ? expandHome(explicit)
    : process.env.CLAUDE_HOME ? expandHome(process.env.CLAUDE_HOME)
    : path.join(home, '.claude');
  const PROJECTS_DIR = path.join(CLAUDE_ROOT, 'projects');
  const ROOT_WHY = explicit ? 'given' : process.env.CLAUDE_HOME ? '$CLAUDE_HOME' : '~/.claude';

  function safeReaddir(d) {
    try { return fs.readdirSync(d); } catch (_) { return []; }
  }
  function looksLikeHome() {
    try { return fs.statSync(PROJECTS_DIR).isDirectory(); } catch (_) { return false; }
  }

  function fileId(filePath) {
    return path.basename(filePath, '.jsonl');
  }

  function titleFor() { return null; }   // no rename index for Claude Code sessions

  function emptySummary(filePath) {
    return {
      source: 'claude',
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
      tokens: null,
      tokenSeries: [],
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
      lastExec: null,
      commands: [],
      taskActive: false,
      threadTitle: null,     // from ai-title / custom-title records
    };
  }

  function textFromContent(content) {
    if (!Array.isArray(content)) return null;
    const parts = [];
    for (const c of content) {
      if (c && typeof c.text === 'string') parts.push(c.text);
    }
    return parts.length ? parts.join('\n') : null;
  }

  // tools whose first arg is a sub-verb worth keeping in the "base command"
  const MULTI_VERB = new Set([
    'git', 'cargo', 'npm', 'npx', 'pnpm', 'yarn', 'go', 'docker', 'kubectl', 'gh',
    'poetry', 'pip', 'uv', 'bundle', 'rake', 'make', 'terraform', 'aws', 'systemctl',
    'apt', 'apt-get', 'brew', 'rustup', 'deno', 'bun',
  ]);

  // Claude Code tool inputs are already parsed JSON objects — no shell-string
  // unwrapping needed like Codex's JS-wrapped tool calls require.
  function extractCmd(name, input) {
    if (!input || typeof input !== 'object') return name || '';
    if (typeof input.command === 'string') return input.command;           // Bash
    if (typeof input.file_path === 'string') return `${name} ${input.file_path}`;  // Read/Write/Edit
    if (typeof input.pattern === 'string') return `${name} "${input.pattern}"`;    // Grep/Glob
    if (typeof input.path === 'string') return `${name} ${input.path}`;
    if (typeof input.url === 'string') return `${name} ${input.url}`;              // WebFetch
    if (typeof input.query === 'string') return `${name} "${input.query}"`;        // WebSearch
    if (typeof input.description === 'string') return `${name}: ${input.description}`; // Task
    if (typeof input.prompt === 'string') return `${name}: ${input.prompt.slice(0, 120)}`;
    return name || '';
  }

  // "export FOO=1; pnpm build" is a pnpm run, not an export — step over the
  // setup clauses (exports, bare assignments, cd, source) that precede the
  // command someone actually cares about.
  const SETUP_CLAUSE = /^(?:export\s+(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s*)+|\w+=(?:"[^"]*"|'[^']*'|\S+)|cd\s+\S+|source\s+\S+|\.\s+\S+)\s*(?:;|&&)\s*/;
  function stripSetup(s) {
    let out = String(s || '').trim();
    for (let i = 0; i < 8 && SETUP_CLAUSE.test(out); i++) out = out.replace(SETUP_CLAUSE, '').trim();
    return out || String(s || '').trim();
  }

  function baseCommand(entry) {
    const name = entry.name || 'tool';
    if (name !== 'Bash') return name;
    let s = (entry.cmd || '').trim();
    if (!s) return name;
    s = s.replace(/^\(\s*/, '');
    s = s.replace(/^cd\s+\S+\s*&&\s*/, '');
    s = s.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
    s = stripSetup(s);
    s = s.split(/\s*(?:\||&&|\|\||;|>|<)\s*/)[0].trim();
    const toks = s.split(/\s+/).filter(Boolean);
    if (!toks.length) return name;
    let w1 = toks[0].replace(/^['"]/, '').split('/').pop();
    if (MULTI_VERB.has(w1) && toks[1] && !toks[1].startsWith('-')) {
      return `${w1} ${toks[1].replace(/[^\w:-].*$/, '')}`;
    }
    return w1;
  }

  function applyLine(sum, raw) {
    let o;
    try { o = JSON.parse(raw); } catch (_) { return; }
    const ts = o.timestamp || null;
    if (ts) sum.lastEventAt = ts;

    // identity fields (cwd/gitBranch/version) repeat on almost every line —
    // grab them the first time we see them rather than waiting for a
    // dedicated meta line, which doesn't exist in this schema.
    if (!sum._sawIdentity && o.cwd) {
      sum._sawIdentity = true;
      sum.cwd = o.cwd;
      sum.project = path.basename(o.cwd);
      sum.cliVersion = o.version || null;
      if (o.gitBranch) sum.git = { branch: o.gitBranch, repo: null, commit: null };
      sum.startedAt = sum.startedAt || ts;
    }

    // Session titles live in the transcript itself (Codex keeps them in a
    // separate session_index.jsonl). A user-set title wins over the generated
    // one; both are re-emitted as they change, so last write wins.
    if (o.type === 'custom-title' && o.customTitle) {
      sum._customTitle = o.customTitle;
      sum.threadTitle = o.customTitle;
      return;
    }
    if (o.type === 'ai-title' && o.aiTitle) {
      sum._aiTitle = o.aiTitle;
      if (!sum._customTitle) sum.threadTitle = o.aiTitle;
      return;
    }

    if (o.type === 'user') {
      const content = o.message && o.message.content;
      const txt = textFromContent(content);
      const hasToolResult = Array.isArray(content) && content.some((c) => c && c.type === 'tool_result');
      if (txt && !hasToolResult) {
        sum.messageCount++;
        sum.userMessageCount++;
        sum.lastUserText = txt.slice(0, 2000);
        if (!sum.firstUserText) sum.firstUserText = txt.slice(0, 2000);
        sum.turnsStarted++; sum.curTurn = sum.turnsStarted; sum.taskActive = true;
      }
      return;
    }

    if (o.type === 'assistant') {
      const msg = o.message || {};
      if (msg.model) {
        sum.primaryModel = sum.primaryModel || msg.model;
        if (!sum.models.includes(msg.model)) sum.models.push(msg.model);
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      const txt = textFromContent(content);
      if (txt) { sum.lastAssistantText = txt.slice(0, 600); sum.messageCount++; }

      if (msg.usage) {
        const u = msg.usage;
        const inputNew = u.input_tokens || 0;
        const cacheCreate = u.cache_creation_input_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        const output = u.output_tokens || 0;
        sum.lastReqTokens = inputNew + cacheCreate + cacheRead + output;
        sum.lastReqInput = inputNew + cacheCreate + cacheRead;
        // "new" tokens this turn = everything except the cheap cache-read reuse
        sum.lastReqNewTokens = inputNew + cacheCreate + output;
        sum.lastTotalTokens = sum.lastReqInput;   // approximates current context size
        sum.cumReqTokens = (sum.cumReqTokens || 0) + sum.lastReqTokens;
        sum.tokenSeries.push({ t: ts, total: sum.lastTotalTokens, last: sum.lastReqTokens, cum: sum.cumReqTokens });
        if (sum.tokenSeries.length > 4000) sum.tokenSeries.shift();
      }

      // one assistant message's usage covers ALL of its tool calls together —
      // split the "new tokens" evenly across them so the per-command Tokens
      // column doesn't multiply-count a shared usage block.
      const toolUses = content.filter((c) => c && c.type === 'tool_use');
      const perToolNew = toolUses.length ? sum.lastReqNewTokens / toolUses.length : 0;
      for (const c of toolUses) {
        sum.toolCallCount++;
        const cmd = extractCmd(c.name, c.input).slice(0, 400);
        const entry = { ts, name: c.name || 'tool', cmd,
          total: sum.lastTotalTokens, cum: sum.cumReqTokens || 0, last: sum.lastReqTokens,
          newTokens: Math.round(perToolNew), turn: sum.curTurn || 0 };
        sum.lastExec = { name: entry.name, first: entry.cmd, ts };
        sum.commands.push(entry);
        if (sum.commands.length > 300) sum.commands.shift();
      }

      if (msg.stop_reason && msg.stop_reason !== 'tool_use') {
        sum.turnsCompleted++; sum.taskActive = false;
      }
    }
    // ignore: queue-operation, attachment, file-history-snapshot, last-prompt, etc.
  }

  // Turn one already-JSON.parsed line into a timeline event, for the
  // full-session detail view.
  function eventFromParsed(o) {
    const ts = o.timestamp;
    if (o.type === 'user') {
      const content = o.message && o.message.content;
      const txt = textFromContent(content);
      const toolResult = Array.isArray(content) && content.find((c) => c && c.type === 'tool_result');
      if (txt && !toolResult) return { ts, kind: 'message', role: 'user', text: txt.slice(0, 4000) };
      if (toolResult) {
        const out = typeof toolResult.content === 'string' ? toolResult.content : (textFromContent(toolResult.content) || '');
        return { ts, kind: 'tool_result', text: String(out).slice(0, 4000) };
      }
    } else if (o.type === 'assistant') {
      const msg = o.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolUses = content.filter((c) => c && c.type === 'tool_use');
      if (toolUses.length) {
        return { ts, kind: 'tool', name: toolUses.map((t) => t.name).join(', '),
          input: toolUses.map((t) => JSON.stringify(t.input)).join('\n').slice(0, 4000) };
      }
      const txt = textFromContent(content);
      if (txt) return { ts, kind: 'message', role: 'assistant', text: txt.slice(0, 4000) };
      if (msg.usage) {
        const u = msg.usage;
        const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        return { ts, kind: 'tokens', total };
      }
    }
    return null;
  }

  // -- directory discovery: flat ~/.claude/projects/<slug>/*.jsonl, no date folders --
  function allProjectFiles() {
    const out = [];
    for (const slug of safeReaddir(PROJECTS_DIR)) {
      const dir = path.join(PROJECTS_DIR, slug);
      let st; try { st = fs.statSync(dir); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      for (const f of safeReaddir(dir)) {
        if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
      }
    }
    return out;
  }

  function dateKeyOf(mtimeMs) {
    const d = new Date(mtimeMs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function availableDates() {
    const dates = new Set();
    for (const fp of allProjectFiles()) {
      let st; try { st = fs.statSync(fp); } catch (_) { continue; }
      dates.add(dateKeyOf(st.mtimeMs));
    }
    return [...dates].sort().reverse();
  }

  function filesForDate(date) {
    return allProjectFiles().filter((fp) => {
      let st; try { st = fs.statSync(fp); } catch (_) { return false; }
      return dateKeyOf(st.mtimeMs) === date;
    });
  }

  function recentFiles(sinceMs) {
    const now = Date.now();
    const out = [];
    for (const fp of allProjectFiles()) {
      let st; try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs <= sinceMs) out.push({ fp, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  function allSessionFiles() {
    return allProjectFiles();
  }

  function findFile(uuid) {
    for (const slug of safeReaddir(PROJECTS_DIR)) {
      const fp = path.join(PROJECTS_DIR, slug, uuid + '.jsonl');
      if (fs.existsSync(fp)) return fp;
    }
    return null;
  }

  // Lightweight streaming scan for the trends/economy rollup cache — mirrors
  // the shape codex.js's scanSession produces so the generic rollup/trends/
  // economy aggregation code downstream needs no source-specific branches.
  function scanSession(file, st) {
    return new Promise((resolve) => {
      const rec = {
        source: 'claude',
        id: fileId(file), file, mtime: st.mtimeMs, size: st.size,
        startedAt: null, prompt: null, title: null, project: null, isSubagent: false,
        model: null, effort: null, repo: null, branch: null, agentNickname: null, depth: 0,
        parentId: null, agentKind: null,
        autoReview: false, compactions: 0, originator: null,
        totals: { total: 0, input: 0, output: 0, cached: 0, reasoning: 0, billed: 0 },
        cmds: [],
        recentCmds: [],    // { t, b(ase), k=Δ tokens, o=output tokens, tr, c(md) } for the last day
        toolCalls: 0, pollTurns: 0, outTokens: 0,
        outByBase: {}, bigOutputs: [], dupes: {}, samples: {}, pollTargets: {},
      };
      let firstUser = null, aiTitle = null, customTitle = null;
      const cmdAgg = new Map();
      const pending = new Map();   // tool_use id -> { base, cmd, ri (index into recentCmds) }
      const recentCut = Date.now() - RECENT_CMD_MS;
      const estTok = (s) => Math.ceil((s || 0) / 4);   // ~4 chars/token
      // tool_result content is usually a plain string, occasionally a list of
      // {type:'text'} / {type:'tool_reference'} parts.
      const outText = (c) => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((x) => (x && (x.text || x.tool_name)) || '').join('');
        return (c && (c.text || c.content)) || '';
      };
      let rl;
      try {
        rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      } catch (_) { return resolve(rec); }
      rl.on('line', (line) => {
        if (!line) return;
        let o; try { o = JSON.parse(line); } catch (_) { return; }
        if (!rec.startedAt && o.cwd) {
          rec.startedAt = o.timestamp || rec.startedAt;
          rec.project = path.basename(o.cwd);
          rec.branch = o.gitBranch || rec.branch;
        }
        if (o.type === 'custom-title' && o.customTitle) { customTitle = o.customTitle; return; }
        if (o.type === 'ai-title' && o.aiTitle) { aiTitle = o.aiTitle; return; }
        if (o.type === 'user') {
          const content = o.message && o.message.content;
          if (firstUser === null) {
            const txt = textFromContent(content);
            const hasToolResult = Array.isArray(content) && content.some((c) => c && c.type === 'tool_result');
            if (txt && !hasToolResult) firstUser = txt.replace(/\s+/g, ' ').trim().slice(0, 240);
          }
          // tool results come back on a *user* record, correlated to the call
          // that produced them by tool_use_id
          for (const it of (Array.isArray(content) ? content : [])) {
            if (!it || it.type !== 'tool_result') continue;
            const call = pending.get(it.tool_use_id);
            pending.delete(it.tool_use_id);
            const text = outText(it.content);
            const t = estTok(text.length);
            rec.outTokens += t;
            const base = call ? call.base : 'other';
            const g = rec.outByBase[base] || (rec.outByBase[base] = { tokens: 0, calls: 0, truncated: 0 });
            g.tokens += t; g.calls++;
            // Claude Code clips long results with an explicit marker
            const truncated = /\[[\d,]+ (?:lines|characters) truncated/.test(text);
            if (truncated) g.truncated++;
            if (call && call.ri !== undefined && rec.recentCmds[call.ri]) {
              rec.recentCmds[call.ri].o += t;
              if (truncated) rec.recentCmds[call.ri].tr = 1;
            }
            if (call && call.cmd) {
              const key = call.cmd.slice(0, 200);
              const s = rec.samples[base] || (rec.samples[base] = {});
              const e = s[key] || (s[key] = { count: 0, out: 0, trunc: 0 });
              e.count++; e.out += t; if (truncated) e.trunc++;
              if (t >= 4000) rec.bigOutputs.push({ base, cmd: call.cmd.slice(0, 160), tokens: t, truncated });
              const d = rec.dupes[key] || (rec.dupes[key] = { count: 0, tokens: 0 });
              d.count++; d.tokens += t;
            }
          }
        }
        if (o.type === 'assistant') {
          const msg = o.message || {};
          if (msg.model && !rec.model) rec.model = msg.model;
          let newTokensThisTurn = 0;
          if (msg.usage) {
            const u = msg.usage;
            const inputNew = u.input_tokens || 0;
            const cacheCreate = u.cache_creation_input_tokens || 0;
            const cacheRead = u.cache_read_input_tokens || 0;
            const output = u.output_tokens || 0;
            rec.totals.input += inputNew + cacheCreate;
            rec.totals.output += output;
            rec.totals.cached += cacheRead;
            rec.totals.reasoning += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
            rec.totals.billed += inputNew + cacheCreate + cacheRead + output;
            newTokensThisTurn = inputNew + cacheCreate + output;
          }
          const content = Array.isArray(msg.content) ? msg.content : [];
          const toolUses = content.filter((c) => c && c.type === 'tool_use');
          const perToolNew = toolUses.length ? newTokensThisTurn / toolUses.length : 0;
          for (const c of toolUses) {
            rec.toolCalls++;
            const cmd = extractCmd(c.name, c.input);
            const base = baseCommand({ name: c.name, cmd });
            const g = cmdAgg.get(base) || { base, tokens: 0, count: 0 };
            g.tokens += perToolNew; g.count++;
            cmdAgg.set(base, g);
            let ri;
            if (o.timestamp && Date.parse(o.timestamp) >= recentCut) {
              ri = rec.recentCmds.push({ t: o.timestamp, b: base, k: perToolNew, o: 0, tr: 0, c: String(cmd || '').slice(0, 200) }) - 1;
            }
            if (c.id) pending.set(c.id, { base, cmd, ri });
          }
        }
      });
      rl.on('close', () => {
        rec.prompt = firstUser;
        rec.title = customTitle || aiTitle;
        rec.totals.total = rec.totals.input + rec.totals.output + rec.totals.cached;
        rec.cmds = [...cmdAgg.values()];
        if (rec.recentCmds.length > 3000) rec.recentCmds = rec.recentCmds.slice(-3000);
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
        // Claude Code's Bash is stateless per call — there's no equivalent of
        // Codex's persistent exec sessions being polled via write_stdin/wait.
        rec.pollTargets = [];
        resolve(rec);
      });
      rl.on('error', () => resolve(rec));
    });
  }

  // Claude Code caches the account's usage windows in ~/.claude.json (the file
  // that sits next to the ~/.claude directory) and refreshes them as it runs;
  // the transcripts themselves carry no quota. Shaped like Codex's rate_limits
  // so the UI can render both the same way.
  const CONFIG_PATH = CLAUDE_ROOT + '.json';
  let quotaCache = { mtimeMs: -1, data: null };
  const QUOTA_WINDOWS = [
    ['five_hour', 300],
    ['seven_day', 10080],
  ];
  function quota() {
    let st;
    try { st = fs.statSync(CONFIG_PATH); } catch (_) { return null; }
    if (st.mtimeMs === quotaCache.mtimeMs) return quotaCache.data;
    let data = null;
    try {
      const cached = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).cachedUsageUtilization;
      const u = cached && cached.utilization;
      if (u) {
        const windows = QUOTA_WINDOWS
          .map(([key, mins]) => {
            const w = u[key];
            return w && typeof w.utilization === 'number'
              ? { used_percent: w.utilization, window_minutes: mins, resets_at: w.resets_at || null }
              : null;
          })
          .filter(Boolean);
        if (windows.length) data = { windows, fetchedAtMs: cached.fetchedAtMs || null };
      }
    } catch (_) { data = null; }
    quotaCache = { mtimeMs: st.mtimeMs, data };
    return data;
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    quota,
    root: CLAUDE_ROOT,
    rootWhy: ROOT_WHY,
    watching: PROJECTS_DIR,
    looksLikeHome,
    fileId,
    titleFor,
    emptySummary,
    applyLine,
    eventFromParsed,
    toolInput: () => '',
    baseCommand,
    availableDates,
    filesForDate,
    recentFiles,
    allSessionFiles,
    findFile,
    scanSession,
  };
};
