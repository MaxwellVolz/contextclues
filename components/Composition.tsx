import type { CompositionSlice } from "@/lib/types.ts";
import Panel from "./Panel";
import { CATEGORY_COLOR, fmtTokens } from "./util";

/** Part-of-whole: one stacked horizontal bar with 2px surface gaps + a full-value legend. */
export default function Composition({ slices }: { slices: CompositionSlice[] }) {
  const total = slices.reduce((s, c) => s + c.estTokens, 0);
  const hasInferred = slices.some((s) => s.confidence === "inferred");

  return (
    <Panel
      title="Composition"
      className="shrink-0"
      right={<span className="text-[10px] tabular-nums text-ink-3">~{fmtTokens(total)} tokens accounted</span>}
      bodyClass="gap-3.5"
      foot={
        <>
          Slice sizes are chars/4 estimates{hasInferred && (
            <>
              ; the <span className="tex-inferred rounded-[2px] bg-s-overhead px-1">striped</span>{" "}
              remainder is inferred (observed total − estimates)
            </>
          )}
          .
        </>
      }
    >
      {total === 0 ? (
        <p className="text-xs text-ink-3">No context entries yet.</p>
      ) : (
        <>
          <div
            className="flex h-6 w-full shrink-0 overflow-hidden rounded-sm"
            role="img"
            aria-label="context composition by source"
          >
            {slices.map((s) => {
              const pct = (s.estTokens / total) * 100;
              if (pct <= 0) return null;
              return (
                <div
                  key={s.key}
                  title={`${s.label}: ~${fmtTokens(s.estTokens)} tokens (${pct.toFixed(1)}%, ${s.confidence})`}
                  className={s.confidence === "inferred" ? "tex-inferred" : ""}
                  style={{
                    width: `${pct}%`,
                    minWidth: pct > 0.4 ? "3px" : undefined,
                    backgroundColor: CATEGORY_COLOR[s.key as keyof typeof CATEGORY_COLOR] ?? "var(--color-ink-3)",
                    // 2px surface gap between segments
                    boxShadow: "inset -2px 0 0 var(--color-panel)",
                  }}
                />
              );
            })}
          </div>

          <ul className="flex flex-col gap-1.5 text-[11px]">
            {slices.map((s) => {
              const pct = (s.estTokens / total) * 100;
              return (
                <li key={s.key} className="grid grid-cols-[12px_1fr_auto_3.25rem] items-center gap-2.5">
                  <span
                    className={`h-2.5 w-2.5 rounded-[2px] ${s.confidence === "inferred" ? "tex-inferred" : ""}`}
                    style={{ backgroundColor: CATEGORY_COLOR[s.key as keyof typeof CATEGORY_COLOR] ?? "var(--color-ink-3)" }}
                  />
                  <span className="truncate text-ink-2" title={s.label}>
                    {s.label}
                    {s.count > 1 && <span className="text-ink-3"> ×{s.count}</span>}
                  </span>
                  <span className="tabular-nums text-ink-2">~{fmtTokens(s.estTokens)}</span>
                  <span className="text-right tabular-nums text-ink-3">{pct.toFixed(1)}%</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Panel>
  );
}
