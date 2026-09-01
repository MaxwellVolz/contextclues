// Shared fixtures: temp directories and transcript-line builders.
//
// The builders emit the record shapes documented in DISCOVERY.md, so a test reads
// as a transcript rather than as a wall of JSON.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temp directory removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `contextclues-${prefix}-`));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; the OS reclaims tmpdir anyway
    }
  });
  return dir;
}

export function writeFile(path: string, contents: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

/** Write JSONL lines to `path`, one record per line. */
export function writeTranscript(path: string, lines: string[]): string {
  return writeFile(path, lines.length ? lines.join("\n") + "\n" : "");
}

const T0 = Date.parse("2026-08-24T12:00:00.000Z");

/** Deterministic timestamps: minute `n` after the fixture epoch. */
export function at(minute: number): string {
  return new Date(T0 + minute * 60_000).toISOString();
}

interface Common {
  uuid?: string;
  ts?: string;
  isSidechain?: boolean;
}

export function userLine(text: string, o: Common = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: o.uuid,
    timestamp: o.ts,
    isSidechain: o.isSidechain,
    message: { role: "user", content: text },
  });
}

export interface Usage {
  input: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
}

export function assistantLine(
  o: Common & {
    text?: string;
    model?: string;
    usage?: Usage;
    toolUses?: { id: string; name: string; input?: Record<string, unknown> }[];
  } = {},
): string {
  const content: Record<string, unknown>[] = [];
  if (o.text != null) content.push({ type: "text", text: o.text });
  for (const t of o.toolUses ?? []) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input ?? {} });
  }
  return JSON.stringify({
    type: "assistant",
    uuid: o.uuid,
    timestamp: o.ts,
    isSidechain: o.isSidechain,
    message: {
      role: "assistant",
      model: o.model,
      content,
      usage: o.usage && {
        input_tokens: o.usage.input,
        cache_read_input_tokens: o.usage.cacheRead ?? 0,
        cache_creation_input_tokens: o.usage.cacheCreation ?? 0,
        output_tokens: o.usage.output ?? 0,
      },
    },
  });
}

export function toolResultLine(toolUseId: string, content: string, o: Common = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: o.uuid,
    timestamp: o.ts,
    isSidechain: o.isSidechain,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  });
}

export function attachmentLine(
  type: string,
  fields: Record<string, unknown> = {},
  o: Common = {},
): string {
  return JSON.stringify({
    type: "attachment",
    uuid: o.uuid,
    timestamp: o.ts,
    attachment: { type, ...fields },
  });
}

export function compactBoundaryLine(
  o: Common & {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    preservedUuids?: string[];
  } = {},
): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid: o.uuid,
    timestamp: o.ts,
    compactMetadata: {
      trigger: o.trigger ?? "auto",
      preTokens: o.preTokens ?? 900_000,
      postTokens: o.postTokens ?? 40_000,
      preservedMessages: { uuids: o.preservedUuids ?? [] },
    },
  });
}

/** A compaction summary: the `user` record that carries the replacement history. */
export function compactSummaryLine(text: string, o: Common = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: o.uuid,
    timestamp: o.ts,
    isCompactSummary: true,
    message: { role: "user", content: text },
  });
}
