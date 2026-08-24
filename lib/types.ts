// Shared types for ContextClues.
//
// Every quantitative claim in the UI carries a Confidence label:
//   observed  — read directly from Claude CLI artifacts (API usage numbers, compaction metadata)
//   estimated — computed heuristically (chars/4 token estimates)
//   inferred  — derived indirectly (system-prompt overhead = observed total − sum of estimates)
//   assumed   — from a static mapping we cannot verify locally (max context window per model)

export type Confidence = "observed" | "estimated" | "inferred" | "assumed";

export type EvidenceCategory =
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "injected_context"
  | "summary"
  | "system_event"
  | "meta";

export type Inclusion = "assumed-included" | "compacted-out" | "not-sent" | "unknown";

export interface CaseSummary {
  sessionId: string;
  cwd: string | null;
  name: string | null;
  live: boolean;
  pid: number | null;
  kind: string | null;
  status: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  transcriptPath: string | null;
  gitBranch: string | null;
  model: string | null;
  cliVersion: string | null;
  eventCount: number;
}

export interface Meter {
  /** input + cache_read + cache_creation + output of the last main-chain assistant turn. */
  contextTokens: number | null;
  observedAt: string | null;
  /** null when the model id is unrecognized — the UI shows "—" rather than a wrong denominator. */
  maxTokens: number | null;
  maxTokensConfidence: Confidence;
  pct: number | null;
  model: string | null;
  usageBreakdown: {
    input: number;
    cacheRead: number;
    cacheCreation: number;
    output: number;
  } | null;
  /** chars/4 estimate of context added after the last observed usage record. */
  estTokensSinceObserved: number;
  /** Session token budget from total_tokens_reminder attachments, if present. */
  budgetTokensLeft: number | null;
  confidence: Confidence;
}

/**
 * One model request's observed usage — a point on the context growth curve.
 *
 * Deliberately "request", not "turn": every tool-loop iteration is its own API request
 * with its own usage record, so one user-facing exchange is typically many requests.
 */
export interface TurnPoint {
  /** 1-based index among usage-bearing requests. */
  n: number;
  lineNo: number;
  ts: string | null;
  /** input + cacheRead + cacheCreation + output — same definition as Meter.contextTokens. */
  contextTokens: number;
  /** True when a compaction boundary occurred before this request. */
  afterCompaction: boolean;
}

export interface Trajectory {
  turns: TurnPoint[];
  /** Requests observed before downsampling for transport. */
  totalTurns: number;
  /**
   * Mean growth per request over the recent window — the correct estimator for a
   * cumulative question, since it counts large requests at their true frequency.
   */
  burnRatePerTurn: number | null;
  /** Trimmed median — what a typical request costs, ignoring the occasional spike. */
  burnRateTypical: number | null;
  burnRatePerMinute: number | null;
  /** Requests of headroom at the average rate — the expected case. */
  turnsRemaining: number | null;
  /** Requests of headroom if the large requests stop. Null unless meaningfully longer. */
  turnsRemainingOptimistic: number | null;
  minutesRemaining: number | null;
  /** How many deltas the rate was computed from. */
  sampleSize: number;
  volatility: "steady" | "variable" | null;
  /** Why a projection is unavailable, when it is. */
  reason: string | null;
  /** The series and the rate are observed; the runway derived from them is inferred. */
  confidence: Confidence;
}

export interface CompositionSlice {
  key: string;
  label: string;
  estTokens: number;
  count: number;
  confidence: Confidence;
}

export interface EvidenceItem {
  id: string;
  lineNo: number;
  uuid: string | null;
  ts: string | null;
  category: EvidenceCategory;
  subtype: string | null;
  toolName: string | null;
  filePath: string | null;
  estTokens: number;
  chars: number;
  preview: string;
  inclusion: Inclusion;
  inclusionReason: string;
  confidence: Confidence;
}

export interface ToolInfo {
  name: string;
  provider: string;
  source: string;
  description: string | null;
  status: "used" | "active" | "deferred" | "configured" | "assumed";
  useCount: number;
  lastUsedAt: string | null;
}

export type ActivityKind =
  | "user_prompt"
  | "assistant_reply"
  | "tool_call"
  | "tool_result"
  | "file_read"
  | "compaction"
  | "context_injection"
  | "config_change"
  | "session";

export interface ActivityEvent {
  id: string;
  ts: string | null;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  estTokens: number | null;
  confidence: Confidence;
}

export interface Clue {
  id: string;
  severity: "info" | "notice" | "warning";
  title: string;
  detail: string;
  confidence: Confidence;
}

export interface CaseFile {
  case: CaseSummary;
  meter: Meter;
  composition: CompositionSlice[];
  evidence: EvidenceItem[];
  tools: ToolInfo[];
  activity: ActivityEvent[];
  clues: Clue[];
  trajectory: Trajectory;
  generatedAt: string;
  notes: string[];
}
