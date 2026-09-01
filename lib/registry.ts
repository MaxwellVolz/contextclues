// Session discovery against Claude CLI's own artifacts. Strictly read-only.
//
// Live sessions:   ~/.claude/sessions/<pid>.json  (verified against pid liveness)
// Transcripts:     ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl
//   We locate transcripts by searching for the sessionId filename rather than
//   re-implementing the CLI's path-munging algorithm.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function claudeDir(): string {
  return process.env.CONTEXTCLUES_CLAUDE_DIR ?? join(homedir(), ".claude");
}

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  version: string | null;
  kind: string | null;
  name: string | null;
  status: string | null;
  alive: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we may not signal it (e.g. sandboxing) — that's alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read every ~/.claude/sessions/<pid>.json and check whether the process still exists. */
export function readSessionRegistry(): RegistryEntry[] {
  const dir = join(claudeDir(), "sessions");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const entries: RegistryEntry[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const pid = typeof raw.pid === "number" ? raw.pid : Number.parseInt(f, 10);
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
      if (!sessionId) continue;
      entries.push({
        pid,
        sessionId,
        cwd: typeof raw.cwd === "string" ? raw.cwd : null,
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
        version: typeof raw.version === "string" ? raw.version : null,
        kind: typeof raw.kind === "string" ? raw.kind : null,
        name: typeof raw.name === "string" ? raw.name : null,
        status: typeof raw.status === "string" ? raw.status : null,
        alive: pidAlive(pid),
      });
    } catch {
      // unreadable/corrupt registry file — skip
    }
  }
  return entries;
}

/** Locate a transcript by sessionId without assuming the directory-munging scheme. */
export function findTranscript(sessionId: string): string | null {
  const projects = join(claudeDir(), "projects");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface RecentTranscript {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

/** Transcripts modified within the window — recent "cold case" candidates. */
export function listRecentTranscripts(hours = 24): RecentTranscript[] {
  const projects = join(claudeDir(), "projects");
  const cutoff = Date.now() - hours * 3600_000;
  const out: RecentTranscript[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projects);
  } catch {
    return [];
  }
  for (const d of dirs) {
    let files: string[] = [];
    const dirPath = join(projects, d);
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const p = join(dirPath, f);
        const st = statSync(p);
        if (st.mtimeMs >= cutoff) {
          out.push({
            sessionId: f.replace(/\.jsonl$/, ""),
            path: p,
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {
        // stat race — skip
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
