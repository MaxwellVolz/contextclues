import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, contextWindowForModel, formatTokens } from "../lib/estimate.ts";
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
      { tool_use_id: "1", session_id: "s", line_no: 1, ts: null, name: "Read", file_path: "/a.ts", input_preview: "", result_chars: 4000, result_line_no: 2 },
      { tool_use_id: "2", session_id: "s", line_no: 3, ts: null, name: "Read", file_path: "/a.ts", input_preview: "", result_chars: 4000, result_line_no: 4 },
      { tool_use_id: "3", session_id: "s", line_no: 5, ts: null, name: "Read", file_path: "/a.ts", input_preview: "", result_chars: 4000, result_line_no: 6 },
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

// ---------- transcript branches the parser must not get wrong ----------

test("thinking blocks are excluded from the size estimate", () => {
  const line = JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: {
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "z".repeat(10_000) },
        { type: "text", text: "short answer" },
      ],
    },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.equal(ev.chars, "short answer".length, "ephemeral reasoning is not context");
});

test("an assistant turn without usage still parses, just without a usage record", () => {
  const line = JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: { model: "claude-opus-5", content: [{ type: "text", text: "hi" }] },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.equal(ev.extra.usage, undefined);
  assert.equal(ev.extra.model, "claude-opus-5");
});

test("deferred_tools_delta records added and removed tool names", () => {
  const line = JSON.stringify({
    type: "attachment",
    attachment: {
      type: "deferred_tools_delta",
      addedNames: ["WebSearch", 42, "mcp__x__y"],
      removedNames: ["Bash"],
    },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.equal(ev.subtype, "deferred_tools_delta");
  assert.deepEqual(ev.extra.toolsAdded, ["WebSearch", "mcp__x__y"], "non-strings are dropped");
  assert.deepEqual(ev.extra.toolsRemoved, ["Bash"]);
});

test("skill_listing records the skills offered to the session", () => {
  const line = JSON.stringify({
    type: "attachment",
    attachment: { type: "skill_listing", names: ["brainstorming", "shipping"] },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.deepEqual(ev.extra.skillNames, ["brainstorming", "shipping"]);
});

test("a token reminder without a parseable figure leaves the budget unset", () => {
  const line = JSON.stringify({
    type: "attachment",
    attachment: { type: "total_tokens_reminder", text: "no number here" },
  });
  assert.equal(parseTranscriptLine(line, 1)!.extra.budgetTokensLeft, undefined);
});

test("system bookkeeping markers are meta, but real system content is not", () => {
  for (const subtype of ["turn_duration", "stop_hook_summary"]) {
    const ev = parseTranscriptLine(JSON.stringify({ type: "system", subtype }), 1)!;
    assert.equal(ev.category, "meta", subtype);
    assert.equal(ev.estTokens, 0);
  }
  const real = parseTranscriptLine(
    JSON.stringify({ type: "system", subtype: "hook_output", content: "injected by a hook" }),
    1,
  )!;
  assert.equal(real.category, "system_event");
  assert.ok(real.estTokens > 0);
});

test("a compaction summary is its own category, not a user message", () => {
  const line = JSON.stringify({
    type: "user",
    uuid: "s1",
    isCompactSummary: true,
    message: { role: "user", content: "Here is what happened so far." },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.equal(ev.category, "summary");
  assert.equal(ev.isCompactSummary, true);
  assert.ok(ev.estTokens > 0);
});

test("an unrecognized record type is kept visible but out of the accounting", () => {
  const ev = parseTranscriptLine(JSON.stringify({ type: "some-future-record" }), 1)!;
  assert.equal(ev.category, "meta");
  assert.equal(ev.estTokens, 0);
  assert.match(ev.preview, /unrecognized record type/);
});

test("a user record with an unexpected content shape degrades rather than throws", () => {
  const ev = parseTranscriptLine(JSON.stringify({ type: "user", message: { content: 42 } }), 1)!;
  assert.equal(ev.category, "user_message");
  assert.equal(ev.estTokens, 0);
  assert.match(ev.preview, /unrecognized content shape/);
});

test("a tool call's file path is found under any of the known input keys", () => {
  const cases: [Record<string, unknown>, string | null][] = [
    [{ file_path: "/a" }, "/a"],
    [{ filePath: "/b" }, "/b"],
    [{ path: "/c" }, "/c"],
    [{ notebook_path: "/d" }, "/d"],
    [{ url: "https://e" }, "https://e"],
    [{ pattern: "x" }, null],
  ];
  for (const [input, expected] of cases) {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "T", input }] },
    });
    assert.equal(parseTranscriptLine(line, 1)!.toolUses[0].filePath, expected, JSON.stringify(input));
  }
});

test("image blocks are counted as a placeholder, not as zero", () => {
  const line = JSON.stringify({
    type: "user",
    message: { content: [{ type: "image", source: { data: "AAAA" } }] },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.equal(ev.preview, "[image]");
});

test("secrets are scrubbed from previews before anything is stored", () => {
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: "deploy with sk-" + "ant-api03-abcdefghijklmnop please" },
  });
  const ev = parseTranscriptLine(line, 1)!;
  assert.ok(!ev.preview.includes("ant-api03-abcdefghijklmnop"));
  assert.match(ev.preview, /\[REDACTED:anthropic-key\]/);
});
