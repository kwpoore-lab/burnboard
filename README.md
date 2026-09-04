# codexmon

**A live and historical monitor for [OpenAI Codex CLI](https://github.com/openai/codex) usage.**

codexmon tails the JSONL session logs Codex writes to `~/.codex/sessions/` and turns them into a
local web dashboard — no account access, no API keys, nothing to send anywhere. It runs from a
single zero-dependency Node script.

- **Prompts running now** — one live panel per active agent, refreshed every ~2s, with a
  billed-token consumption chart, the current command history, per-command token deltas, and a
  quota/usage bar (weekly rate-limit % + tokens today/this week).
- **Subagent lineage** — spawned-by chains up to the root prompt, including Codex's auto-approval
  `guardian` shown nested under the thread it's reviewing.
- **History** — every past session by day / week / month, sortable, with prompt, model, effort,
  git branch, billed tokens and command count.
- **Trends** — token consumption bucketed over time, split into two lists (by base command, by
  prompt), each drillable to a per-bucket chart.
- **Economy** — a token-waste audit: which commands dump the most output back into context,
  truncation hits, polling/wait round-trips, and commands re-run unchanged.

It also corrects for Codex quirks the raw numbers don't show — the token counter resetting on
context compaction, `total_token_usage` under-counting long sessions, UTC timestamps, and JS-wrapped
tool calls.

## Run

Requires Node ≥ 18. No dependencies, nothing to install.

```bash
git clone https://github.com/kwpoore-lab/codexmon
cd codexmon
node server.js            # -> http://localhost:4317
```

Options: `--port 8080`, `--root /path/to/.codex`.

### Finding your Codex data

On startup codexmon locates your Codex home automatically, in this order:

1. `--root <dir>`
2. `$CODEX_HOME` (the same variable Codex itself honours)
3. `$XDG_CONFIG_HOME/codex`
4. `~/.codex`, then `~/.config/codex`, then the OS app-support dir

It picks the first one containing a `sessions/` directory and prints which it used.
If it can't find one, set `CODEX_HOME` or pass `--root`.

## What it shows

Four tabs: **Running now**, **History**, **Trends**, **Economy**.

### Prompts running now

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
sawtooths and *undercounts* the total. codexmon instead tracks its own monotonic running sum of
per-request tokens (`last_token_usage`) — that's the "billed tokens" figure and the consumption
chart's line. Compaction points are marked on the chart with a dashed rule.

Hovering the prompt line (or a card's `$` command line) pops the **full command history for the
current turn** — every command and follow-up the agent has run since the last `task_started`,
with per-step token deltas.

**Other live sessions** — compact cards for everything else touched in the last 15 min,
subagents nested under their parent, dot = 🟢 running / 🟡 idle.

### History

**Day / Week / Month** toggle + a period picker (subagents optional). Table of every session in
that period (started, thread, prompt, project, model, kind, billed tokens, commands) with a
totals bar. **Click any column header to sort.** Click a row for the detail panel: full
message/tool/reasoning timeline, the consumption chart, base-command breakdown, metadata.

### Trends

Consumption aggregated over **day / week / month** buckets (toggle top-right; optionally include
subagents). Shows grand totals, a tokens-per-bucket bar chart, and two independent lists:

- **By base command** — every base command with its all-time token total, run count, and a trend
  sparkline. Click a row to expand a per-bucket bar chart + table — e.g. how `sed`'s or
  `apply_patch`'s consumption has moved week to week.
- **By prompt** — the same, keyed by each session's opening prompt (near-duplicates merged).

Each list has a filter box.

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
  note on what the command does, its actual invocations (with per-invocation output size and
  truncation), and — for `write_stdin` / `wait` — the underlying processes being polled.
- **Biggest single outputs**, **repeated commands**, and **poll-dominated sessions** — each a
  click-through to the session, with a one-line note on what it means.

Output token counts are estimated (~4 chars/token) from the logged tool results. Model
reasoning is encrypted in the rollout files, so the "why" behind each step isn't available —
only what ran and what came back.

Trends and Economy share a one-time streaming scan of every session file (~40s for ~1000
sessions; only parses relevant lines), cached to `.cache/rollups.json` and refreshed
incrementally after.

## How it works

- Incremental tail-read: each file is parsed once, then only newly-appended bytes on each tick
  (the active session file is already >10 MB).
- `source` in `session_meta` is polymorphic — a string for main threads, an object with
  `subagent.thread_spawn` for spawned agents; both are handled.
- `codex-auto-review` turns are tracked as a separate flag, not counted as the primary model.
- Codex tool calls are JS snippets (`tools.exec_command({cmd:"…"})`); `extractCmd()` digs out the
  real shell string (string, array, or template-literal form, plus `apply_patch`).
- Per-command token cost is approximate: tokens accrue between a command and the next
  `token_count` event and are attributed to the preceding command.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | UI |
| `GET /events` | SSE stream of the live snapshot |
| `GET /api/history` | lightweight rollup rows for the History table (all sessions) |
| `GET /api/sessions?date=YYYY-MM-DD` | full session summaries for one day |
| `GET /api/session/:uuid` | full timeline + summary |
| `GET /api/trends?period=day\|week\|month&subagents=0\|1` | aggregated rollups (`{building:true}` while first scan runs) |
| `GET /api/economy?range=all\|30d\|7d&subagents=0\|1` | token-economy signals from the same rollups |
