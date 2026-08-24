// SQLite persistence via Node's built-in node:sqlite (no native build step).
// ContextClues' own state lives in ./.data — Claude's files are never written.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedEvent } from "./transcript.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  cwd TEXT, name TEXT, pid INTEGER, kind TEXT, status TEXT,
  live INTEGER DEFAULT 0,
  started_at INTEGER, updated_at INTEGER,
  transcript_path TEXT, git_branch TEXT, cli_version TEXT, model TEXT
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  uuid TEXT, parent_uuid TEXT, ts TEXT,
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
  input_chars INTEGER, input_preview TEXT,
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
  git_branch: string | null;
  cli_version: string | null;
  model: string | null;
}

export interface EventRow {
  session_id: string;
  line_no: number;
  uuid: string | null;
  parent_uuid: string | null;
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
  input_chars: number;
  input_preview: string;
  result_chars: number | null;
  result_line_no: number | null;
}

class Db {
  db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "contextclues.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  upsertSession(s: Partial<SessionRow> & { session_id: string }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, cwd, name, pid, kind, status, live, started_at, updated_at, transcript_path, git_branch, cli_version, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           git_branch = COALESCE(excluded.git_branch, git_branch),
           cli_version = COALESCE(excluded.cli_version, cli_version),
           model = COALESCE(excluded.model, model)`,
      )
      .run(
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
        s.git_branch ?? null,
        s.cli_version ?? null,
        s.model ?? null,
      );
  }

  setSessionModel(sessionId: string, model: string): void {
    this.db.prepare(`UPDATE sessions SET model = ? WHERE session_id = ?`).run(model, sessionId);
  }

  markSessionsNotLive(livePids: number[]): void {
    // Any session whose pid is no longer alive gets live=0.
    const placeholders = livePids.map(() => "?").join(",");
    const sql = livePids.length
      ? `UPDATE sessions SET live = 0 WHERE pid IS NULL OR pid NOT IN (${placeholders})`
      : `UPDATE sessions SET live = 0`;
    this.db.prepare(sql).run(...livePids);
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as
      | SessionRow
      | undefined;
  }

  listSessions(limit = 30): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY live DESC, updated_at DESC LIMIT ?`)
      .all(limit) as unknown as SessionRow[];
  }

  eventCount(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`)
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  insertEvent(sessionId: string, e: NormalizedEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO events
         (session_id, line_no, uuid, parent_uuid, ts, type, subtype, category, chars, est_tokens,
          preview, tool_name, tool_use_id, file_path, is_sidechain, is_compact_summary, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        e.lineNo,
        e.uuid,
        e.parentUuid,
        e.ts,
        e.type,
        e.subtype,
        e.category,
        e.chars,
        e.estTokens,
        e.preview,
        null,
        e.toolUseId,
        e.filePath,
        e.isSidechain ? 1 : 0,
        e.isCompactSummary ? 1 : 0,
        Object.keys(e.extra).length ? JSON.stringify(e.extra) : null,
      );
  }

  setEventToolInfo(sessionId: string, lineNo: number, toolName: string, filePath: string | null): void {
    this.db
      .prepare(`UPDATE events SET tool_name = ?, file_path = COALESCE(?, file_path) WHERE session_id = ? AND line_no = ?`)
      .run(toolName, filePath, sessionId, lineNo);
  }

  upsertToolUse(t: {
    toolUseId: string;
    sessionId: string;
    lineNo: number;
    ts: string | null;
    name: string;
    filePath: string | null;
    inputChars: number;
    inputPreview: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tool_uses
         (tool_use_id, session_id, line_no, ts, name, file_path, input_chars, input_preview, result_chars, result_line_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT result_chars FROM tool_uses WHERE tool_use_id = ?),
           (SELECT result_line_no FROM tool_uses WHERE tool_use_id = ?))`,
      )
      .run(
        t.toolUseId,
        t.sessionId,
        t.lineNo,
        t.ts,
        t.name,
        t.filePath,
        t.inputChars,
        t.inputPreview,
        t.toolUseId,
        t.toolUseId,
      );
  }

  setToolUseResult(toolUseId: string, resultChars: number, resultLineNo: number): void {
    this.db
      .prepare(`UPDATE tool_uses SET result_chars = ?, result_line_no = ? WHERE tool_use_id = ?`)
      .run(resultChars, resultLineNo, toolUseId);
  }

  getToolUse(toolUseId: string): ToolUseRow | undefined {
    return this.db.prepare(`SELECT * FROM tool_uses WHERE tool_use_id = ?`).get(toolUseId) as
      | ToolUseRow
      | undefined;
  }

  toolUsesForSession(sessionId: string): ToolUseRow[] {
    return this.db
      .prepare(`SELECT * FROM tool_uses WHERE session_id = ? ORDER BY line_no ASC`)
      .all(sessionId) as unknown as ToolUseRow[];
  }

  eventsForSession(sessionId: string): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY line_no ASC`)
      .all(sessionId) as unknown as EventRow[];
  }

  getIngestState(sessionId: string): { byte_offset: number; line_no: number; transcript_path: string } | undefined {
    return this.db.prepare(`SELECT * FROM ingest_state WHERE session_id = ?`).get(sessionId) as
      | { byte_offset: number; line_no: number; transcript_path: string }
      | undefined;
  }

  setIngestState(sessionId: string, transcriptPath: string, byteOffset: number, lineNo: number): void {
    this.db
      .prepare(
        `INSERT INTO ingest_state (session_id, transcript_path, byte_offset, line_no)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET transcript_path = excluded.transcript_path,
           byte_offset = excluded.byte_offset, line_no = excluded.line_no`,
      )
      .run(sessionId, transcriptPath, byteOffset, lineNo);
  }

  resetSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM tool_uses WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM ingest_state WHERE session_id = ?`).run(sessionId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __contextcluesDb: Db | undefined;
}

export function getDb(): Db {
  if (!globalThis.__contextcluesDb) {
    const dataDir = process.env.CONTEXTCLUES_DATA_DIR ?? join(process.cwd(), ".data");
    globalThis.__contextcluesDb = new Db(dataDir);
  }
  return globalThis.__contextcluesDb;
}

export type { Db };
