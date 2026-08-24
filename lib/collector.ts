// The session collector: watches Claude CLI's session registry and transcripts (read-only),
// ingests new JSONL lines incrementally into SQLite, and notifies SSE subscribers.
//
// Runs inside the Next.js server process as a global singleton (survives HMR reloads).

import { EventEmitter } from "node:events";
import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import { join } from "node:path";
import { getDb } from "./db.ts";
import { parseTranscriptLine } from "./transcript.ts";
import {
  claudeDir,
  findTranscript,
  listRecentTranscripts,
  readSessionRegistry,
} from "./registry.ts";

const RECENT_HOURS = 24;

export class Collector {
  bus = new EventEmitter();
  private started = false;
  private sessionsWatcher: FSWatcher | null = null;
  private transcriptWatcher: FSWatcher | null = null;
  private watchedPaths = new Set<string>();
  private sessionByPath = new Map<string, string>();
  private ingesting = new Set<string>();
  private registrySignature = "";

  start(): void {
    if (this.started) return;
    this.started = true;
    this.bus.setMaxListeners(100);

    this.refreshRegistry();

    // Ingest recent transcripts so recently-closed sessions appear as cold cases.
    for (const t of listRecentTranscripts(RECENT_HOURS).slice(0, 15)) {
      this.trackSession(t.sessionId, t.path);
    }

    const sessionsDir = join(claudeDir(), "sessions");
    this.sessionsWatcher = watch(sessionsDir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.sessionsWatcher.on("all", () => this.refreshRegistry());

    this.transcriptWatcher = watch([], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      alwaysStat: false,
    });
    this.transcriptWatcher.on("change", (path) => {
      const sessionId = this.sessionByPath.get(path);
      if (sessionId) this.ingest(sessionId, path);
    });

    // Re-check the registry periodically: pid liveness changes leave no fs event behind.
    const timer = setInterval(() => this.refreshRegistry(), 15_000);
    timer.unref();
  }

  /** Sync the sessions table with ~/.claude/sessions/*.json and pid liveness. */
  refreshRegistry(): void {
    const db = getDb();
    const entries = readSessionRegistry();
    const livePids: number[] = [];
    for (const e of entries) {
      if (e.alive) livePids.push(e.pid);
      db.upsertSession({
        session_id: e.sessionId,
        cwd: e.cwd,
        name: e.name,
        pid: e.pid,
        kind: e.kind,
        status: e.status,
        live: e.alive ? 1 : 0,
        started_at: e.startedAt,
        updated_at: e.updatedAt,
        cli_version: e.version,
      });
      if (e.alive) {
        const path = findTranscript(e.sessionId);
        if (path) this.trackSession(e.sessionId, path);
      }
    }
    db.markSessionsNotLive(livePids);
    // Only notify subscribers when membership/liveness actually changed —
    // otherwise every /api/cases poll would trigger a client refetch loop.
    const signature = entries
      .map((e) => `${e.sessionId}:${e.alive ? 1 : 0}:${e.status}`)
      .sort()
      .join("|");
    if (signature !== this.registrySignature) {
      this.registrySignature = signature;
      this.bus.emit("registry");
    }
  }

  /** Start watching + ingest a session transcript (idempotent). */
  trackSession(sessionId: string, path: string): void {
    const db = getDb();
    db.upsertSession({ session_id: sessionId, transcript_path: path });
    if (!this.watchedPaths.has(path)) {
      this.watchedPaths.add(path);
      this.sessionByPath.set(path, sessionId);
      this.transcriptWatcher?.add(path);
    }
    this.ingest(sessionId, path);
  }

  /** Ensure a session known only by id is tracked (used when the UI opens a case). */
  ensureTracked(sessionId: string): boolean {
    const db = getDb();
    const row = db.getSession(sessionId);
    const path = row?.transcript_path ?? findTranscript(sessionId);
    if (!path) return false;
    this.trackSession(sessionId, path);
    return true;
  }

  /** Incremental tail-parse: read only bytes appended since the stored offset. */
  ingest(sessionId: string, path: string): void {
    if (this.ingesting.has(sessionId)) return;
    this.ingesting.add(sessionId);
    try {
      const db = getDb();
      const state = db.getIngestState(sessionId);
      let offset = state && state.transcript_path === path ? state.byte_offset : 0;
      let lineNo = state && state.transcript_path === path ? state.line_no : 0;

      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch {
        return;
      }
      try {
        const size = fstatSync(fd).size;
        if (size < offset) {
          // Truncated/rewritten (shouldn't happen for append-only logs) — re-ingest from scratch.
          db.resetSession(sessionId);
          offset = 0;
          lineNo = 0;
        }
        if (size === offset) return;

        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        const text = buf.toString("utf8");
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline < 0) return; // no complete line yet
        const complete = text.slice(0, lastNewline);
        // Only advance the offset past complete lines; a partially-flushed line is re-read next time.
        offset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");

        let sawUpdate = false;
        for (const line of complete.split("\n")) {
          if (!line.trim()) continue;
          lineNo += 1;
          const ev = parseTranscriptLine(line, lineNo);
          if (!ev) continue;
          db.insertEvent(sessionId, ev);
          sawUpdate = true;

          for (const tu of ev.toolUses) {
            db.upsertToolUse({
              toolUseId: tu.id,
              sessionId,
              lineNo: ev.lineNo,
              ts: ev.ts,
              name: tu.name,
              filePath: tu.filePath,
              inputChars: tu.inputChars,
              inputPreview: tu.inputPreview,
            });
          }
          if (ev.toolUseId) {
            const tu = db.getToolUse(ev.toolUseId);
            if (tu) {
              db.setToolUseResult(ev.toolUseId, ev.chars, ev.lineNo);
              db.setEventToolInfo(sessionId, ev.lineNo, tu.name, tu.file_path);
            }
          }
          if (ev.extra.model) db.setSessionModel(sessionId, ev.extra.model);
        }
        db.setIngestState(sessionId, path, offset, lineNo);
        if (sawUpdate) this.bus.emit("update", sessionId);
      } finally {
        closeSync(fd);
      }
    } finally {
      this.ingesting.delete(sessionId);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __contextcluesCollector: Collector | undefined;
}

export function getCollector(): Collector {
  if (!globalThis.__contextcluesCollector) {
    globalThis.__contextcluesCollector = new Collector();
  }
  globalThis.__contextcluesCollector.start();
  return globalThis.__contextcluesCollector;
}
