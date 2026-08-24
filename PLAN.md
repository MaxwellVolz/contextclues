# ContextClues — Implementation Plan (MVP)

Goal: detect one active Claude CLI session, show observed context usage, break it down,
list tools, and update live. Local-first, read-only against Claude's files.

## Architecture

One Next.js (App Router, TypeScript, Tailwind v4) process. The collector runs inside the
Next server as a lazily-initialized singleton — no second daemon to manage.

```
~/.claude/sessions/*.json ──┐   chokidar    ┌─ SQLite (node:sqlite, ./.data/contextclues.db)
~/.claude/projects/**.jsonl ├──▶ collector ──┤
~/.claude.json, settings,   │   (read-only)  └─ event bus ──▶ /api/stream (SSE) ──▶ UI refetch
.mcp.json, plugins, skills ─┘
```

- `lib/registry.ts` — enumerate live sessions (`sessions/<pid>.json` + pid liveness) and recent
  transcripts; resolve `sessionId → *.jsonl` by glob, never by re-implementing path munging.
- `lib/transcript.ts` — incremental JSONL parser (byte-offset tail). Normalizes each line into an
  `EvidenceRow`: category, est. tokens (chars/4), tool linkage, redacted preview, inclusion status.
- `lib/toolsource.ts` — tool registry: built-ins (static list, labeled assumed), transcript
  observations (`tool_use`, `deferred_tools_delta`, `skill_listing`), MCP config, plugins, skills.
- `lib/casefile.ts` — pure derivation of the API payload: meter, composition, evidence, tools,
  activity timeline, clues.
- `lib/clues.ts` — rule engine (large evidence, duplicate file loads, compaction, unused tools,
  window pressure, stale heavy evidence).
- `lib/redact.ts` — secret patterns scrubbed before anything is stored or rendered.
- `lib/db.ts` — schema: `sessions`, `events` (PK `session_id, line_no`), `ingest_state`.
- `app/api/cases` (list), `app/api/case/[id]` (full case file), `app/api/stream` (SSE).
- UI: one dashboard page — CasePicker, ContextMeter, Composition, CluesPanel, EvidenceExplorer,
  ToolRegistry, ActivityFeed. Dark forensic-board identity, restrained.

## Order of work

1. Scaffold Next + Tailwind by hand (deterministic, no interactive CLI).
2. Pure libs (estimate, redact, transcript normalize, clues) + `node --test` unit tests.
3. DB + collector + API routes; verify with curl against this machine's real sessions.
4. UI + SSE live updates.
5. Run, verify primary flow end-to-end, README.

## Non-goals (MVP)

Hook installation, historical analytics across sessions, subagent trees, generalized memory
infrastructure, editing anything under `~/.claude`.
