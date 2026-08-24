import type { Clue } from "@/lib/types.ts";
import ConfidenceTag from "./ConfidenceTag";
import Panel from "./Panel";

const SEVERITY_BORDER: Record<Clue["severity"], string> = {
  warning: "border-l-thread",
  notice: "border-l-accent",
  info: "border-l-ink-3",
};

const SEVERITY_ICON: Record<Clue["severity"], string> = {
  warning: "▲",
  notice: "●",
  info: "○",
};

export default function CluesPanel({ clues, className = "" }: { clues: Clue[]; className?: string }) {
  return (
    <Panel
      title="Clues"
      className={className}
      right={
        <span className="text-[10px] tabular-nums text-ink-3">
          {clues.length} observation{clues.length === 1 ? "" : "s"}
        </span>
      }
      bodyClass="gap-0 p-3"
    >
      {clues.length === 0 ? (
        <p className="px-1 py-2 text-xs text-ink-3">Nothing suspicious on the board yet.</p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto scrollbox pr-1">
          {clues.map((c) => (
            <li
              key={c.id}
              className={`rounded-md border border-line ${SEVERITY_BORDER[c.severity]} border-l-2 bg-raised px-3.5 py-2.5`}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs leading-snug text-ink">
                  <span className="mr-1.5 text-ink-3">{SEVERITY_ICON[c.severity]}</span>
                  {c.title}
                </p>
                <ConfidenceTag level={c.confidence} />
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">{c.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
