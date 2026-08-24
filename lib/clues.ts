// The clue engine: actionable observations derived from evidence.
// Each clue carries a Confidence label so observed facts are never
// presented with the same authority as heuristics.

import type { Clue, EvidenceItem, Meter, ToolInfo } from "./types.ts";
import type { ToolUseRow } from "./db.ts";
import { formatTokens } from "./estimate.ts";

interface ClueInputs {
  meter: Meter;
  evidence: EvidenceItem[];
  toolUses: ToolUseRow[];
  tools: ToolInfo[];
  compactions: { lineNo: number; trigger: string | null; preTokens: number | null; postTokens: number | null }[];
  compactedOutCount: number;
}

export function deriveClues(inp: ClueInputs): Clue[] {
  const clues: Clue[] = [];
  const { meter } = inp;
  // When the model's window is unknown, fall back to the largest current window so the
  // "large evidence" rules still compare against something plausible rather than crashing.
  const windowSize = meter.maxTokens ?? 1_000_000;
  const included = inp.evidence.filter((e) => e.inclusion === "assumed-included");

  // 1. Context pressure
  if (meter.contextTokens != null && meter.pct != null) {
    if (meter.pct >= 70) {
      clues.push({
        id: "pressure",
        severity: meter.pct >= 85 ? "warning" : "notice",
        title: `Context window ${meter.pct.toFixed(0)}% full`,
        detail: `${formatTokens(meter.contextTokens)} of ${formatTokens(windowSize)} tokens in use at the last observed turn. Auto-compaction typically triggers near the window limit and will drop older evidence.`,
        confidence: "observed",
      });
    }
  } else {
    clues.push({
      id: "no-usage",
      severity: "info",
      title: "No token usage observed yet",
      detail:
        "No assistant turn with API usage numbers has been recorded in this transcript, so the meter is running on chars/4 estimates only.",
      confidence: "estimated",
    });
  }

  // 2. Large single pieces of evidence
  for (const e of included) {
    const pct = (e.estTokens / windowSize) * 100;
    if (pct >= 3) {
      const what =
        e.category === "tool_result"
          ? `A ${e.toolName ?? "tool"} result${e.filePath ? ` (${e.filePath})` : ""}`
          : e.category === "summary"
            ? "The compaction summary"
            : `A ${e.category.replace("_", " ")}`;
      clues.push({
        id: `large-${e.lineNo}`,
        severity: pct >= 10 ? "warning" : "notice",
        title: `${what} consumes ~${pct.toFixed(pct >= 10 ? 0 : 1)}% of the window`,
        detail: `Estimated ${formatTokens(e.estTokens)} tokens (chars/4). Preview: ${e.preview.slice(0, 140)}`,
        confidence: "estimated",
      });
    }
  }

  // 3. Duplicate file loads
  const readsByPath = new Map<string, ToolUseRow[]>();
  for (const tu of inp.toolUses) {
    if (tu.name === "Read" && tu.file_path) {
      const arr = readsByPath.get(tu.file_path) ?? [];
      arr.push(tu);
      readsByPath.set(tu.file_path, arr);
    }
  }
  for (const [path, uses] of readsByPath) {
    if (uses.length >= 2) {
      const totalChars = uses.reduce((s, u) => s + (u.result_chars ?? 0), 0);
      clues.push({
        id: `dupfile-${path}`,
        severity: uses.length >= 3 ? "warning" : "notice",
        title: `The same file was loaded ${uses.length} times`,
        detail: `${path} was read ${uses.length} times (~${formatTokens(Math.ceil(totalChars / 4))} tokens total, estimated). Earlier copies may still occupy context.`,
        confidence: "observed",
      });
    }
  }

  // 4. Duplicate large tool results (identical previews)
  const seenPreviews = new Map<string, EvidenceItem[]>();
  for (const e of included) {
    if (e.category === "tool_result" && e.chars > 2000) {
      const key = `${e.chars}:${e.preview}`;
      const arr = seenPreviews.get(key) ?? [];
      arr.push(e);
      seenPreviews.set(key, arr);
    }
  }
  for (const [, items] of seenPreviews) {
    if (items.length >= 2) {
      clues.push({
        id: `duptool-${items[0].lineNo}`,
        severity: "notice",
        title: `${items.length} near-identical tool results in context`,
        detail: `~${formatTokens(items[0].estTokens)} tokens each (estimated). First seen at entry #${items[0].lineNo}. Repeated output usually means duplicated work.`,
        confidence: "estimated",
      });
    }
  }

  // 5. Compaction events
  for (const c of inp.compactions) {
    const dropped = c.preTokens != null && c.postTokens != null ? c.preTokens - c.postTokens : null;
    clues.push({
      id: `compact-${c.lineNo}`,
      severity: "info",
      title:
        inp.compactedOutCount > 0
          ? `A compacted summary replaced ${inp.compactedOutCount} earlier records`
          : "This session has been compacted",
      detail: `${c.trigger === "auto" ? "Auto" : "Manual"} compaction reduced context from ${formatTokens(c.preTokens)} to ${formatTokens(c.postTokens)} tokens${dropped != null ? ` (${formatTokens(dropped)} dropped)` : ""}. Exact numbers from the CLI's own compaction record.`,
      confidence: "observed",
    });
  }

  // 6. Enabled-but-unused tools. Deferred names are counted separately — they are
  // visible to the session but their schemas cost almost nothing until loaded.
  const unusedActive = inp.tools.filter(
    (t) => (t.status === "active" || t.status === "assumed") && t.useCount === 0 && !t.name.endsWith("*"),
  );
  const unusedDeferred = inp.tools.filter((t) => t.status === "deferred" && t.useCount === 0);
  if (unusedActive.length >= 3) {
    clues.push({
      id: "unused-tools",
      severity: "info",
      title: `${unusedActive.length} enabled tools have not been used in this session`,
      detail: `Including ${unusedActive
        .slice(0, 6)
        .map((t) => t.name)
        .join(", ")}${unusedActive.length > 6 ? ", …" : ""}. Their schemas occupy context whether used or not.${
        unusedDeferred.length ? ` A further ${unusedDeferred.length} deferred tool names are loadable but unloaded (near-zero cost).` : ""
      }`,
      confidence: "observed",
    });
  }

  // 7. Stale heavy evidence
  const now = Date.now();
  for (const e of included) {
    if (!e.ts || e.estTokens < windowSize * 0.02) continue;
    const ageMin = (now - Date.parse(e.ts)) / 60000;
    if (ageMin > 45 && e.category === "tool_result") {
      clues.push({
        id: `stale-${e.lineNo}`,
        severity: "info",
        title: `A ${formatTokens(e.estTokens)}-token tool result is ${Math.round(ageMin)} minutes old`,
        detail: `${e.toolName ?? "Tool"} output from ${new Date(e.ts).toLocaleTimeString()} likely still occupies context${e.filePath ? ` (${e.filePath})` : ""}. If it is no longer relevant, compaction would reclaim it.`,
        confidence: "estimated",
      });
    }
  }

  const severityRank = { warning: 0, notice: 1, info: 2 } as const;
  clues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return clues.slice(0, 20);
}
