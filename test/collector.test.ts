// The incremental tail-parser. Transcripts are appended to while we read them, so
// the interesting cases are all about partial writes and resumed offsets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assistantLine, at, tempDir, toolResultLine, userLine, writeTranscript } from "./helpers.ts";

const root = tempDir("collector");
process.env.CONTEXTCLUES_DATA_DIR = join(root, "data");
process.env.CONTEXTCLUES_CLAUDE_DIR = join(root, "claude");

const { Collector } = await import("../lib/collector.ts");
const { getDb } = await import("../lib/db.ts");

function session(id: string): { path: string; ingest: () => void } {
  mkdirSync(join(root, "transcripts"), { recursive: true });
  const path = join(root, "transcripts", `${id}.jsonl`);
  const collector = new Collector();
  getDb().upsertSession({ session_id: id, transcript_path: path });
  return { path, ingest: () => collector.ingest(id, path) };
}

test("a half-written trailing line is not ingested until its newline arrives", () => {
  const s = session("c-partial");
  const complete = userLine("first", { uuid: "u1", ts: at(0) });
  const partial = userLine("second", { uuid: "u2", ts: at(1) });

  // The last line has no terminating newline yet — a writer mid-flush.
  writeFileSync(s.path, complete + "\n" + partial.slice(0, 30), "utf8");
  s.ingest();

  const db = getDb();
  assert.equal(db.eventsForSession("c-partial").length, 1, "only the complete line");
  assert.equal(db.getIngestState("c-partial")!.line_no, 1);

  // The writer finishes the line.
  writeFileSync(s.path, complete + "\n" + partial + "\n", "utf8");
  s.ingest();

  const rows = db.eventsForSession("c-partial");
  assert.equal(rows.length, 2, "the re-read line is now complete");
  assert.deepEqual(rows.map((r) => r.uuid), ["u1", "u2"], "and is not duplicated");
});

test("appending resumes from the stored offset instead of re-reading the file", () => {
  const s = session("c-append");
  writeTranscript(s.path, [userLine("a", { uuid: "u1", ts: at(0) })]);
  s.ingest();
  const afterFirst = getDb().getIngestState("c-append")!;
  assert.equal(afterFirst.line_no, 1);

  appendFileSync(s.path, userLine("b", { uuid: "u2", ts: at(1) }) + "\n", "utf8");
  s.ingest();

  const db = getDb();
  assert.deepEqual(db.eventsForSession("c-append").map((r) => r.line_no), [1, 2]);
  assert.ok(db.getIngestState("c-append")!.byte_offset > afterFirst.byte_offset);
});

test("ingesting an unchanged file is a no-op", () => {
  const s = session("c-noop");
  writeTranscript(s.path, [userLine("a", { uuid: "u1", ts: at(0) })]);
  s.ingest();
  const before = getDb().getIngestState("c-noop")!;
  s.ingest();
  s.ingest();
  assert.deepEqual(getDb().getIngestState("c-noop"), before);
  assert.equal(getDb().eventsForSession("c-noop").length, 1);
});

test("a file that shrank was rewritten, so the session is re-ingested from scratch", () => {
  const s = session("c-truncate");
  writeTranscript(s.path, [
    userLine("a", { uuid: "u1", ts: at(0) }),
    userLine("b", { uuid: "u2", ts: at(1) }),
    userLine("c", { uuid: "u3", ts: at(2) }),
  ]);
  s.ingest();
  assert.equal(getDb().eventsForSession("c-truncate").length, 3);

  writeTranscript(s.path, [userLine("fresh", { uuid: "z1", ts: at(0) })]);
  s.ingest();

  const rows = getDb().eventsForSession("c-truncate");
  assert.deepEqual(rows.map((r) => r.uuid), ["z1"], "stale rows are cleared, not merged");
  assert.equal(getDb().getIngestState("c-truncate")!.line_no, 1);
});

test("a tool result is linked back to the call that produced it", () => {
  const s = session("c-link");
  writeTranscript(s.path, [
    assistantLine({
      uuid: "a1",
      ts: at(0),
      model: "claude-opus-5",
      usage: { input: 10 },
      toolUses: [{ id: "toolu_1", name: "Read", input: { file_path: "/src/x.ts" } }],
    }),
    toolResultLine("toolu_1", "z".repeat(1234), { uuid: "r1", ts: at(1) }),
  ]);
  s.ingest();

  const db = getDb();
  const tu = db.getToolUse("toolu_1")!;
  assert.equal(tu.name, "Read");
  assert.equal(tu.file_path, "/src/x.ts");
  assert.equal(tu.result_chars, 1234, "the result size is attributed to the call");
  assert.equal(tu.result_line_no, 2);

  // The result row itself learns the tool name and path, so evidence can label it.
  const resultRow = db.eventsForSession("c-link").find((r) => r.line_no === 2)!;
  assert.equal(resultRow.tool_name, "Read");
  assert.equal(resultRow.file_path, "/src/x.ts");
});

test("re-ingesting a call record keeps the result already linked to it", () => {
  const s = session("c-relink");
  writeTranscript(s.path, [
    assistantLine({
      uuid: "a1",
      ts: at(0),
      model: "claude-opus-5",
      usage: { input: 10 },
      toolUses: [{ id: "toolu_9", name: "Grep", input: { pattern: "x" } }],
    }),
    toolResultLine("toolu_9", "match", { uuid: "r1", ts: at(1) }),
  ]);
  s.ingest();
  assert.equal(getDb().getToolUse("toolu_9")!.result_chars, 5);

  // A truncate-and-rewrite replays the call record over the existing row.
  getDb().resetSession("c-relink");
  s.ingest();
  assert.equal(getDb().getToolUse("toolu_9")!.result_chars, 5, "result survives the replay");
});

test("the model id is captured from assistant records", () => {
  const s = session("c-model");
  writeTranscript(s.path, [
    userLine("hi", { uuid: "u1", ts: at(0) }),
    assistantLine({ uuid: "a1", ts: at(1), text: "hello", model: "claude-sonnet-5", usage: { input: 1 } }),
  ]);
  s.ingest();
  assert.equal(getDb().getSession("c-model")!.model, "claude-sonnet-5");
});

test("blank and malformed lines are skipped without derailing the rest", () => {
  const s = session("c-junk");
  writeFileSync(
    s.path,
    [userLine("a", { uuid: "u1", ts: at(0) }), "", "not json {", userLine("b", { uuid: "u2", ts: at(1) })].join(
      "\n",
    ) + "\n",
    "utf8",
  );
  s.ingest();
  const rows = getDb().eventsForSession("c-junk");
  assert.deepEqual(rows.map((r) => r.uuid), ["u1", "u2"]);
  // Blank lines are not numbered; the malformed one is, so the good lines are 1 and 3.
  assert.deepEqual(rows.map((r) => r.line_no), [1, 3]);
});

test("a missing transcript file is tolerated", () => {
  const s = session("c-missing");
  assert.doesNotThrow(() => s.ingest());
  assert.equal(getDb().eventsForSession("c-missing").length, 0);
});

test("multi-byte characters do not desynchronize the byte offset", () => {
  const s = session("c-utf8");
  writeTranscript(s.path, [userLine("héllo — 日本語 🔎", { uuid: "u1", ts: at(0) })]);
  s.ingest();
  appendFileSync(s.path, userLine("ascii", { uuid: "u2", ts: at(1) }) + "\n", "utf8");
  s.ingest();

  const rows = getDb().eventsForSession("c-utf8");
  assert.deepEqual(rows.map((r) => r.uuid), ["u1", "u2"], "no dropped or duplicated line");
});
