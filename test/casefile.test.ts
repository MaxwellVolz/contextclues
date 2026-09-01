// End-to-end coverage of the case-file assembly: real transcript lines, through the
// real ingest path, into the payload the API serves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  assistantLine,
  at,
  attachmentLine,
  compactBoundaryLine,
  compactSummaryLine,
  tempDir,
  toolResultLine,
  userLine,
  writeTranscript,
} from "./helpers.ts";

// Both must be set before anything calls getDb() / claudeDir().
const root = tempDir("casefile");
process.env.CONTEXTCLUES_DATA_DIR = join(root, "data");
process.env.CONTEXTCLUES_CLAUDE_DIR = join(root, "claude");

const { buildCaseFile } = await import("../lib/casefile.ts");
const { Collector } = await import("../lib/collector.ts");
const { getDb } = await import("../lib/db.ts");

/** Write a transcript, register the session, and run the real incremental ingest. */
function ingest(sessionId: string, lines: string[]): void {
  const path = join(root, "transcripts", `${sessionId}.jsonl`);
  writeTranscript(path, lines);
  getDb().upsertSession({ session_id: sessionId, cwd: null, transcript_path: path });
  new Collector().ingest(sessionId, path);
}

/**
 * A session that exercises every inclusion branch: a preserved record, a dropped
 * record, the boundary itself, the replacement summary, a meta record and a sidechain.
 */
function compactedSession(sessionId: string): void {
  ingest(sessionId, [
    userLine("investigate the parser", { uuid: "u1", ts: at(0) }),
    assistantLine({
      uuid: "a1",
      ts: at(1),
      text: "Reading it.",
      model: "claude-opus-5",
      usage: { input: 5, cacheRead: 10_000, cacheCreation: 500, output: 100 },
      toolUses: [{ id: "toolu_1", name: "Read", input: { file_path: "/src/parser.ts" } }],
    }),
    toolResultLine("toolu_1", "x".repeat(4000), { uuid: "r1", ts: at(2) }),
    attachmentLine(
      "total_tokens_reminder",
      { text: "<total_tokens>1,234,567 tokens left</total_tokens>" },
      { uuid: "at1", ts: at(3) },
    ),
    compactBoundaryLine({
      uuid: "c1",
      ts: at(4),
      preTokens: 900_000,
      postTokens: 40_000,
      preservedUuids: ["u1"],
    }),
    compactSummaryLine("Summary of the work so far.", { uuid: "s1", ts: at(5) }),
    assistantLine({
      uuid: "a2",
      ts: at(6),
      text: "Done.",
      model: "claude-opus-5",
      usage: { input: 20, cacheRead: 40_000, cacheCreation: 1000, output: 300 },
    }),
    JSON.stringify({ type: "file-history-snapshot", uuid: "m1", timestamp: at(7) }),
    assistantLine({
      uuid: "a3",
      ts: at(8),
      text: "subagent turn",
      model: "claude-opus-5",
      isSidechain: true,
      usage: { input: 9, cacheRead: 999_999, output: 1 },
    }),
  ]);
}

test("unknown session ids yield null rather than an empty case file", () => {
  assert.equal(buildCaseFile("no-such-session"), null);
});

// ---------- meter ----------

test("meter reads the last main-chain usage record, ignoring sidechains", () => {
  compactedSession("s-meter");
  const cf = buildCaseFile("s-meter")!;
  assert.ok(cf);
  // a2, not the much larger sidechain turn a3 that follows it.
  assert.equal(cf.meter.contextTokens, 20 + 40_000 + 1000 + 300);
  assert.deepEqual(cf.meter.usageBreakdown, {
    input: 20,
    cacheRead: 40_000,
    cacheCreation: 1000,
    output: 300,
  });
  assert.equal(cf.meter.observedAt, at(6));
  assert.equal(cf.meter.confidence, "observed");
});

test("meter divides by the model's window and picks up the session token budget", () => {
  compactedSession("s-meter2");
  const cf = buildCaseFile("s-meter2")!;
  assert.equal(cf.meter.model, "claude-opus-5", "model is captured from the transcript");
  assert.equal(cf.meter.maxTokens, 1_000_000);
  assert.equal(cf.meter.maxTokensConfidence, "assumed");
  assert.ok(Math.abs(cf.meter.pct! - (41_320 / 1_000_000) * 100) < 1e-9);
  assert.equal(cf.meter.budgetTokensLeft, 1_234_567, "comma-separated figure is parsed");
});

test("meter falls back to estimates when no usage has been observed", () => {
  ingest("s-nousage", [userLine("hello", { uuid: "u1", ts: at(0) })]);
  const cf = buildCaseFile("s-nousage")!;
  assert.equal(cf.meter.contextTokens, null);
  assert.equal(cf.meter.pct, null);
  assert.equal(cf.meter.confidence, "estimated");
  assert.ok(cf.meter.estTokensSinceObserved > 0, "everything counts as since-observed");
  assert.ok(cf.clues.some((c) => c.id === "no-usage"));
});

