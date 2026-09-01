// Session discovery against Claude CLI's on-disk layout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir, writeFile } from "./helpers.ts";

const root = tempDir("registry");
const claude = join(root, "claude");
process.env.CONTEXTCLUES_CLAUDE_DIR = claude;

const { claudeDir, findTranscript, listRecentTranscripts, readSessionRegistry } = await import(
  "../lib/registry.ts"
);

const sessionsDir = join(claude, "sessions");
const projectsDir = join(claude, "projects");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(projectsDir, { recursive: true });

// A pid that is certainly alive (us) and one that is certainly not.
const LIVE_PID = process.pid;
const DEAD_PID = 999_999;

writeFileSync(
  join(sessionsDir, `${LIVE_PID}.json`),
  JSON.stringify({
    pid: LIVE_PID,
    sessionId: "live-session",
    cwd: "/Users/x/proj",
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    version: "2.1.241",
    kind: "interactive",
    name: "the live one",
    status: "busy",
  }),
);
writeFileSync(
  join(sessionsDir, `${DEAD_PID}.json`),
  JSON.stringify({ pid: DEAD_PID, sessionId: "dead-session", cwd: "/Users/x/old" }),
);
// Corrupt, and valid-but-anonymous: both must be skipped, not thrown on.
writeFileSync(join(sessionsDir, "1234.json"), "{ not json");
writeFileSync(join(sessionsDir, "5678.json"), JSON.stringify({ pid: 5678, cwd: "/nope" }));
// Not a <pid>.json file at all.
writeFileSync(join(sessionsDir, "notes.txt"), "ignore me");

test("claudeDir honours the environment override", () => {
  assert.equal(claudeDir(), claude);
});

test("the registry reports each session's liveness from its pid", () => {
  const entries = readSessionRegistry();
  const byId = new Map(entries.map((e) => [e.sessionId, e]));

  assert.equal(entries.length, 2, "corrupt and session-id-less files are skipped");

  const live = byId.get("live-session")!;
  assert.equal(live.alive, true);
  assert.equal(live.cwd, "/Users/x/proj");
  assert.equal(live.kind, "interactive");
  assert.equal(live.name, "the live one");
  assert.equal(live.status, "busy");
  assert.equal(live.version, "2.1.241");
  assert.equal(live.startedAt, 1_700_000_000_000);

  const dead = byId.get("dead-session")!;
  assert.equal(dead.alive, false);
  assert.equal(dead.name, null, "absent fields become null, not undefined");
});

test("a missing sessions directory yields no entries rather than throwing", () => {
  const previous = process.env.CONTEXTCLUES_CLAUDE_DIR;
  process.env.CONTEXTCLUES_CLAUDE_DIR = join(root, "nonexistent");
  try {
    assert.deepEqual(readSessionRegistry(), []);
    assert.equal(findTranscript("anything"), null);
    assert.deepEqual(listRecentTranscripts(), []);
  } finally {
    process.env.CONTEXTCLUES_CLAUDE_DIR = previous;
  }
});

test("transcripts are found by session id across project directories", () => {
  writeFile(join(projectsDir, "-Users-x-proj", "live-session.jsonl"), "");
  writeFile(join(projectsDir, "-Users-x-other", "other-session.jsonl"), "");

  assert.ok(findTranscript("live-session")!.endsWith("-Users-x-proj/live-session.jsonl"));
  assert.ok(findTranscript("other-session")!.endsWith("-Users-x-other/other-session.jsonl"));
  assert.equal(findTranscript("no-such-session"), null);
});

test("recent transcripts are filtered by mtime and returned newest first", () => {
  const recentA = writeFile(join(projectsDir, "-p1", "recent-a.jsonl"), "a");
  const recentB = writeFile(join(projectsDir, "-p1", "recent-b.jsonl"), "b");
  const old = writeFile(join(projectsDir, "-p2", "ancient.jsonl"), "c");
  // Non-.jsonl files in a project directory are ignored.
  writeFile(join(projectsDir, "-p1", "notes.md"), "not a transcript");

  const now = Date.now() / 1000;
  utimesSync(recentA, now, now - 3600); // one hour ago
  utimesSync(recentB, now, now - 60); // one minute ago
  utimesSync(old, now, now - 72 * 3600); // three days ago

  const found = listRecentTranscripts(24).map((t) => t.sessionId);
  assert.ok(found.includes("recent-a"));
  assert.ok(found.includes("recent-b"));
  assert.ok(!found.includes("ancient"), "outside the window");
  assert.ok(!found.includes("notes"), "only .jsonl files");
  assert.ok(
    found.indexOf("recent-b") < found.indexOf("recent-a"),
    "most recently modified first",
  );

  assert.ok(
    listRecentTranscripts(96).some((t) => t.sessionId === "ancient"),
    "a wider window reaches further back",
  );
});
