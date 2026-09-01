// Persistence semantics. The collector writes a session's facts from two different
// sources (the pid registry and the transcript), so merge behaviour is the contract
// that matters most here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { tempDir } from "./helpers.ts";

const root = tempDir("db");
process.env.CONTEXTCLUES_DATA_DIR = join(root, "data");

const { getDb } = await import("../lib/db.ts");
const { parseTranscriptLine } = await import("../lib/transcript.ts");

const db = getDb();

/** A normalized event at `lineNo`, for feeding insertEvent directly. */
function event(lineNo: number, rec: Record<string, unknown>) {
  return parseTranscriptLine(JSON.stringify(rec), lineNo)!;
}

test("a later partial upsert merges into the row instead of blanking it", () => {
  db.upsertSession({
    session_id: "d-merge",
    cwd: "/proj",
    name: "case one",
    pid: 42,
    kind: "interactive",
    status: "busy",
    live: 1,
    started_at: 100,
    cli_version: "2.1.241",
  });
  // The transcript watcher knows only the path; it must not erase the registry's fields.
  db.upsertSession({ session_id: "d-merge", transcript_path: "/t/d-merge.jsonl" });

  const row = db.getSession("d-merge")!;
  assert.equal(row.cwd, "/proj");
  assert.equal(row.name, "case one");
  assert.equal(row.pid, 42);
  assert.equal(row.cli_version, "2.1.241");
  assert.equal(row.transcript_path, "/t/d-merge.jsonl");
});

test("live=0 is written through, since COALESCE must not mistake it for absent", () => {
  db.upsertSession({ session_id: "d-live", pid: 7, live: 1 });
  assert.equal(db.getSession("d-live")!.live, 1);
  db.upsertSession({ session_id: "d-live", live: 0 });
  assert.equal(db.getSession("d-live")!.live, 0, "0 is a value, not a missing field");
});

test("setSessionModel overwrites the recorded model", () => {
  db.upsertSession({ session_id: "d-model", model: "claude-sonnet-5" });
  db.setSessionModel("d-model", "claude-opus-5");
  assert.equal(db.getSession("d-model")!.model, "claude-opus-5");
});

test("markSessionsNotLive clears everything whose pid is gone", () => {
  db.upsertSession({ session_id: "d-a", pid: 101, live: 1 });
  db.upsertSession({ session_id: "d-b", pid: 102, live: 1 });
  db.upsertSession({ session_id: "d-c", pid: null, live: 1 });

  db.markSessionsNotLive([101]);
  assert.equal(db.getSession("d-a")!.live, 1, "still running");
  assert.equal(db.getSession("d-b")!.live, 0);
  assert.equal(db.getSession("d-c")!.live, 0, "a session with no pid cannot be live");

  db.markSessionsNotLive([]);
  assert.equal(db.getSession("d-a")!.live, 0, "no live pids means nothing is live");
});

test("unknown sessions read back as undefined", () => {
  assert.equal(db.getSession("d-nope"), undefined);
  assert.equal(db.getToolUse("toolu_nope"), undefined);
  assert.equal(db.getIngestState("d-nope"), undefined);
  assert.deepEqual(db.eventsForSession("d-nope"), []);
  assert.deepEqual(db.toolUsesForSession("d-nope"), []);
});

test("sessions list live-first, then by recency", () => {
  db.upsertSession({ session_id: "d-l1", live: 1, updated_at: 1000 });
  db.upsertSession({ session_id: "d-l2", live: 1, updated_at: 5000 });
  db.upsertSession({ session_id: "d-dead", live: 0, updated_at: 9000 });

  const listed = db.listSessions(100).map((s) => s.session_id);
  assert.ok(listed.indexOf("d-l2") < listed.indexOf("d-l1"), "newer live session first");
  assert.ok(
    listed.indexOf("d-l1") < listed.indexOf("d-dead"),
    "a live session outranks a more recent dead one",
  );
  assert.equal(db.listSessions(1).length, 1, "the limit is applied");
});

