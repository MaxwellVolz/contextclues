// Normalizes raw Claude CLI transcript JSONL records into evidence rows.
// Field access here is defensive: only fields verified in DISCOVERY.md are relied on,
// and every unknown shape falls back to a generic, clearly-labeled row.

import type { EvidenceCategory } from "./types.ts";
import { estimateTokens } from "./estimate.ts";
import { redactedPreview } from "./redact.ts";

export interface ToolUseRef {
  id: string;
  name: string;
  filePath: string | null;
  inputChars: number;
  inputPreview: string;
}

export interface UsageObserved {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export interface CompactObserved {
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  cumulativeDroppedTokens: number | null;
  preservedUuids: string[];
  discoveredTools: string[];
}

export interface EventExtra {
  usage?: UsageObserved;
  model?: string;
  compact?: CompactObserved;
  attachmentType?: string;
  skillNames?: string[];
  toolsAdded?: string[];
  toolsRemoved?: string[];
  pendingMcpServers?: string[];
  budgetTokensLeft?: number;
}

export interface NormalizedEvent {
  lineNo: number;
  uuid: string | null;
  parentUuid: string | null;
  ts: string | null;
  type: string;
  subtype: string | null;
  category: EvidenceCategory;
  chars: number;
  estTokens: number;
  preview: string;
  toolUseId: string | null;
  filePath: string | null;
  isSidechain: boolean;
  isCompactSummary: boolean;
  extra: EventExtra;
  toolUses: ToolUseRef[];
}

/** Record types that are CLI bookkeeping, never sent to the model. */
const META_TYPES = new Set([
  "file-history-snapshot",
  "ai-title",
  "atis-latch",
  "bridge-session",
  "last-prompt",
  "mode",
  "permission-mode",
  "summary",
  "queued-prompt",
  "pr-link",
]);

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractFilePath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const key of ["file_path", "filePath", "path", "notebook_path", "url"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Flatten a content block array (text / thinking / tool_use / tool_result / image) to text. */
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block == null || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  if (typeof b.thinking === "string") return ""; // thinking is ephemeral; excluded from estimates
  if (b.type === "tool_result") {
    const c = b.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map(blockText).join("\n");
    return "";
  }
  if (b.type === "image") return "[image]";
  return "";
}

export function parseTranscriptLine(raw: string, lineNo: number): NormalizedEvent | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (rec == null || typeof rec !== "object") return null;

  const type = asString(rec.type) ?? "unknown";
  const base: NormalizedEvent = {
    lineNo,
    uuid: asString(rec.uuid),
    parentUuid: asString(rec.parentUuid),
    ts: asString(rec.timestamp),
    type,
    subtype: asString(rec.subtype),
    category: "meta",
    chars: 0,
    estTokens: 0,
    preview: "",
    toolUseId: null,
    filePath: null,
    isSidechain: rec.isSidechain === true,
    isCompactSummary: rec.isCompactSummary === true,
    extra: {},
    toolUses: [],
  };

  if (META_TYPES.has(type)) {
    base.preview = `[${type}] CLI bookkeeping record`;
    return base;
  }

  const message = (rec.message ?? {}) as Record<string, unknown>;
  const content = message.content;

  if (type === "user") {
    if (base.isCompactSummary) {
      base.category = "summary";
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(blockText).join("\n") : "";
      base.chars = text.length;
      base.preview = redactedPreview(text);
      base.estTokens = estimateTokens(base.chars);
      return base;
    }
    if (typeof content === "string") {
      base.category = "user_message";
      base.chars = content.length;
      base.preview = redactedPreview(content);
    } else if (Array.isArray(content)) {
      const toolResults = content.filter(
        (b) => b != null && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
      ) as Record<string, unknown>[];
      const text = content.map(blockText).join("\n");
      base.chars = text.length;
      base.preview = redactedPreview(text);
      if (toolResults.length > 0) {
        base.category = "tool_result";
        base.toolUseId = asString(toolResults[0].tool_use_id);
      } else {
        base.category = "user_message";
      }
    } else {
      base.category = "user_message";
      base.preview = "[user record with unrecognized content shape]";
    }
    base.estTokens = estimateTokens(base.chars);
    return base;
  }

