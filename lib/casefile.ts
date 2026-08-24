// Assembles the full "case file" API payload for one session from the SQLite index.

import type {
  ActivityEvent,
  CaseFile,
  CaseSummary,
  CompositionSlice,
  Confidence,
  EvidenceCategory,
  EvidenceItem,
  Inclusion,
  Meter,
  ToolInfo,
  TurnPoint,
} from "./types.ts";
import { getDb, type EventRow } from "./db.ts";
import type { EventExtra } from "./transcript.ts";
import { contextWindowForModel, formatTokens } from "./estimate.ts";
import { computeTrajectory } from "./trajectory.ts";
import { BUILTIN_TOOLS, readConfiguredSources } from "./toolsource.ts";
import { deriveClues } from "./clues.ts";

const EVIDENCE_CAP = 800;

function parseExtra(row: EventRow): EventExtra {
  if (!row.extra) return {};
  try {
    return JSON.parse(row.extra) as EventExtra;
  } catch {
    return {};
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  user_message: "User messages",
  assistant_message: "Assistant replies",
  tool_result: "Tool results",
  injected_context: "Injected context",
  summary: "Compaction summaries",
  system_event: "System events",
};

export function buildCaseFile(sessionId: string): CaseFile | null {
  const db = getDb();
  const session = db.getSession(sessionId);
  if (!session) return null;
  const rows = db.eventsForSession(sessionId);
  const toolUses = db.toolUsesForSession(sessionId);
  const extras = rows.map(parseExtra);
  const notes: string[] = [];

  // ---- compaction boundaries ----
  const compactions: {
    lineNo: number;
    trigger: string | null;
    preTokens: number | null;
    postTokens: number | null;
    preservedUuids: Set<string>;
  }[] = [];
  rows.forEach((r, i) => {
    const c = extras[i].compact;
    if (c) {
      compactions.push({
        lineNo: r.line_no,
        trigger: c.trigger,
        preTokens: c.preTokens,
        postTokens: c.postTokens,
        preservedUuids: new Set(c.preservedUuids),
      });
    }
  });
  const lastBoundary = compactions.at(-1) ?? null;

  // ---- inclusion status per row ----
  function inclusionFor(row: EventRow): { inclusion: Inclusion; reason: string } {
    if (row.category === "meta") {
      return { inclusion: "not-sent", reason: "CLI bookkeeping record; never part of the model prompt." };
    }
    if (row.is_sidechain) {
      return { inclusion: "not-sent", reason: "Subagent sidechain; runs in a separate context window." };
    }
    if (row.is_compact_summary) {
      return { inclusion: "assumed-included", reason: "Compaction summary standing in for dropped history." };
    }
    if (lastBoundary && row.line_no < lastBoundary.lineNo) {
      if (row.uuid && lastBoundary.preservedUuids.has(row.uuid)) {
        return { inclusion: "assumed-included", reason: "Listed as preserved in the compaction record (observed)." };
      }
      return { inclusion: "compacted-out", reason: `Dropped by the compaction at entry #${lastBoundary.lineNo} (observed).` };
    }
    return {
      inclusion: "assumed-included",
      reason: "Appears after the last compaction; inclusion inferred from transcript order, not directly verifiable.",
    };
  }

  // ---- evidence ----
  const allEvidence: EvidenceItem[] = rows.map((r) => {
    const inc = inclusionFor(r);
    return {
      id: `${sessionId}:${r.line_no}`,
      lineNo: r.line_no,
      uuid: r.uuid,
      ts: r.ts,
      category: r.category as EvidenceCategory,
      subtype: r.subtype,
      toolName: r.tool_name,
      filePath: r.file_path,
      estTokens: r.est_tokens,
      chars: r.chars,
      preview: r.preview,
      inclusion: inc.inclusion,
      inclusionReason: inc.reason,
      confidence: "estimated",
    };
  });
  let evidence = allEvidence;
  if (allEvidence.length > EVIDENCE_CAP) {
    evidence = allEvidence.slice(-EVIDENCE_CAP);
    notes.push(`Showing the most recent ${EVIDENCE_CAP} of ${allEvidence.length} evidence entries.`);
  }

  const included = allEvidence.filter((e) => e.inclusion === "assumed-included");

  // ---- meter + per-turn series ----
  // One pass builds both: the meter reads the last usage record, the trajectory keeps
  // them all. Built from `rows` (uncapped), never from `evidence` (truncated to 800).
  let meterUsage: { line: number; ts: string | null; u: NonNullable<EventExtra["usage"]> } | null = null;
  let budget: number | null = null;
  const turns: TurnPoint[] = [];
  let sawCompactionSinceLastTurn = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ex = extras[i];
    if (ex.compact) sawCompactionSinceLastTurn = true;
    if (ex.usage && !r.is_sidechain) {
      meterUsage = { line: r.line_no, ts: r.ts, u: ex.usage };
      turns.push({
        n: turns.length + 1,
        lineNo: r.line_no,
        ts: r.ts,
        contextTokens: ex.usage.input + ex.usage.cacheRead + ex.usage.cacheCreation + ex.usage.output,
        afterCompaction: sawCompactionSinceLastTurn,
      });
      sawCompactionSinceLastTurn = false;
    }
    if (ex.budgetTokensLeft != null) budget = ex.budgetTokensLeft;
  }
  const model = session.model;
  const window = contextWindowForModel(model);
  const contextTokens = meterUsage
    ? meterUsage.u.input + meterUsage.u.cacheRead + meterUsage.u.cacheCreation + meterUsage.u.output
    : null;
  // If observation contradicts the table, the table is wrong for this model: trust the
  // observation rather than report an impossible >100%.
  let maxTokensConfidence: Confidence = window.maxTokens == null ? "estimated" : "assumed";
  if (contextTokens != null && window.maxTokens != null && contextTokens > window.maxTokens) {
    const prior = window.maxTokens;
    window.maxTokens = 1_000_000;
    window.note = `1M inferred from observed usage exceeding ${formatTokens(prior)}`;
    maxTokensConfidence = "inferred";
    notes.push(
      `Observed context (${formatTokens(contextTokens)}) exceeds the ${formatTokens(prior)} window expected for this model, so it evidently has a larger one — 1M inferred.`,
    );
  }
  if (window.maxTokens == null) {
    notes.push(`Context window unknown for model "${model ?? "unidentified"}" — percentage cannot be computed.`);
  }
  const estSince = meterUsage
    ? included.filter((e) => e.lineNo > meterUsage!.line).reduce((s, e) => s + e.estTokens, 0)
    : included.reduce((s, e) => s + e.estTokens, 0);
  const meter: Meter = {
    contextTokens,
    observedAt: meterUsage?.ts ?? null,
    maxTokens: window.maxTokens,
    maxTokensConfidence,
    pct:
      contextTokens != null && window.maxTokens != null
        ? Math.min(100, (contextTokens / window.maxTokens) * 100)
        : null,
    model,
    usageBreakdown: meterUsage
      ? {
          input: meterUsage.u.input,
          cacheRead: meterUsage.u.cacheRead,
          cacheCreation: meterUsage.u.cacheCreation,
          output: meterUsage.u.output,
        }
      : null,
    estTokensSinceObserved: estSince,
    budgetTokensLeft: budget,
    confidence: meterUsage ? "observed" : "estimated",
  };

  // ---- composition ----
  const byCat = new Map<string, { estTokens: number; count: number }>();
  for (const e of included) {
    const cur = byCat.get(e.category) ?? { estTokens: 0, count: 0 };
    cur.estTokens += e.estTokens;
    cur.count += 1;
    byCat.set(e.category, cur);
  }
  const composition: CompositionSlice[] = [...byCat.entries()]
    .filter(([k]) => CATEGORY_LABELS[k])
    .map(([k, v]) => ({
      key: k,
      label: CATEGORY_LABELS[k],
      estTokens: v.estTokens,
      count: v.count,
      confidence: "estimated" as const,
    }))
    .sort((a, b) => b.estTokens - a.estTokens);
  if (contextTokens != null) {
    const accounted = composition.reduce((s, c) => s + c.estTokens, 0);
    const overhead = contextTokens - accounted;
    if (overhead > 0) {
      composition.push({
        key: "overhead",
        label: "System prompt, tool schemas & unaccounted",
        estTokens: overhead,
        count: 1,
        confidence: "inferred",
      });
    } else if (overhead < 0) {
      notes.push(
        `Per-entry estimates exceed the observed total by ${formatTokens(-overhead)} tokens — chars/4 overestimates here (or some entries were server-side truncated).`,
      );
    }
  }

  // ---- tools ----
  const tools = buildToolRegistry(session.cwd, rows, extras, toolUses);

  // ---- activity ----
  const activity = buildActivity(sessionId, rows, extras, toolUses);

  // ---- clues ----
  const compactedOutCount = allEvidence.filter((e) => e.inclusion === "compacted-out").length;
  const clues = deriveClues({
    meter,
    evidence: allEvidence,
    toolUses,
    tools,
    compactions: compactions.map((c) => ({
      lineNo: c.lineNo,
      trigger: c.trigger,
      preTokens: c.preTokens,
      postTokens: c.postTokens,
    })),
    compactedOutCount,
  });

  const summary: CaseSummary = {
    sessionId,
    cwd: session.cwd,
    name: session.name,
    live: session.live === 1,
    pid: session.pid,
    kind: session.kind,
    status: session.status,
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    transcriptPath: session.transcript_path,
    gitBranch: null,
    model,
    cliVersion: session.cli_version,
    eventCount: rows.length,
  };

  notes.push(
    "Context totals come from the API usage numbers Claude CLI records per assistant turn (observed); per-entry sizes are chars/4 estimates.",
    window.maxTokens == null
      ? `Maximum window: ${window.note}. Claude CLI does not expose it locally.`
      : `Maximum window ${formatTokens(window.maxTokens)} — ${window.note}. Claude CLI does not expose it locally.`,
    "ContextClues reads transcripts only. It has no access to Claude's private reasoning, and inclusion between compactions is inferred from transcript order.",
  );

  return {
    case: summary,
    meter,
    composition,
    evidence,
    tools,
    activity,
    clues,
    trajectory: computeTrajectory(turns, window.maxTokens, contextTokens),
    generatedAt: new Date().toISOString(),
    notes,
  };
}

