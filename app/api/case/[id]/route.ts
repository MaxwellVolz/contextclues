import { NextResponse } from "next/server";
import { getCollector } from "@/lib/collector.ts";
import { buildCaseFile } from "@/lib/casefile.ts";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) {
    return NextResponse.json({ error: "invalid session id" }, { status: 400 });
  }
  const collector = getCollector();
  collector.ensureTracked(id);
  const caseFile = buildCaseFile(id);
  if (!caseFile) {
    return NextResponse.json({ error: "unknown session" }, { status: 404 });
  }
  return NextResponse.json(caseFile);
}
