import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, contextWindowForModel, formatTokens } from "../lib/estimate.ts";
import { redact, redactedPreview } from "../lib/redact.ts";
import { parseTranscriptLine } from "../lib/transcript.ts";
import { deriveClues } from "../lib/clues.ts";
import type { Meter } from "../lib/types.ts";

test("estimateTokens uses chars/4 rounded up", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(-10), 0);
});

// Full window-table coverage lives in test/trajectory.test.ts. This case previously
// asserted a 200k default, which was the bug: every current model is 1M.

test("formatTokens", () => {
  assert.equal(formatTokens(998_375), "998k");
  assert.equal(formatTokens(1_500_000), "1.50M");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(null), "—");
});

test("redact scrubs common secrets", () => {
  assert.ok(!redact("key sk-ant-api03-abcdefghijkl").includes("sk-ant-api03"));
  assert.ok(!redact("AKIAIOSFODNN7EXAMPLE").includes("AKIAIOSFODNN7"));
  assert.ok(!redact("ghp_0123456789abcdefghij123").includes("ghp_0123456789"));
  assert.ok(redact("MY_API_KEY=supersecretvalue").includes("[REDACTED:env-assignment]"));
  assert.ok(redact("MY_API_KEY=supersecretvalue").startsWith("MY_API_KEY="));
  const clean = "just ordinary text with no secrets, PATH=/usr/bin";
  assert.equal(redact(clean), clean);
});

test("redactedPreview collapses whitespace and clamps", () => {
  const p = redactedPreview("a\n\n  b   c" + "x".repeat(500), 50);
  assert.ok(p.length <= 50);
  assert.ok(p.startsWith("a b c"));
});

test("parse user prompt record", () => {
  const line = JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-08-24T18:00:00.000Z",
    message: { role: "user", content: "Build me a dashboard" },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.equal(ev.category, "user_message");
  assert.equal(ev.chars, "Build me a dashboard".length);
  assert.ok(ev.estTokens > 0);
});

test("parse tool_result user record", () => {
  const line = JSON.stringify({
    type: "user",
    uuid: "u2",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "file contents here" }],
    },
    toolUseResult: { stdout: "x" },
  });
  const ev = parseTranscriptLine(line, 2)!;
  assert.equal(ev.category, "tool_result");
  assert.equal(ev.toolUseId, "toolu_123");
  assert.ok(ev.chars >= "file contents here".length);
});

test("parse assistant record with usage and tool_use", () => {
  const line = JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: {
      model: "claude-fable-5",
      content: [
        { type: "text", text: "Working on it." },
        { type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "/tmp/x.ts" } },
      ],
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 57885,
        cache_creation_input_tokens: 1610,
        output_tokens: 718,
      },
    },
  });
  const ev = parseTranscriptLine(line, 3)!;
  assert.equal(ev.category, "assistant_message");
  assert.equal(ev.extra.model, "claude-fable-5");
  assert.deepEqual(ev.extra.usage, { input: 2, cacheRead: 57885, cacheCreation: 1610, output: 718 });
  assert.equal(ev.toolUses.length, 1);
  assert.equal(ev.toolUses[0].name, "Read");
  assert.equal(ev.toolUses[0].filePath, "/tmp/x.ts");
});

test("parse total_tokens_reminder attachment", () => {
  const line = JSON.stringify({
    type: "attachment",
    uuid: "at1",
    attachment: { type: "total_tokens_reminder", text: "<total_tokens>14946352 tokens left</total_tokens>" },
  });
  const ev = parseTranscriptLine(line, 4)!;
  assert.equal(ev.category, "injected_context");
  assert.equal(ev.extra.budgetTokensLeft, 14946352);
});

test("parse compact_boundary system record", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid: "s1",
    compactMetadata: {
      trigger: "auto",
      preTokens: 998375,
      postTokens: 34405,
      cumulativeDroppedTokens: 963970,
      preservedMessages: { uuids: ["keep-1", "keep-2"] },
      preCompactDiscoveredTools: ["WebFetch"],
    },
  });
  const ev = parseTranscriptLine(line, 5)!;
  assert.equal(ev.category, "system_event");
  assert.equal(ev.extra.compact?.preTokens, 998375);
  assert.deepEqual(ev.extra.compact?.preservedUuids, ["keep-1", "keep-2"]);
});

test("meta records are excluded from context accounting", () => {
  for (const t of ["file-history-snapshot", "mode", "permission-mode", "last-prompt", "ai-title"]) {
    const ev = parseTranscriptLine(JSON.stringify({ type: t }), 6)!;
    assert.equal(ev.category, "meta");
    assert.equal(ev.estTokens, 0);
  }
});

test("malformed lines return null instead of throwing", () => {
  assert.equal(parseTranscriptLine("not json {", 7), null);
  assert.equal(parseTranscriptLine('"just a string"', 8), null);
});

function meterAt(pct: number): Meter {
  const max = 200_000;
  return {
    contextTokens: Math.round((pct / 100) * max),
    observedAt: new Date().toISOString(),
    maxTokens: max,
    maxTokensConfidence: "assumed",
    pct,
    model: "claude-fable-5",
    usageBreakdown: null,
    estTokensSinceObserved: 0,
    budgetTokensLeft: null,
    confidence: "observed",
  };
}

test("clue engine: pressure, duplicate reads, compaction", () => {
  const clues = deriveClues({
    meter: meterAt(88),
    evidence: [],
    toolUses: [
      { tool_use_id: "1", session_id: "s", line_no: 1, ts: null, name: "Read", file_path: "/a.ts", input_chars: 10, input_preview: "", result_chars: 4000, result_line_no: 2 },
      { tool_use_id: "2", session_id: "s", line_no: 3, ts: null, name: "Read", file_path: "/a.ts", input_chars: 10, input_preview: "", result_chars: 4000, result_line_no: 4 },
      { tool_use_id: "3", session_id: "s", line_no: 5, ts: null, name: "Read", file_path: "/a.ts", input_chars: 10, input_preview: "", result_chars: 4000, result_line_no: 6 },
    ],
    tools: [],
    compactions: [{ lineNo: 10, trigger: "auto", preTokens: 998375, postTokens: 34405 }],
    compactedOutCount: 42,
  });
  assert.ok(clues.some((c) => c.id === "pressure" && c.severity === "warning"));
  const dup = clues.find((c) => c.id.startsWith("dupfile-"));
  assert.ok(dup);
  assert.match(dup!.title, /loaded 3 times/);
  const compact = clues.find((c) => c.id.startsWith("compact-"));
  assert.ok(compact);
  assert.match(compact!.title, /replaced 42 earlier records/);
});
