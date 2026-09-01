import { NextResponse } from "next/server";
import { getCollector } from "@/lib/collector.ts";
import { getDb } from "@/lib/db.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const collector = getCollector();
  collector.refreshRegistry();
  const db = getDb();
  // One grouped scan for every session's event count, rather than a COUNT(*) per row.
  const counts = db.eventCounts();
  const cases = db
    .listSessions(30)
    .filter((s) => s.transcript_path != null)
    .map((s) => ({
      sessionId: s.session_id,
      cwd: s.cwd,
      name: s.name,
      live: s.live === 1,
      kind: s.kind,
      status: s.status,
      pid: s.pid,
      updatedAt: s.updated_at,
      startedAt: s.started_at,
      model: s.model,
      eventCount: counts.get(s.session_id) ?? 0,
    }));
  return NextResponse.json({ cases });
}