test("an unrecognized model yields a null window and says so, rather than guessing", () => {
  ingest("s-unknown-model", [
    assistantLine({ uuid: "a1", ts: at(0), text: "hi", model: "some-other-llm", usage: { input: 10 } }),
  ]);
  const cf = buildCaseFile("s-unknown-model")!;
  assert.equal(cf.meter.maxTokens, null);
  assert.equal(cf.meter.pct, null);
  assert.ok(cf.notes.some((n) => /window unknown/i.test(n)));
});

test("observed usage above the table's window overrides the table instead of reporting >100%", () => {
  ingest("s-bigger-window", [
    assistantLine({
      uuid: "a1",
      ts: at(0),
      text: "hi",
      model: "claude-haiku-4-5", // table says 200K
      usage: { input: 10, cacheRead: 300_000 },
    }),
  ]);
  const cf = buildCaseFile("s-bigger-window")!;
  assert.equal(cf.meter.maxTokens, 1_000_000);
  assert.equal(cf.meter.maxTokensConfidence, "inferred");
  assert.ok(cf.meter.pct! < 100);
  assert.ok(cf.notes.some((n) => /evidently has a larger one/.test(n)));
});

// ---------- inclusion ----------

test("inclusion: preserved, dropped, summary, meta and sidechain each get their own verdict", () => {
  compactedSession("s-incl");
  const cf = buildCaseFile("s-incl")!;
  const byUuid = new Map(cf.evidence.map((e) => [e.uuid, e]));

  assert.equal(byUuid.get("u1")!.inclusion, "assumed-included");
  assert.match(byUuid.get("u1")!.inclusionReason, /preserved/i);

  assert.equal(byUuid.get("r1")!.inclusion, "compacted-out");
  assert.match(byUuid.get("r1")!.inclusionReason, /Dropped by the compaction/);

  assert.equal(byUuid.get("s1")!.inclusion, "assumed-included");
  assert.equal(byUuid.get("s1")!.category, "summary");

  assert.equal(byUuid.get("a2")!.inclusion, "assumed-included");

  assert.equal(byUuid.get("m1")!.inclusion, "not-sent");
  assert.equal(byUuid.get("m1")!.category, "meta");
  assert.equal(byUuid.get("m1")!.estTokens, 0);

  assert.equal(byUuid.get("a3")!.inclusion, "not-sent");
  assert.match(byUuid.get("a3")!.inclusionReason, /sidechain/i);
});

// ---------- composition ----------

test("composition aggregates included evidence and infers the unaccounted remainder", () => {
  compactedSession("s-comp");
  const cf = buildCaseFile("s-comp")!;
  const keys = cf.composition.map((c) => c.key);

  assert.ok(keys.includes("user_message"));
  assert.ok(keys.includes("summary"));
  assert.ok(!keys.includes("meta"), "meta is never part of the prompt");
  assert.ok(
    !cf.composition.some((c) => c.key === "tool_result"),
    "the compacted-out tool result must not be counted as in-context",
  );

  const overhead = cf.composition.find((c) => c.key === "overhead")!;
  assert.ok(overhead, "system prompt / tool schemas appear as the inferred remainder");
  assert.equal(overhead.confidence, "inferred");
  const accounted = cf.composition.filter((c) => c.key !== "overhead").reduce((s, c) => s + c.estTokens, 0);
  assert.equal(accounted + overhead.estTokens, cf.meter.contextTokens);

  // Measured categories rank by size; the inferred remainder is pinned last.
  assert.equal(cf.composition.at(-1)!.key, "overhead");
  const measured = cf.composition.filter((c) => c.key !== "overhead").map((c) => c.estTokens);
  assert.deepEqual([...measured].sort((a, b) => b - a), measured, "largest first");
});

test("composition reports rather than hides estimates that exceed the observed total", () => {
  // A huge tool result with a tiny observed window: chars/4 must overshoot.
  ingest("s-over", [
    assistantLine({
      uuid: "a1",
      ts: at(0),
      model: "claude-opus-5",
      text: "reading",
      usage: { input: 100 },
      toolUses: [{ id: "toolu_1", name: "Read", input: { file_path: "/big.txt" } }],
    }),
    toolResultLine("toolu_1", "y".repeat(200_000), { uuid: "r1", ts: at(1) }),
  ]);
  const cf = buildCaseFile("s-over")!;
  assert.ok(!cf.composition.some((c) => c.key === "overhead"), "no negative overhead slice");
  assert.ok(cf.notes.some((n) => /exceed the observed total/.test(n)));
});

// ---------- trajectory ----------

