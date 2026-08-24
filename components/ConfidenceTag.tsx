import type { Confidence } from "@/lib/types.ts";
import { CONFIDENCE_HELP } from "./util";

const STYLES: Record<Confidence, string> = {
  observed: "border-solid border-s-tool text-s-tool",
  estimated: "border-dashed border-ink-3 text-ink-2",
  inferred: "border-dotted border-s-injected text-s-injected",
  assumed: "border-solid border-ink-3 text-ink-3",
};

export default function ConfidenceTag({ level }: { level: Confidence }) {
  return (
    <span
      title={CONFIDENCE_HELP[level]}
      className={`inline-block shrink-0 rounded-sm border px-1 py-px text-[9px] uppercase tracking-wider ${STYLES[level]}`}
    >
      {level}
    </span>
  );
}
