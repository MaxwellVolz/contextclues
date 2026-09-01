// The clue engine. Each rule is a claim shown to the user, so each needs to fire
// when it should, stay quiet when it shouldn't, and carry the right confidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveClues } from "../lib/clues.ts";
import type { Clue, EvidenceItem, Meter, ToolInfo } from "../lib/types.ts";
import type { ToolUseRow } from "../lib/db.ts";

const WINDOW = 1_000_000;

function meterAt(pct: number | null): Meter {
  return {
    contextTokens: pct == null ? null : Math.round((pct / 100) * WINDOW),
    observedAt: pct == null ? null : new Date().toISOString(),
    maxTokens: WINDOW,
    maxTokensConfidence: "assumed",
    pct,
    model: "claude-opus-5",
    usageBreakdown: null,
    estTokensSinceObserved: 0,
    budgetTokensLeft: null,
    confidence: pct == null ? "estimated" : "observed",
  };
}

let nextLine = 1;
function evidence(o: Partial<EvidenceItem> = {}): EvidenceItem {
  const lineNo = o.lineNo ?? nextLine++;
  return {
    id: `s:${lineNo}`,
    lineNo,
    uuid: `u${lineNo}`,
    ts: null,
    category: "tool_result",
    subtype: null,
    toolName: "Read",
    filePath: null,
    estTokens: 100,
    chars: 400,
    preview: "preview",
    inclusion: "assumed-included",
    inclusionReason: "",
    confidence: "estimated",
    ...o,
  };
}

function tool(o: Partial<ToolInfo> & { name: string }): ToolInfo {
  return { provider: "built-in", source: "static", description: null, status: "assumed", useCount: 0, lastUsedAt: null, ...o };
}

function read(path: string, resultChars: number, lineNo: number): ToolUseRow {
  return {
    tool_use_id: `t${lineNo}`,
    session_id: "s",
    line_no: lineNo,
    ts: null,
    name: "Read",
    file_path: path,
    input_preview: "",
    result_chars: resultChars,
    result_line_no: lineNo + 1,
  };
}

function derive(o: Partial<Parameters<typeof deriveClues>[0]> = {}): Clue[] {
  return deriveClues({
    meter: meterAt(10),
    evidence: [],
    toolUses: [],
    tools: [],
    compactions: [],
    compactedOutCount: 0,
    ...o,
  });
}

// ---------- window pressure ----------

test("pressure escalates from quiet to notice to warning", () => {
  assert.ok(!derive({ meter: meterAt(50) }).some((c) => c.id === "pressure"), "quiet below 70%");

  const notice = derive({ meter: meterAt(75) }).find((c) => c.id === "pressure")!;
  assert.equal(notice.severity, "notice");
  assert.equal(notice.confidence, "observed");
  assert.match(notice.title, /75% full/);

  assert.equal(derive({ meter: meterAt(90) }).find((c) => c.id === "pressure")!.severity, "warning");
});

test("with no observed usage the engine says so instead of implying a reading", () => {
  const clues = derive({ meter: meterAt(null) });
  assert.ok(!clues.some((c) => c.id === "pressure"));
  const none = clues.find((c) => c.id === "no-usage")!;
  assert.equal(none.confidence, "estimated");
});

// ---------- oversized evidence ----------

test("evidence is flagged only once it is a real share of the window", () => {
  const clues = derive({
    evidence: [
      evidence({ lineNo: 1, estTokens: WINDOW * 0.02 }), // below the 3% floor
      evidence({ lineNo: 2, estTokens: WINDOW * 0.05, toolName: "Grep", filePath: "/big.ts" }),
      evidence({ lineNo: 3, estTokens: WINDOW * 0.15 }),
    ],
  });
  assert.ok(!clues.some((c) => c.id === "large-1"), "2% is not worth a clue");

  const mid = clues.find((c) => c.id === "large-2")!;
  assert.equal(mid.severity, "notice");
  assert.match(mid.title, /Grep result \(\/big\.ts\)/);
  assert.match(mid.title, /5\.0%/);
  assert.equal(mid.confidence, "estimated", "chars/4 is never presented as observed");

  assert.equal(clues.find((c) => c.id === "large-3")!.severity, "warning", "10%+ escalates");
});

test("compacted-out evidence is not blamed for occupying the window", () => {
  const clues = derive({
    evidence: [evidence({ lineNo: 1, estTokens: WINDOW * 0.5, inclusion: "compacted-out" })],
  });
  assert.ok(!clues.some((c) => c.id.startsWith("large-")));
});

// ---------- duplicated work ----------

test("a file read twice is a notice; three times is a warning", () => {
  const twice = derive({ toolUses: [read("/a.ts", 4000, 1), read("/a.ts", 4000, 3)] });
  const dup = twice.find((c) => c.id === "dupfile-/a.ts")!;
  assert.equal(dup.severity, "notice");
  assert.equal(dup.confidence, "observed", "the reads themselves are recorded facts");
  assert.match(dup.detail, /2\.0k tokens total/, "sizes are summed across the reads");

  const thrice = derive({
    toolUses: [read("/a.ts", 4000, 1), read("/a.ts", 4000, 3), read("/a.ts", 4000, 5)],
  });
  assert.equal(thrice.find((c) => c.id === "dupfile-/a.ts")!.severity, "warning");
});