function buildToolRegistry(
  cwd: string | null,
  rows: EventRow[],
  extras: EventExtra[],
  toolUses: { name: string; ts: string | null }[],
): ToolInfo[] {
  const map = new Map<string, ToolInfo>();
  const put = (t: ToolInfo) => {
    const existing = map.get(t.name);
    if (!existing) {
      map.set(t.name, t);
      return;
    }
    // Higher-signal statuses win; usage counts always merge.
    const rank = { used: 0, active: 1, deferred: 2, configured: 3, assumed: 4 } as const;
    if (rank[t.status] < rank[existing.status]) {
      existing.status = t.status;
      existing.source = t.source;
    }
    existing.description = existing.description ?? t.description;
  };

  for (const [name, description] of Object.entries(BUILTIN_TOOLS)) {
    put({
      name,
      provider: "built-in",
      source: "static list for Claude Code 2.x (not enumerable locally)",
      description,
      status: "assumed",
      useCount: 0,
      lastUsedAt: null,
    });
  }

  const cfg = readConfiguredSources(cwd);
  for (const s of cfg.mcpServers) {
    put({
      name: `mcp__${s.name}__*`,
      provider: `MCP server "${s.name}"`,
      source: s.scope,
      description: `Configured MCP server (${s.transport ?? "unknown transport"}); individual tools appear when observed in the transcript.`,
      status: "configured",
      useCount: 0,
      lastUsedAt: null,
    });
  }
  for (const p of cfg.plugins) {
    put({
      name: `plugin:${p.name}`,
      provider: "plugin",
      source: "~/.claude/settings.json enabledPlugins",
      description: p.enabled ? "Enabled plugin (may provide skills, agents, hooks)." : "Installed but disabled.",
      status: p.enabled ? "active" : "configured",
      useCount: 0,
      lastUsedAt: null,
    });
  }
  for (const s of cfg.userSkills) {
    put({
      name: `skill:${s}`,
      provider: "skill (user)",
      source: "~/.claude/skills/",
      description: "User-level skill directory.",
      status: "configured",
      useCount: 0,
      lastUsedAt: null,
    });
  }

  // Transcript observations override configuration guesses.
  rows.forEach((r, i) => {
    const ex = extras[i];
    if (ex.skillNames) {
      for (const s of ex.skillNames) {
        put({
          name: `skill:${s}`,
          provider: "skill",
          source: "skill_listing attachment in transcript (observed)",
          description: "Listed as available to this session.",
          status: "active",
          useCount: 0,
          lastUsedAt: null,
        });
      }
    }
    if (ex.toolsAdded) {
      for (const t of ex.toolsAdded) {
        const provider = t.startsWith("mcp__") ? `MCP server "${t.split("__")[1]}"` : "built-in (deferred)";
        put({
          name: t,
          provider,
          source: "deferred_tools_delta attachment in transcript (observed)",
          description: "Deferred tool: name visible to the session, schema loaded on demand.",
          status: "deferred",
          useCount: 0,
          lastUsedAt: null,
        });
      }
    }
  });

  for (const tu of toolUses) {
    const provider = tu.name.startsWith("mcp__") ? `MCP server "${tu.name.split("__")[1]}"` : "built-in";
    const existing = map.get(tu.name);
    if (existing) {
      existing.status = "used";
      existing.useCount += 1;
      existing.lastUsedAt = tu.ts;
      if (existing.provider === "built-in (deferred)") existing.provider = provider;
    } else {
      map.set(tu.name, {
        name: tu.name,
        provider,
        source: "tool_use records in transcript (observed)",
        description: null,
        status: "used",
        useCount: 1,
        lastUsedAt: tu.ts,
      });
    }
  }

  const rank = { used: 0, active: 1, deferred: 2, configured: 3, assumed: 4 } as const;
  return [...map.values()].sort(
    (a, b) => rank[a.status] - rank[b.status] || b.useCount - a.useCount || a.name.localeCompare(b.name),
  );
}

