import type { Confidence, EvidenceCategory } from "@/lib/types.ts";

export function relTime(ts: string | number | null): string {
  if (ts == null) return "—";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const CATEGORY_COLOR: Record<EvidenceCategory | "overhead", string> = {
  user_message: "var(--color-s-user)",
  assistant_message: "var(--color-s-assistant)",
  tool_result: "var(--color-s-tool)",
  injected_context: "var(--color-s-injected)",
  summary: "var(--color-s-summary)",
  system_event: "var(--color-s-system)",
  overhead: "var(--color-s-overhead)",
  meta: "var(--color-ink-3)",
};

export const CATEGORY_SHORT: Record<string, string> = {
  user_message: "user",
  assistant_message: "assistant",
  tool_result: "tool result",
  injected_context: "injected",
  summary: "summary",
  system_event: "system",
  meta: "meta",
  overhead: "overhead",
};

export const CONFIDENCE_HELP: Record<Confidence, string> = {
  observed: "Read directly from Claude CLI artifacts (API usage numbers, compaction records).",
  estimated: "Heuristic (chars ÷ 4). Real tokenization will differ somewhat.",
  inferred: "Derived indirectly, e.g. observed total minus the sum of estimates.",
  assumed: "Static mapping that cannot be verified locally (e.g. model → window size).",
};