test("distinct files and single reads raise nothing", () => {
  const clues = derive({ toolUses: [read("/a.ts", 4000, 1), read("/b.ts", 4000, 3)] });
  assert.ok(!clues.some((c) => c.id.startsWith("dupfile-")));
});

test("repeated large tool results are reported as duplicated work", () => {
  const body = { chars: 8000, estTokens: 2000, preview: "identical output" };
  const clues = derive({
    evidence: [
      evidence({ lineNo: 1, ...body }),
      evidence({ lineNo: 2, ...body }),
      evidence({ lineNo: 3, chars: 8000, estTokens: 2000, preview: "different output" }),
    ],
  });
  const dup = clues.find((c) => c.id.startsWith("duptool-"))!;
  assert.match(dup.title, /2 near-identical/);
  assert.match(dup.detail, /entry #1/, "points at the first occurrence");
});

test("small repeated results are below the noise floor", () => {
  const body = { chars: 400, estTokens: 100, preview: "small" };
  const clues = derive({ evidence: [evidence({ lineNo: 1, ...body }), evidence({ lineNo: 2, ...body })] });
  assert.ok(!clues.some((c) => c.id.startsWith("duptool-")));
});

// ---------- compaction ----------

test("a compaction reports the exact figures the CLI recorded", () => {
  const clues = derive({
    compactions: [{ lineNo: 12, trigger: "manual", preTokens: 900_000, postTokens: 40_000 }],
    compactedOutCount: 0,
  });
  const c = clues.find((x) => x.id === "compact-12")!;
  assert.equal(c.confidence, "observed");
  assert.match(c.title, /has been compacted/, "no record count to quote");
  assert.match(c.detail, /Manual compaction/);
  assert.match(c.detail, /860k dropped/);
});

// ---------- tool schemas ----------

test("unused enabled tools are counted, with deferred names kept separate", () => {
  const clues = derive({
    tools: [
      tool({ name: "Bash", status: "used", useCount: 3 }),
      tool({ name: "Read", status: "assumed" }),
      tool({ name: "Write", status: "assumed" }),
      tool({ name: "Glob", status: "active" }),
      tool({ name: "mcp__x__*", status: "configured" }),
      tool({ name: "WebFetch", status: "deferred" }),
      tool({ name: "WebSearch", status: "deferred" }),
    ],
  });
  const unused = clues.find((c) => c.id === "unused-tools")!;
  assert.match(unused.title, /^3 enabled tools/, "used tools and wildcards are excluded");
  assert.match(unused.detail, /2 deferred tool names/);
  assert.match(unused.detail, /near-zero cost/);
});

test("fewer than three unused tools is not worth saying", () => {
  const clues = derive({ tools: [tool({ name: "Read" }), tool({ name: "Write" })] });
  assert.ok(!clues.some((c) => c.id === "unused-tools"));
});

test("a wildcard MCP entry is never counted as an unused tool", () => {
  const clues = derive({
    tools: [tool({ name: "mcp__a__*", status: "active" }), tool({ name: "mcp__b__*", status: "active" }), tool({ name: "mcp__c__*", status: "active" })],
  });
  assert.ok(!clues.some((c) => c.id === "unused-tools"));
});

// ---------- staleness ----------

test("a big, old tool result is flagged; a big, fresh one is not", () => {
  const old = new Date(Date.now() - 90 * 60_000).toISOString();
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
  const clues = derive({
    evidence: [
      evidence({ lineNo: 1, estTokens: WINDOW * 0.03, ts: old, filePath: "/old.ts" }),
      evidence({ lineNo: 2, estTokens: WINDOW * 0.03, ts: fresh }),
      // Old and large, but a user message rather than reclaimable tool output.
      evidence({ lineNo: 3, estTokens: WINDOW * 0.03, ts: old, category: "user_message" }),
      // Old tool output, but too small to matter.
      evidence({ lineNo: 4, estTokens: 100, ts: old }),
    ],
  });
  assert.ok(clues.some((c) => c.id === "stale-1"));
  assert.ok(!clues.some((c) => c.id === "stale-2"), "recent output is not stale");
  assert.ok(!clues.some((c) => c.id === "stale-3"), "only tool results are reclaimable this way");
  assert.ok(!clues.some((c) => c.id === "stale-4"), "small entries are below the threshold");
});

test("evidence without a timestamp cannot be aged and is skipped", () => {
  const clues = derive({ evidence: [evidence({ lineNo: 1, estTokens: WINDOW * 0.03, ts: null })] });
  assert.ok(!clues.some((c) => c.id.startsWith("stale-")));
});

// ---------- ordering and volume ----------

test("the board is capped and ordered worst-first", () => {
  const many: EvidenceItem[] = [];
  for (let i = 1; i <= 40; i++) many.push(evidence({ lineNo: i, estTokens: WINDOW * 0.12 }));
  const clues = derive({ meter: meterAt(95), evidence: many });

  assert.ok(clues.length <= 20, `expected at most 20 clues, got ${clues.length}`);
  const rank = { warning: 0, notice: 1, info: 2 };
  const ranks = clues.map((c) => rank[c.severity]);
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, "warnings before notices before info");
});

test("a quiet session produces a quiet board", () => {
  assert.deepEqual(derive({ meter: meterAt(5) }), []);
});