function buildActivity(
  sessionId: string,
  rows: EventRow[],
  extras: EventExtra[],
  toolUses: { tool_use_id: string; name: string; ts: string | null; file_path: string | null; input_preview: string; line_no: number }[],
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const toolUseByLine = new Map<number, typeof toolUses>();
  for (const tu of toolUses) {
    const arr = toolUseByLine.get(tu.line_no) ?? [];
    arr.push(tu);
    toolUseByLine.set(tu.line_no, arr);
  }

  rows.forEach((r, i) => {
    const ex = extras[i];
    const id = `${sessionId}:${r.line_no}`;
    if (r.is_sidechain) return;
    if (r.category === "user_message") {
      out.push({ id, ts: r.ts, kind: "user_prompt", title: "User prompt", detail: r.preview.slice(0, 160), estTokens: r.est_tokens, confidence: "estimated" });
    } else if (r.category === "assistant_message") {
      for (const tu of toolUseByLine.get(r.line_no) ?? []) {
        out.push({
          id: `${id}:${tu.tool_use_id}`,
          ts: r.ts,
          kind: tu.name === "Read" ? "file_read" : "tool_call",
          title: tu.name === "Read" ? `Read ${tu.file_path ?? "file"}` : `${tu.name} invoked`,
          detail: tu.input_preview,
          estTokens: null,
          confidence: "observed",
        });
      }
      if (ex.usage) {
        const total = ex.usage.input + ex.usage.cacheRead + ex.usage.cacheCreation + ex.usage.output;
        out.push({
          id: `${id}:turn`,
          ts: r.ts,
          kind: "assistant_reply",
          title: `Assistant turn — context at ${formatTokens(total)} tokens`,
          detail: r.preview.slice(0, 120),
          estTokens: total,
          confidence: "observed",
        });
      }
    } else if (r.category === "tool_result") {
      out.push({
        id,
        ts: r.ts,
        kind: "tool_result",
        title: `${r.tool_name ?? "Tool"} result (~${formatTokens(r.est_tokens)} tokens est.)`,
        detail: r.preview.slice(0, 120),
        estTokens: r.est_tokens,
        confidence: "estimated",
      });
    } else if (ex.compact) {
      out.push({
        id,
        ts: r.ts,
        kind: "compaction",
        title: `Compaction (${ex.compact.trigger ?? "?"}): ${formatTokens(ex.compact.preTokens)} → ${formatTokens(ex.compact.postTokens)} tokens`,
        detail: "Exact figures from the CLI's compact_boundary record.",
        estTokens: null,
        confidence: "observed",
      });
    } else if (r.category === "injected_context") {
      if (r.subtype === "deferred_tools_delta" || r.subtype === "skill_listing" || r.subtype === "agent_listing_delta") {
        out.push({
          id,
          ts: r.ts,
          kind: "config_change",
          title: `Tool availability update (${r.subtype})`,
          detail: [
            ex.toolsAdded?.length ? `+${ex.toolsAdded.length} tools` : null,
            ex.toolsRemoved?.length ? `−${ex.toolsRemoved.length} tools` : null,
            ex.skillNames?.length ? `${ex.skillNames.length} skills listed` : null,
          ]
            .filter(Boolean)
            .join(", ") || r.preview.slice(0, 100),
          estTokens: r.est_tokens,
          confidence: "observed",
        });
      } else if (r.subtype?.startsWith("hook_")) {
        out.push({
          id,
          ts: r.ts,
          kind: "context_injection",
          title: `Hook context injected (${r.subtype})`,
          detail: r.preview.slice(0, 100),
          estTokens: r.est_tokens,
          confidence: "observed",
        });
      }
    } else if (r.category === "summary") {
      out.push({
        id,
        ts: r.ts,
        kind: "compaction",
        title: `Compaction summary written (~${formatTokens(r.est_tokens)} tokens est.)`,
        detail: r.preview.slice(0, 120),
        estTokens: r.est_tokens,
        confidence: "estimated",
      });
    }
  });

  return out.reverse().slice(0, 150);
}