  if (type === "assistant") {
    base.category = "assistant_message";
    const model = asString(message.model);
    if (model) base.extra.model = model;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const input = asNumber(usage.input_tokens);
      if (input != null) {
        base.extra.usage = {
          input,
          cacheRead: asNumber(usage.cache_read_input_tokens) ?? 0,
          cacheCreation: asNumber(usage.cache_creation_input_tokens) ?? 0,
          output: asNumber(usage.output_tokens) ?? 0,
        };
      }
    }
    let chars = 0;
    const previews: string[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block == null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          chars += b.text.length;
          previews.push(b.text);
        } else if (b.type === "tool_use") {
          const id = asString(b.id);
          const name = asString(b.name);
          const input = (b.input ?? {}) as Record<string, unknown>;
          let inputJson = "";
          try {
            inputJson = JSON.stringify(input);
          } catch {
            inputJson = "";
          }
          chars += inputJson.length;
          if (id && name) {
            base.toolUses.push({
              id,
              name,
              filePath: extractFilePath(input),
              inputChars: inputJson.length,
              inputPreview: redactedPreview(inputJson, 160),
            });
          }
          previews.push(`⚙ ${name ?? "tool"}(${redactedPreview(inputJson, 80)})`);
        }
      }
    }
    base.chars = chars;
    base.estTokens = estimateTokens(chars);
    base.preview = redactedPreview(previews.join(" ") || "[assistant turn]");
    return base;
  }

  if (type === "attachment") {
    base.category = "injected_context";
    const att = (rec.attachment ?? {}) as Record<string, unknown>;
    const attType = asString(att.type) ?? "unknown";
    base.subtype = attType;
    base.extra.attachmentType = attType;
    let text = "";
    if (typeof att.text === "string") text = att.text;
    else if (typeof att.content === "string") text = att.content;
    else {
      try {
        text = JSON.stringify(att);
      } catch {
        text = "";
      }
    }
    base.chars = text.length;
    base.estTokens = estimateTokens(base.chars);
    base.preview = redactedPreview(`[${attType}] ${text}`);
    if (attType === "total_tokens_reminder") {
      const m = /<total_tokens>\s*([\d,]+)\s*tokens left/.exec(text);
      if (m) base.extra.budgetTokensLeft = Number(m[1].replace(/,/g, ""));
    }
    if (attType === "skill_listing" && Array.isArray(att.names)) {
      base.extra.skillNames = (att.names as unknown[]).filter((n): n is string => typeof n === "string");
    }
    if (attType === "deferred_tools_delta") {
      if (Array.isArray(att.addedNames)) {
        base.extra.toolsAdded = (att.addedNames as unknown[]).filter((n): n is string => typeof n === "string");
      }
      if (Array.isArray(att.removedNames)) {
        base.extra.toolsRemoved = (att.removedNames as unknown[]).filter((n): n is string => typeof n === "string");
      }
      if (Array.isArray(att.pendingMcpServers)) {
        base.extra.pendingMcpServers = (att.pendingMcpServers as unknown[]).filter(
          (n): n is string => typeof n === "string",
        );
      }
    }
    return base;
  }

  if (type === "system") {
    // Duration/hook-summary markers carry no content and are never sent to the model.
    if (base.subtype === "turn_duration" || base.subtype === "stop_hook_summary") {
      base.preview = `[system:${base.subtype}] bookkeeping marker`;
      return base; // stays category "meta"
    }
    base.category = "system_event";
    const contentStr = asString(rec.content) ?? "";
    base.chars = contentStr.length;
    base.estTokens = estimateTokens(base.chars);
    base.preview = redactedPreview(contentStr || `[system:${base.subtype ?? "?"}]`);
    if (base.subtype === "compact_boundary") {
      const meta = (rec.compactMetadata ?? {}) as Record<string, unknown>;
      const preserved = (meta.preservedMessages ?? {}) as Record<string, unknown>;
      base.extra.compact = {
        trigger: asString(meta.trigger),
        preTokens: asNumber(meta.preTokens),
        postTokens: asNumber(meta.postTokens),
        cumulativeDroppedTokens: asNumber(meta.cumulativeDroppedTokens),
        preservedUuids: Array.isArray(preserved.uuids)
          ? (preserved.uuids as unknown[]).filter((u): u is string => typeof u === "string")
          : [],
        discoveredTools: Array.isArray(meta.preCompactDiscoveredTools)
          ? (meta.preCompactDiscoveredTools as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
      };
      base.preview = `Compaction (${base.extra.compact.trigger ?? "unknown trigger"}): ${
        base.extra.compact.preTokens ?? "?"
      } → ${base.extra.compact.postTokens ?? "?"} tokens`;
    }
    return base;
  }

  // Unknown record type: keep it visible but out of context accounting.
  base.category = "meta";
  base.preview = `[${type}] unrecognized record type`;
  return base;
}
