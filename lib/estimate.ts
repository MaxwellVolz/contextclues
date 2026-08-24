// Token estimation heuristics. All results are Confidence: "estimated".

/** chars/4 is the standard rough heuristic for English/code with Claude tokenizers. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export interface WindowInfo {
  /** null when the model id is unrecognized — render "—" rather than a wrong denominator. */
  maxTokens: number | null;
  note: string;
}

/**
 * Context window per model id. Claude CLI does not expose the window in any local
 * artifact, so this is a static table and its Confidence is "assumed".
 *
 * Ordered: the first pattern that matches wins, so Haiku is checked before the
 * general current-family rule.
 */
const MODEL_WINDOWS: { re: RegExp; maxTokens: number; note: string }[] = [
  { re: /haiku-4-5|haiku-4\.5/i, maxTokens: 200_000, note: "Haiku 4.5 — 200K (assumed)" },
  {
    re: /^claude-(fable|mythos|opus|sonnet)-\d/i,
    maxTokens: 1_000_000,
    note: "current Claude family — 1M (assumed)",
  },
];

export function contextWindowForModel(model: string | null): WindowInfo {
  if (!model || model.startsWith("<")) {
    // "<synthetic>" and friends are placeholders the CLI writes, not real models.
    return { maxTokens: null, note: "model unknown — window cannot be determined" };
  }
  // Legacy explicit-variant marker, kept so older transcripts still resolve.
  if (/\[1m\]/i.test(model)) {
    return { maxTokens: 1_000_000, note: "1M-context model variant (assumed)" };
  }
  for (const entry of MODEL_WINDOWS) {
    if (entry.re.test(model)) {
      return { maxTokens: entry.maxTokens, note: entry.note };
    }
  }
  return { maxTokens: null, note: `unrecognized model "${model}" — window unknown` };
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
