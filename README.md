# burnboard

**A live and historical monitor for AI coding agent usage — [OpenAI Codex CLI](https://github.com/openai/codex)
and [Claude Code](https://claude.com/claude-code), side by side.**

burnboard tails the JSONL session transcripts both tools write locally — Codex to
`~/.codex/sessions/`, Claude Code to `~/.claude/projects/` — and turns them into a local web
dashboard. No account access, no API keys, nothing sent anywhere. Zero dependencies, Node stdlib
only.

Every view carries an **All agents / Codex / Claude Code** toggle and a **repository picker**:
see one tool or one codebase in isolation, or everything together in a single combined view with
each session badged by which agent ran it.

- **Activity** — one live panel per active agent, refreshed every ~2s, with a
  billed-token consumption chart, the current command history, per-command token deltas, and a
  quota/usage bar (weekly rate-limit % + tokens today/this week).
- **Subagent lineage** — spawned-by chains up to the root prompt, including Codex's auto-approval
  `guardian` shown nested under the thread it's reviewing.
- **History** — every past session, sortable, with prompt, model, effort, git branch, billed
  tokens and command count, filtered by clicking the period chart above it.
- **Trends** — token consumption bucketed over time, split into two lists (by base command, by
  prompt); click a bar to drill into it, click a row to plot just that command or prompt.
- **Agents** — the same spend cut by *who* spent it, so agent types can be compared on
  efficiency rather than volume.
- **Economy** — a token-waste audit: which commands dump the most output back into context,
  truncation hits, polling/wait round-trips, and commands re-run unchanged.

It also corrects for quirks the raw numbers don't show — Codex's token counter resetting on
context compaction, `total_token_usage` under-counting long sessions, UTC timestamps, JS-wrapped
tool calls, and (on both sides) separating a request's genuinely *new* tokens from the cached
context resent on every turn.

## Run

Requires Node ≥ 18. No dependencies, nothing to install.

```bash
git clone https://github.com/kwpoore-lab/burnboard
cd burnboard
node server.js            # -> http://localhost:4317
```

Options: `--port 8080`, `--root /path/to/.codex`, `--claude-root /path/to/.claude`.

### Finding your data

On startup burnboard locates each agent's home directory and prints what it found. Either source
can be absent — it just shows whichever it finds.

**Codex CLI**, in this order:

1. `--root <dir>`
2. `$CODEX_HOME` (the same variable Codex itself honours)
3. `$XDG_CONFIG_HOME/codex`
4. `~/.codex`, then `~/.config/codex`, then the OS app-support dir

It picks the first one containing a `sessions/` directory.

**Claude Code**, in this order:

1. `--claude-root <dir>`
2. `$CLAUDE_HOME`
3. `~/.claude`

It reads the flat `projects/<project-slug>/<session-id>.jsonl` transcripts underneath.

## What it shows

Five tabs: **Activity**, **History**, **Trends**, **Agents**, **Economy**.

### Reading the charts

Trends, History and the per-command panels share one interaction, so the same two gestures work
everywhere.

**The chart picks *when*.** Every bar is a bucket. Clicking one filters the table below it and
opens the next granularity down, scoped to what you clicked: month → week → day → hour. An hour
is the floor; clicking one filters rather than drilling further. The levels you came through stay
on screen, collapsed, so a sibling bucket is always one click away, with the bar you picked
highlighted. `↺` steps back one level and `clear` returns to everything; both are offered on an
empty slice too, so a stray click is never a dead end.

Bar width follows the bucket count, so three months are readable and ninety days stay narrow.
Below a day, buckets are keyed by the time each *command* ran rather than by session start — but
only as far back as the sources keep per-command timestamps (~24h). Older sub-day ranges fall
back to session start time and say so.

**The table picks *what*.** Clicking a row plots just that command, prompt or invocation in the
charts above, shown as a chip you can clear on its own. The two filters compose: one time slice,
one subject.

### Activity

Refreshed every 2s over Server-Sent Events.

A **usage bar** at the top shows the account's rate-limit windows (% used / % left of the
weekly limit, time to reset — read from Codex's `rate_limits` in the rollout stream), plus
tokens today / this week and the live total. The weekly % is also mirrored into the header
status line.

One panel *per active agent* (any session written to in the last 15s, or mid-turn). Collapsed
by default so many agents fit on one screen; click the ▸ caret to expand.

Subagents show their **lineage** — `spawned by <parent> › <grandparent> › … › this` — walked up
`parent_thread_id` to the root user prompt, each hop clickable. Codex's auto-approval reviewer
appears here as a `guardian` child of the thread whose actions it's vetting.

Collapsed shows: title, age, active-turn flag, a one-line token/ctx/cmd/turn summary,
project · model · effort · tier, the latest message, and the **consumption-over-time chart**
(cumulative tokens as area/line, per-turn tokens as bars).

Expanded adds: cwd + full badges, the full **session prompt** and latest message, the token
breakdown (total / ctx window / in / cached / out / reasoning), and two tables —

- **Commands, latest first**: time · command · Δ tokens (consumed after that step) · running total
- **Consumption by base command**: the same commands grouped by base verb with parameters
  stripped (`git status`, `sed`, `apply_patch`, `rg`, …) — runs + summed Δ tokens, biggest first

"% ctx" is the last request's input tokens over the model context window (real occupancy).

**Billed tokens vs. the raw counter.** Codex's `total_token_usage` is per-context-window: it
drops back to ~0 whenever the conversation is compacted, so a long session's raw counter
sawtooths and *undercounts* the total. burnboard instead tracks its own monotonic running sum of
per-request tokens (`last_token_usage`) — that's the "billed tokens" figure and the consumption
chart's line. Compaction points are marked on the chart with a dashed rule.

Hovering the prompt line (or a card's `$` command line) pops the **full command history for the
current turn** — every command and follow-up the agent has run since the last `task_started`,
with per-step token deltas.

**Other live sessions** — compact cards for everything else touched in the last 15 min,
subagents nested under their parent, dot = 🟢 running / 🟡 idle.

### History

**Hour / Day / Week / Month** toggle, model and effort filters, subagents optional. A
tokens-per-bucket chart sits above the table and is the date filter — click a bar to scope the
table to it and drill into its hours. Opens on the most recent bucket.

Table of every session in that slice (started, thread, prompt, project, model, kind, billed
tokens, commands) with a totals bar. **Click any column header to sort.** Click a row for the
detail panel: full message/tool/reasoning timeline, the consumption chart, base-command
breakdown, metadata.

### Trends

Consumption aggregated over **hour / day / week / month** buckets (toggle top-right; model and
effort filters; optionally include subagents). Shows grand totals, a tokens-per-bucket bar chart,
and two independent lists:

- **By base command** — every base command with its token total for the current slice, run count,
  and a trend sparkline.
- **By prompt** — the same, keyed by each session's opening prompt (near-duplicates merged).

Click a bar to drill into that bucket; click a row to plot just that command or prompt over time
— e.g. how `sed`'s or `apply_patch`'s consumption has moved week to week. Each list has a filter
box.

### Agents

The same spend cut by *who* spent it, so agent types can be compared on efficiency
rather than volume. One row per group — regroup with the toggle: **agent type**
(source · role · model), **role**, **model**, **effort** or **project**.

Per group: sessions, billed tokens and share, tokens per session, commands, tokens
per command, cache hit rate, reasoning share of model output, tool-output share,
truncation rate, and tokens burned re-running identical commands. Rates are shown
only where there is enough of them to mean something.

Expand a row for:

- **What its commands are for** — every base command mapped to a class
  (poll · read · edit · vcs · build · net · agent · other) and stacked into one bar,
  so "reading costs 35% of my tool budget" is legible at a glance
- **Costliest commands** — calls, Δ tokens, output tokens fed back into context,
  truncation count; click any command to open its trend
- **Reading of this agent type** — the numbers in plain language: what it spends on,
  whether the cache is working, clipped output, repeat-run waste, compactions

### Economy

"Where do the tokens go, and what looks wasteful?" — aggregated over all sessions (All time /
30 days / 7 days; subagents included by default).

- **Headline cards**: total command-output tokens read back into context, results truncated at
  the output limit, polling/waiting round-trips (empty `write_stdin` / `wait` / bare
  `exec_command`) as a count and % of all tool calls, and redundant re-runs of unchanged
  commands.
- **By command**: which base commands feed the most text back to the model — tokens, calls,
  avg per call, truncation count. Big + frequent = the best places to add `| tail`, `--quiet`,
  `rg` instead of `cat`, or request specific JSON fields. **Click a row** for a plain-language
  note on what the command does, its trend over time (drillable and plottable per invocation,
  as above), its actual invocations with per-invocation output size and truncation, and — for
  `write_stdin` / `wait` — the underlying processes being polled.
- **Biggest single outputs**, **repeated commands**, and **poll-dominated sessions** — each a
  click-through to the session, with a one-line note on what it means.

Output token counts are estimated (~4 chars/token) from the logged tool results. Model
reasoning is encrypted in the rollout files, so the "why" behind each step isn't available —
only what ran and what came back.

History, Trends, Agents and Economy share a one-time streaming scan of every session file (~40s
for ~1000 sessions; only parses relevant lines), cached to `.cache/rollups.json` and refreshed
incrementally after.

## How it works

Each agent gets its own ingestion module under `lib/sources/` (`codex.js`, `claude.js`) that
knows how to find that tool's session files and parse its line schema. Both emit the same
normalized record shape, so everything downstream — live snapshots, rollups, trends, economy —
is source-agnostic and simply carries a `source` tag through to the UI.

- Incremental tail-read: each file is parsed once, then only newly-appended bytes on each tick
  (the active session file is already >10 MB).
- `source` in `session_meta` is polymorphic — a string for main threads, an object with
  `subagent.thread_spawn` for spawned agents; both are handled.
- `codex-auto-review` turns are tracked as a separate flag, not counted as the primary model.
- Codex tool calls are JS snippets (`tools.exec_command({cmd:"…"})`); `extractCmd()` digs out the
  real shell string (string, array, or template-literal form, plus `apply_patch`).
- Per-command token cost is approximate. For Codex, tokens accrue between a command and the next
  `token_count` event. For Claude Code, one assistant turn's `usage` block covers all of that
  turn's tool calls at once, so the turn's new tokens are split evenly across them.

### Codex vs. Claude Code

|  | Codex CLI | Claude Code |
|---|---|---|
| Location | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.claude/projects/<slug>/<id>.jsonl` |
| Token usage | cumulative counters (`total_token_usage` / `last_token_usage`), reconstructed | self-contained `usage` per assistant turn |
| Tool calls | JS snippets (`tools.exec_command({cmd:"…"})`), unwrapped by `extractCmd()` | structured `tool_use` objects, already parsed |
| Base commands | shell verb from the exec string | tool name (`Read`, `Edit`, …), with `Bash` split into its shell verb |
| Subagents | separate rollout file per subagent, linked by `parent_thread_id` | `isSidechain` turns interleaved in the parent file — folded into the parent's totals for now |
| Compaction | detected (counter resets), marked on the chart | not currently detected |
| Economy signals | full (output tokens, truncation, polling, re-runs) | tool-call counts and token totals; the exec-session polling signals don't apply |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | UI |
| `GET /events` | SSE stream of the live snapshot |
| `GET /api/history` | lightweight rollup rows for the History table (all sessions) |
| `GET /api/sessions?date=YYYY-MM-DD` | full session summaries for one day |
| `GET /api/session/:uuid` | full timeline + summary |
| `GET /api/trends?period=month\|week\|day\|hourly\|slot&subagents=0\|1&source=codex\|claude&from=&to=` | aggregated rollups (`{building:true}` while first scan runs) |
| `GET /api/command?base=&period=…&from=&to=` | one command's series, samples and poll targets |
| `GET /api/agents?range=all\|30d\|7d&by=agent\|role\|model\|effort\|project` | per-agent-type spend, efficiency rates and command-class mix |
| `GET /api/economy?range=all\|30d\|7d&subagents=0\|1&source=codex\|claude` | token-economy signals from the same rollups |
| `GET /api/facets` | the model / effort / repo values the filters offer |

Every session record carries `source` (`"codex"` or `"claude"`). The aggregate endpoints accept
an optional `source=` filter; omit it for the combined view, and an optional `repo=` filter.

`repo=` names a top-level checkout. Sessions run in a git worktree report the worktree directory
rather than the repo, so `<repo>/.codex/worktrees/<branch>` is folded back into `<repo>`, and a
checkout whose sessions never reported a remote is matched to the repo name that sessions from
the same directory *did* report. `GET /api/facets` lists the resulting keys, and the History rows
and live threads carry the same value as `repoKey`.

`from=` / `to=` are epoch milliseconds and scope a request to one clicked bar, which is how the
charts drill down: clicking a month asks for its weeks, a week for its days, a day for its hours.
An hour is as fine as the drill goes — clicking one filters rather than opening a further level.
(`slot`, the 5-minute bucket, still backs the live Hour view.) Below a day the buckets are keyed
by the time each *command* ran rather than by session start — but only as far back as the sources
keep per-command timestamps (24h); older sub-day ranges fall back to session start time and
report `byCommandTime: false`.

## Trademarks

burnboard is an independent, unofficial tool. It is **not affiliated with, endorsed by, or
sponsored by OpenAI or Anthropic**. "OpenAI" and "Codex" are trademarks of OpenAI; "Anthropic"
and "Claude" are trademarks of Anthropic. They are used here only to identify the products this
tool reads data from. The logos shown next to a session are the vendors' own marks (OpenAI's
logomark from OpenAI's GitHub avatar; the Claude mark from claude.ai/favicon.svg), embedded
unmodified apart from colour and used the same way — as a label for whose model ran that prompt,
not as any part of burnboard's own branding.
