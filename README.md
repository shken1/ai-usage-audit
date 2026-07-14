# ai-usage-audit

A single-file, read-only CLI that analyzes your local [Claude Code](https://claude.com/claude-code) session transcripts (`~/.claude/projects/`) and shows where your tokens actually go: totals by token type, breakdown by model, your most expensive sessions, and the ratios that matter (cache hit ratio, output share, top-model share). It deduplicates streaming rewrites by message id so totals aren't inflated, covers the last 14 days by default, and prints clean terminal tables — or machine-readable JSON with `--json`.

## Privacy promise

- **Read-only.** The script never modifies, moves, or deletes anything. It opens your transcript files with read streams and nothing else.
- **No network.** Zero dependencies, zero telemetry, zero requests. Your data never leaves your machine.
- **Screenshot-safe output.** It never prints prompt or response contents — only aggregate numbers and a first-user-message preview truncated to 60 characters per session.
- **Auditable in one sitting.** All logic lives in one dependency-free TypeScript file, `analyze.ts`. Read it before you run it.

## Usage

No install needed — clone the repo and run:

```sh
npx tsx analyze.ts --days 14
```

or, on Node 22.6+, without any package at all:

```sh
node --experimental-strip-types analyze.ts --days 14
```

Machine-readable output for later reuse:

```sh
npx tsx analyze.ts --json > report.json
```

With `--json`, stdout contains only valid JSON; warnings and notes go to stderr.

| Flag | Default | Meaning |
|------|---------|---------|
| `--days N` | 14 | Aggregation window in days |
| `--json` | off | Dump aggregated data as JSON to stdout |

## Example output

```
Claude Code token usage — last 14 days (2026-06-30 → 2026-07-14)
Scanned 14 session file(s) (46 older files skipped) · 552 messages · 2,118 duplicate usage entries removed

TOTALS
  input                            91,240   0.0%
  output                          884,308   0.4%
  cache_read                  221,916,335   94.0%
  cache_creation               13,288,726   5.6%
  total                       236,180,609
  sidechain (subagents)         2,244,910   1.0% of total

BY MODEL
  model                    total       %        input      output    cache_read  cache_creat
  claude-opus-4-8    126,101,458   53.4%       54,412     502,891   117,481,632    8,062,523
  claude-fable-5     110,079,151   46.6%       36,828     381,417   104,434,703    5,226,203

TOP 5 SESSIONS BY TOTAL TOKENS
      128,449,411   my-big-project                     This session is being continued from a previous conversatio…
       92,113,006   my-big-project                     Help me fix the issues reported by /doctor below. For each …
          617,301   subagents                          Analyze the scheduling engine in /Users/me/Projects/my-big…
          453,705   subagents                          In the file /Users/me/Projects/my-big-project/src/engine.t…
          323,847   ai-usage-audit                     You are helping me build a small read-only CLI tool tonigh…

RATIOS
  cache hit ratio                   99.9%   cache_read / (input + cache_read) — low means caching opportunity
  output share                       0.4%   output / total
  top model share                   53.4%   share of all tokens on claude-opus-4-8
```

## FAQ

**Is it safe to run?**
Yes. It only *reads* JSONL files under `~/.claude/projects/`, makes no network calls, and has no dependencies. The entire tool is one TypeScript file you can audit yourself. If a transcript line is malformed or missing fields, it's skipped and counted, never guessed at.

**What data ends up in the JSON report?**
Aggregate token counts, model names, per-session totals, warnings, and for each top session: the project folder name, session id, and the first user message truncated to 60 characters. Folder names and message previews can reveal what you're working on — skim `report.json` before sharing it publicly.

**Why are my totals dominated by cache reads?**
That's normal for Claude Code: every agentic turn re-reads the cached conversation prefix. A high cache hit ratio is good — a *low* one means you're paying for uncached input that caching could absorb.

**Does it estimate cost?**
Not yet — tokens only. Prices change too often to hardcode; a user-editable pricing map is planned.

## Want me to read it for you?

Generate your report with `--json` and get a plain-English breakdown of where your tokens go — and what to change — at [SITE_URL](SITE_URL).

## License

[MIT](LICENSE) © 2026 Artem Horobchenko
