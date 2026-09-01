// SQLite persistence via Node's built-in node:sqlite (no native build step).
// ContextClues' own state lives in ~/.contextclues. Claude's files are never written.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "./transcript.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  cwd TEXT, name TEXT, pid INTEGER, kind TEXT, status TEXT,
  live INTEGER DEFAULT 0,
  started_at INTEGER, updated_at INTEGER,
  transcript_path TEXT, cli_version TEXT, model TEXT
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  uuid TEXT, ts TEXT,
  type TEXT, subtype TEXT, category TEXT,
  chars INTEGER, est_tokens INTEGER, preview TEXT,
  tool_name TEXT, tool_use_id TEXT, file_path TEXT,
  is_sidechain INTEGER, is_compact_summary INTEGER,
  extra TEXT,
  PRIMARY KEY (session_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE TABLE IF NOT EXISTS tool_uses (
  tool_use_id TEXT PRIMARY KEY,
  session_id TEXT, line_no INTEGER, ts TEXT,
  name TEXT, file_path TEXT,
  input_preview TEXT,
  result_chars INTEGER, result_line_no INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_uses_session ON tool_uses(session_id);
CREATE TABLE IF NOT EXISTS ingest_state (
  session_id TEXT PRIMARY KEY,
  transcript_path TEXT, byte_offset INTEGER, line_no INTEGER
);
`;

export interface SessionRow {
  session_id: string;
  cwd: string | null;
  name: string | null;
  pid: number | null;
  kind: string | null;
  status: string | null;
  live: number;
  started_at: number | null;
  updated_at: number | null;
  transcript_path: string | null;
  cli_version: string | null;
  model: string | null;
}

export interface EventRow {
  session_id: string;
  line_no: number;
  uuid: string | null;
  ts: string | null;
  type: string;
  subtype: string | null;
  category: string;
  chars: number;
  est_tokens: number;
  preview: string;
  tool_name: string | null;
  tool_use_id: string | null;
  file_path: string | null;
  is_sidechain: number;
  is_compact_summary: number;
  extra: string | null;
}

export interface ToolUseRow {
  tool_use_id: string;
  session_id: string;
  line_no: number;
  ts: string | null;
  name: string;
  file_path: string | null;
  input_preview: string;
  result_chars: number | null;
  result_line_no: number | null;
}

export interface IngestState {
  session_id: string;
  transcript_path: string;
  byte_offset: number;
  line_no: number;
}

class Db {
  db: DatabaseSync;
  /**
   * Prepared-statement cache. Ingest runs one INSERT per transcript line, so
   * re-preparing the same SQL for every line dominates the cost of a large
   * backfill. Every statement here has fixed SQL, so the cache is bounded by
   * the number of distinct queries in this file.
   */
  private statements = new Map<string, StatementSync>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "contextclues.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  upsertSession(s: Partial<SessionRow> & { session_id: string }): void {
    this.stmt(
      `INSERT INTO sessions (session_id, cwd, name, pid, kind, status, live, started_at, updated_at, transcript_path, cli_version, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         cwd = COALESCE(excluded.cwd, cwd),
         name = COALESCE(excluded.name, name),
         pid = COALESCE(excluded.pid, pid),
         kind = COALESCE(excluded.kind, kind),
         status = COALESCE(excluded.status, status),
         live = COALESCE(excluded.live, live),
         started_at = COALESCE(excluded.started_at, started_at),
         updated_at = COALESCE(excluded.updated_at, updated_at),
         transcript_path = COALESCE(excluded.transcript_path, transcript_path),
         cli_version = COALESCE(excluded.cli_version, cli_version),
         model = COALESCE(excluded.model, model)`,
    ).run(
      s.session_id,
      s.cwd ?? null,
      s.name ?? null,
      s.pid ?? null,
      s.kind ?? null,
      s.status ?? null,
      s.live ?? null,
      s.started_at ?? null,
      s.updated_at ?? null,
      s.transcript_path ?? null,
      s.cli_version ?? null,
      s.model ?? null,
    );
  }

  setSessionModel(sessionId: string, model: string): void {
    this.stmt(`UPDATE sessions SET model = ? WHERE session_id = ?`).run(model, sessionId);
  }

  markSessionsNotLive(livePids: number[]): void {
    // Any session whose pid is no longer alive gets live=0. The placeholder count
    // varies with the number of live sessions, so this statement is not cached.
    const placeholders = livePids.map(() => "?").join(",");
    const sql = livePids.length
      ? `UPDATE sessions SET live = 0 WHERE pid IS NULL OR pid NOT IN (${placeholders})`
      : `UPDATE sessions SET live = 0`;
    this.db.prepare(sql).run(...livePids);
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.stmt(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as
      | SessionRow
      | undefined;
  }

  listSessions(limit = 30): SessionRow[] {
    return this.stmt(
      `SELECT * FROM sessions ORDER BY live DESC, updated_at DESC LIMIT ?`,
    ).all(limit) as unknown as SessionRow[];
  }

  /**
   * Event counts for every indexed session in one grouped scan, rather than a
   * COUNT(*) per session — the case list needs all of them at once.
   */
  eventCounts(): Map<string, number> {
    const rows = this.stmt(
      `SELECT session_id, COUNT(*) AS n FROM events GROUP BY session_id`,
    ).all() as unknown as { session_id: string; n: number }[];
    return new Map(rows.map((r) => [r.session_id, r.n]));
  }

  insertEvent(sessionId: string, e: NormalizedEvent): void {
    // tool_name and file_path are resolved later by setEventToolInfo, once the matching
    // tool_use record has been seen. A replay of this line knows neither, so the update
    // leaves tool_name alone and only overwrites file_path when it actually has one.
    this.stmt(
      `INSERT INTO events
       (session_id, line_no, uuid, ts, type, subtype, category, chars, est_tokens,
        preview, tool_use_id, file_path, is_sidechain, is_compact_summary, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, line_no) DO UPDATE SET
         uuid = excluded.uuid, ts = excluded.ts, type = excluded.type,
         subtype = excluded.subtype, category = excluded.category, chars = excluded.chars,
         est_tokens = excluded.est_tokens, preview = excluded.preview,
         tool_use_id = excluded.tool_use_id,
         file_path = COALESCE(excluded.file_path, file_path),
         is_sidechain = excluded.is_sidechain, is_compact_summary = excluded.is_compact_summary,
         extra = excluded.extra`,
    ).run(
      sessionId,
      e.lineNo,
      e.uuid,
      e.ts,
      e.type,
      e.subtype,
      e.category,
      e.chars,
      e.estTokens,
      e.preview,
      e.toolUseId,
      e.filePath,
      e.isSidechain ? 1 : 0,
      e.isCompactSummary ? 1 : 0,
      Object.keys(e.extra).length ? JSON.stringify(e.extra) : null,
    );
  }

  setEventToolInfo(sessionId: string, lineNo: number, toolName: string, filePath: string | null): void {
    this.stmt(
      `UPDATE events SET tool_name = ?, file_path = COALESCE(?, file_path) WHERE session_id = ? AND line_no = ?`,
    ).run(toolName, filePath, sessionId, lineNo);
  }

  upsertToolUse(t: {
    toolUseId: string;
    sessionId: string;
    lineNo: number;
    ts: string | null;
    name: string;
    filePath: string | null;
    inputPreview: string;
  }): void {
    // DO UPDATE rather than INSERT OR REPLACE: the result columns are filled in
    // later by setToolUseResult and must survive a re-ingest of the call record.
    this.stmt(
      `INSERT INTO tool_uses
       (tool_use_id, session_id, line_no, ts, name, file_path, input_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_use_id) DO UPDATE SET
         session_id = excluded.session_id, line_no = excluded.line_no, ts = excluded.ts,
         name = excluded.name, file_path = excluded.file_path,
         input_preview = excluded.input_preview`,
    ).run(t.toolUseId, t.sessionId, t.lineNo, t.ts, t.name, t.filePath, t.inputPreview);
  }

  setToolUseResult(toolUseId: string, resultChars: number, resultLineNo: number): void {
    this.stmt(
      `UPDATE tool_uses SET result_chars = ?, result_line_no = ? WHERE tool_use_id = ?`,
    ).run(resultChars, resultLineNo, toolUseId);
  }

  getToolUse(toolUseId: string): ToolUseRow | undefined {
    return this.stmt(`SELECT * FROM tool_uses WHERE tool_use_id = ?`).get(toolUseId) as
      | ToolUseRow
      | undefined;
  }

  toolUsesForSession(sessionId: string): ToolUseRow[] {
    return this.stmt(
      `SELECT * FROM tool_uses WHERE session_id = ? ORDER BY line_no ASC`,
    ).all(sessionId) as unknown as ToolUseRow[];
  }

  eventsForSession(sessionId: string): EventRow[] {
    return this.stmt(
      `SELECT * FROM events WHERE session_id = ? ORDER BY line_no ASC`,
    ).all(sessionId) as unknown as EventRow[];
  }

  getIngestState(sessionId: string): IngestState | undefined {
    return this.stmt(`SELECT * FROM ingest_state WHERE session_id = ?`).get(sessionId) as
      | IngestState
      | undefined;
  }

  setIngestState(sessionId: string, transcriptPath: string, byteOffset: number, lineNo: number): void {
    this.stmt(
      `INSERT INTO ingest_state (session_id, transcript_path, byte_offset, line_no)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET transcript_path = excluded.transcript_path,
         byte_offset = excluded.byte_offset, line_no = excluded.line_no`,
    ).run(sessionId, transcriptPath, byteOffset, lineNo);
  }

  resetSession(sessionId: string): void {
    this.stmt(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
    this.stmt(`DELETE FROM tool_uses WHERE session_id = ?`).run(sessionId);
    this.stmt(`DELETE FROM ingest_state WHERE session_id = ?`).run(sessionId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __contextcluesDb: Db | undefined;
}

export function getDb(): Db {
  if (!globalThis.__contextcluesDb) {
    // Keyed to the home directory, not the cwd: when ContextClues is installed
    // globally it can be started from anywhere, and it must not scatter an index
    // into whatever directory the user happened to be in.
    const dataDir = process.env.CONTEXTCLUES_DATA_DIR ?? join(homedir(), ".contextclues");
    globalThis.__contextcluesDb = new Db(dataDir);
  }
  return globalThis.__contextcluesDb;
}

export type { Db };