test("re-inserting a line updates its content but keeps the resolved tool name", () => {
  db.insertEvent("d-event", event(1, { type: "user", uuid: "u1", message: { content: "hello" } }));
  db.setEventToolInfo("d-event", 1, "Read", "/x.ts");

  db.insertEvent("d-event", event(1, { type: "user", uuid: "u1", message: { content: "hello again" } }));

  const [row] = db.eventsForSession("d-event");
  assert.equal(row.preview, "hello again", "content is refreshed");
  assert.equal(row.tool_name, "Read", "the separately-resolved tool name survives");
  assert.equal(row.file_path, "/x.ts");
  assert.equal(db.eventsForSession("d-event").length, 1, "no duplicate row");
});

test("setEventToolInfo never clears a file path it has nothing better for", () => {
  db.insertEvent(
    "d-path",
    event(1, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } }),
  );
  db.setEventToolInfo("d-path", 1, "Read", "/keep.ts");
  db.setEventToolInfo("d-path", 1, "Read", null);
  assert.equal(db.eventsForSession("d-path")[0].file_path, "/keep.ts");
});

test("events read back in line order", () => {
  for (const n of [3, 1, 2]) {
    db.insertEvent("d-order", event(n, { type: "user", uuid: `u${n}`, message: { content: `m${n}` } }));
  }
  assert.deepEqual(db.eventsForSession("d-order").map((r) => r.line_no), [1, 2, 3]);
});

test("a tool use keeps its result when the call record is written again", () => {
  const call = {
    toolUseId: "toolu_x",
    sessionId: "d-tool",
    lineNo: 1,
    ts: "2026-08-24T12:00:00.000Z",
    name: "Read",
    filePath: "/a.ts",
    inputPreview: "{}",
  };
  db.upsertToolUse(call);
  db.setToolUseResult("toolu_x", 4096, 2);
  db.upsertToolUse({ ...call, inputPreview: '{"file_path":"/a.ts"}' });

  const row = db.getToolUse("toolu_x")!;
  assert.equal(row.result_chars, 4096, "the result is not lost to the replay");
  assert.equal(row.result_line_no, 2);
  assert.equal(row.input_preview, '{"file_path":"/a.ts"}', "the call details are refreshed");
});

test("event counts come back grouped by session", () => {
  db.insertEvent("d-count-a", event(1, { type: "user", message: { content: "x" } }));
  db.insertEvent("d-count-a", event(2, { type: "user", message: { content: "y" } }));
  db.insertEvent("d-count-b", event(1, { type: "user", message: { content: "z" } }));

  const counts = db.eventCounts();
  assert.equal(counts.get("d-count-a"), 2);
  assert.equal(counts.get("d-count-b"), 1);
  assert.equal(counts.get("d-count-none"), undefined, "sessions with no events are absent");
});

test("ingest state round-trips and is replaced on conflict", () => {
  db.setIngestState("d-ingest", "/t/a.jsonl", 100, 3);
  // node:sqlite hands back null-prototype rows, so compare fields rather than shapes.
  const state = db.getIngestState("d-ingest")!;
  assert.equal(state.session_id, "d-ingest");
  assert.equal(state.transcript_path, "/t/a.jsonl");
  assert.equal(state.byte_offset, 100);
  assert.equal(state.line_no, 3);
  db.setIngestState("d-ingest", "/t/a.jsonl", 250, 7);
  assert.equal(db.getIngestState("d-ingest")!.byte_offset, 250);
});

test("resetSession clears a session's index without touching its neighbours", () => {
  db.upsertSession({ session_id: "d-reset", transcript_path: "/t/r.jsonl" });
  db.insertEvent("d-reset", event(1, { type: "user", message: { content: "x" } }));
  db.upsertToolUse({
    toolUseId: "toolu_reset",
    sessionId: "d-reset",
    lineNo: 1,
    ts: null,
    name: "Bash",
    filePath: null,
    inputPreview: "",
  });
  db.setIngestState("d-reset", "/t/r.jsonl", 10, 1);
  db.insertEvent("d-keep", event(1, { type: "user", message: { content: "keep me" } }));

  db.resetSession("d-reset");

  assert.deepEqual(db.eventsForSession("d-reset"), []);
  assert.deepEqual(db.toolUsesForSession("d-reset"), []);
  assert.equal(db.getIngestState("d-reset"), undefined);
  assert.equal(db.eventsForSession("d-keep").length, 1, "the neighbouring session is intact");
  assert.ok(db.getSession("d-reset"), "the session row survives so it can be re-ingested");
});
