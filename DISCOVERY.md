# ContextClues — Claude CLI Data Discovery

Investigation performed 2026-08-24 against **Claude Code 2.1.241** on macOS (darwin), Node v22.22.1.
Every field listed below was verified against real files on this machine. Nothing here is assumed
from documentation alone; where we infer rather than observe, it is called out.

## 1. Where Claude CLI keeps session data

| Path | What it is | Access |
|---|---|---|
| `~/.claude/sessions/<pid>.json` | **Live session registry.** One JSON file per running (or recently exited) CLI process: `pid`, `sessionId`, `cwd`, `startedAt`, `version`, `kind` (`interactive` \| `bg`), `name`, `status` (`busy`, `shell`, …), `updatedAt`. | read-only |
| `~/.claude/projects/<munged-cwd>/<sessionId>.jsonl` | **Full transcript** (append-only JSONL), one record per event. The munged dir name replaces non-alphanumerics with `-`; we do **not** rely on the munging algorithm — we locate transcripts by globbing for `<sessionId>.jsonl`. | read-only |
| `~/.claude.json` | Global CLI state: `projects.<cwd>` (per-project `mcpServers`, `allowedTools`, `enabledMcpjsonServers`, …), global `mcpServers`. | read-only |
| `~/.claude/settings.json` | User settings: `hooks`, `permissions`, `model`, `enabledPlugins`, `statusLine`. | read-only |
| `<project>/.mcp.json`, `<project>/.claude/settings.json` | Project-scoped MCP servers / settings, when present. | read-only |
| `~/.claude/plugins/installed_plugins.json` | Installed plugins per marketplace. | read-only |
| `~/.claude/skills/` | User-level skills (one directory per skill). | read-only |

## 2. Transcript record types (observed)

Common envelope on most records: `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`,
`gitBranch`, `isSidechain`, `version`, `type`.

| `type` | Contents |
|---|---|
| `user` | `message.content` is a **string** (real user prompt) or an array of `tool_result` blocks. Tool results also carry a structured `toolUseResult` (e.g. `{stdout, stderr, interrupted, isImage}` for Bash). Compaction summaries are `user` records with `isCompactSummary: true`. |
| `assistant` | `message.content` blocks (`text`, `thinking`, `tool_use {id, name, input}`), `message.model`, and — critically — **`message.usage`**: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens` (+ thinking-token detail). |
| `attachment` | Context injected by the harness. Observed `attachment.type` values: `hook_success`, `hook_additional_context`, `deferred_tools_delta` (`addedNames`, `removedNames`, `readdedNames`, `pendingMcpServers`), `agent_listing_delta`, `mcp_instructions_delta`, `skill_listing` (`names`, `skillCount`, `content`), `total_tokens_reminder` (session token budget). |
| `system` | Subtypes observed: `turn_duration`, `local_command` (slash-command I/O), `stop_hook_summary`, and **`compact_boundary`** with `compactMetadata`: `trigger` (`auto`/`manual`), `preTokens`, `postTokens`, `cumulativeDroppedTokens`, `preCompactDiscoveredTools`, `preservedMessages.uuids`. |
| `file-history-snapshot`, `ai-title`, `atis-latch`, `bridge-session`, `last-prompt`, `mode`, `permission-mode` | CLI bookkeeping. Not part of what is sent to the model. |

## 3. What can be known about context usage

**Observed (high confidence):** each assistant turn's `message.usage`. Context occupied at that
turn = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; adding that turn's
`output_tokens` approximates the context entering the *next* turn. This is the API's own count,
not an estimate — but it is a snapshot as of the **last assistant turn**, so we timestamp it.

**Observed (exact):** compaction events — `compactMetadata.preTokens/postTokens` gives the exact
token drop, and `preservedMessages.uuids` tells us which records survived.

**Estimated:** per-entry token attribution. The transcript stores content, not per-message token
counts, so entry sizes use a `chars/4` heuristic and are always labeled *estimated*.

**Inferred:** the system-prompt + tool-schema overhead. It never appears in the transcript; we
infer it as `first turn's observed usage − estimate of the first user message + injected context`.

**Assumed:** the maximum context window. No local file exposes it (`autoCompactWindowsCache` was
absent). We map model id → window size (default 200k, `[1m]` models → 1M) and label it *assumed*.

**Not available, and not claimed:** Claude's hidden reasoning, server-side truncation decisions,
or exact per-message context membership between compactions. The UI labels membership as
*assumed-included* (after the last compaction boundary), *compacted-out*, or *not sent to model*.

## 4. Collection mechanism decision

1. **Primary: read-only parsing of the session registry + transcript JSONL**, tailed
   incrementally with a file watcher. Zero configuration changes, works with any running session.
2. **Hooks were considered and deferred.** Claude Code supports hooks (`settings.json → hooks`),
   which would give push-style events — but installing one **modifies user configuration**, which
   this project's constraints forbid doing automatically. The README documents an optional
   hook the user may add themselves in a later iteration; the MVP does not require it.
3. **No writes, ever**: all Claude files are opened read-only; ContextClues state lives in its own
   SQLite database under `./.data/`.