test("trajectory keeps one point per usage-bearing request and marks the compaction", () => {
  compactedSession("s-traj");
  const cf = buildCaseFile("s-traj")!;
  assert.equal(cf.trajectory.totalTurns, 2, "a1 and a2; the sidechain turn is excluded");
  assert.equal(cf.trajectory.turns[0].contextTokens, 5 + 10_000 + 500 + 100);
  assert.equal(cf.trajectory.turns[0].afterCompaction, false);
  assert.equal(cf.trajectory.turns[1].afterCompaction, true, "a2 follows the boundary");
  assert.deepEqual(cf.trajectory.turns.map((t) => t.n), [1, 2]);
});

// ---------- tools ----------

test("tool registry ranks observed use above configuration above the static built-in list", () => {
  ingest("s-tools", [
    attachmentLine("deferred_tools_delta", {
      addedNames: ["WebFetch", "mcp__linear__list_issues"],
      removedNames: [],
    }),
    attachmentLine("skill_listing", { names: ["brainstorming"] }),
    assistantLine({
      uuid: "a1",
      ts: at(1),
      model: "claude-opus-5",
      usage: { input: 10 },
      toolUses: [
        { id: "toolu_1", name: "Read", input: { file_path: "/a.ts" } },
        { id: "toolu_2", name: "mcp__linear__list_issues", input: {} },
      ],
    }),
    assistantLine({
      uuid: "a2",
      ts: at(2),
      model: "claude-opus-5",
      usage: { input: 20 },
      toolUses: [{ id: "toolu_3", name: "Read", input: { file_path: "/b.ts" } }],
    }),
  ]);
  const cf = buildCaseFile("s-tools")!;
  const byName = new Map(cf.tools.map((t) => [t.name, t]));

  const read = byName.get("Read")!;
  assert.equal(read.status, "used");
  assert.equal(read.useCount, 2);
  assert.equal(read.lastUsedAt, at(2));

  // A deferred tool that was then actually called must read as used, with its real provider.
  const mcp = byName.get("mcp__linear__list_issues")!;
  assert.equal(mcp.status, "used");
  assert.equal(mcp.provider, 'MCP server "linear"');

  // Listed but never invoked.
  assert.equal(byName.get("skill:brainstorming")!.status, "active");
  assert.equal(byName.get("WebFetch")!.status, "deferred", "deferred beats the assumed built-in");
  assert.equal(byName.get("Grep")!.status, "assumed");

  const rank = ["used", "active", "deferred", "configured", "assumed"];
  const positions = cf.tools.map((t) => rank.indexOf(t.status));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sorted by signal strength");
});

test("a missing ~/.claude.json is surfaced as a note, not silently a smaller registry", () => {
  compactedSession("s-confignote");
  const cf = buildCaseFile("s-confignote")!;
  assert.ok(cf.notes.some((n) => /MCP configuration unknown/.test(n)));
});

// ---------- activity ----------

test("activity is newest-first and separates file reads, tool calls and compactions", () => {
  compactedSession("s-act");
  const cf = buildCaseFile("s-act")!;
  const kinds = cf.activity.map((a) => a.kind);

  assert.ok(kinds.includes("file_read"), "a Read call is its own kind");
  assert.ok(kinds.includes("tool_result"));
  assert.ok(kinds.includes("compaction"));
  assert.ok(kinds.includes("user_prompt"));
  assert.ok(!cf.activity.some((a) => a.detail?.includes("subagent turn")), "sidechains excluded");

  const times = cf.activity.filter((a) => a.ts).map((a) => Date.parse(a.ts!));
  assert.deepEqual([...times].sort((a, b) => b - a), times, "newest first");
});

// ---------- evidence cap ----------

test("very long sessions transport the newest window and say how much was cut", () => {
  const lines: string[] = [];
  for (let i = 0; i < 830; i++) lines.push(userLine(`msg ${i}`, { uuid: `u${i}`, ts: at(i) }));
  ingest("s-cap", lines);
  const cf = buildCaseFile("s-cap")!;

  assert.equal(cf.evidence.length, 800);
  assert.equal(cf.evidence.at(-1)!.uuid, "u829", "the newest entry is kept");
  assert.equal(cf.case.eventCount, 830, "the count still reports the whole session");
  assert.ok(cf.notes.some((n) => /most recent 800 of 830/.test(n)));
});

// ---------- case summary ----------

test("the case summary carries the session identity through unchanged", () => {
  compactedSession("s-summary");
  const cf = buildCaseFile("s-summary")!;
  assert.equal(cf.case.sessionId, "s-summary");
  assert.equal(cf.case.eventCount, 9);
  assert.equal(cf.case.model, "claude-opus-5");
  assert.ok(cf.case.transcriptPath?.endsWith("s-summary.jsonl"));
  assert.ok(!Number.isNaN(Date.parse(cf.generatedAt)));
});
