"use client";

import { useMemo, useState } from "react";
import type { EvidenceItem, Inclusion } from "@/lib/types.ts";
import Panel from "./Panel";
import { CATEGORY_COLOR, CATEGORY_SHORT, formatTokens, relTime } from "./util";

/* The default state ("in context") stays quiet; only exceptions get a colored pill. */
const EXCEPTION_PILL: Partial<Record<Inclusion, { label: string; cls: string }>> = {
  "compacted-out": { label: "compacted out", cls: "text-s-summary border-s-summary/60" },
  "not-sent": { label: "not sent", cls: "text-ink-3 border-line-2" },
};

const RENDER_CAP = 250;

export default function EvidenceExplorer({ evidence }: { evidence: EvidenceItem[] }) {
  const [q, setQ] = useState("");
  const [onlyContext, setOnlyContext] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const maxTokens = useMemo(
    () => evidence.reduce((m, e) => (e.estTokens > m ? e.estTokens : m), 1),
    [evidence],
  );

  const filtered = useMemo(() => {
    let list = evidence;
    if (onlyContext) list = list.filter((e) => e.inclusion !== "not-sent" && e.category !== "meta");
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter(
        (e) =>
          e.preview.toLowerCase().includes(needle) ||
          (e.toolName ?? "").toLowerCase().includes(needle) ||
          (e.filePath ?? "").toLowerCase().includes(needle) ||
          e.category.includes(needle),
      );
    }
    return [...list].reverse(); // newest first
  }, [evidence, q, onlyContext]);

  const shown = filtered.slice(0, RENDER_CAP);

  return (
    <Panel
      title="Evidence"
      className="flex-1"
      right={
        <>
          <span className="hidden text-[10px] tabular-nums text-ink-3 xl:inline">
            {filtered.length} entries{filtered.length > RENDER_CAP ? ` · newest ${RENDER_CAP}` : ""}
          </span>
          <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[10px] text-ink-2">
            <input
              type="checkbox"
              checked={onlyContext}
              onChange={(e) => setOnlyContext(e.target.checked)}
            />
            context-relevant only
          </label>
        </>
      }
      bodyClass="gap-3"
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search evidence — text, tool, file path…"
        className="control w-full"
      />

      {/* column headers */}
      <div className="flex items-center gap-3 border-b border-line pb-1.5 pr-3 text-[9px] uppercase tracking-widest text-ink-3">
        <span className="w-11 shrink-0">#</span>
        <span className="w-24 shrink-0">source</span>
        <span className="min-w-0 flex-1">preview</span>
        <span className="w-14 shrink-0 text-right">~tokens</span>
        <span className="w-14 shrink-0 text-right">age</span>
        <span className="w-24 shrink-0 text-right">status</span>
      </div>

      <ul className="-mx-1.5 flex min-h-0 flex-col overflow-y-auto scrollbox">
        {shown.map((e) => {
          const isOpen = open === e.id;
          const exception = EXCEPTION_PILL[e.inclusion];
          const sizeShare = e.estTokens / maxTokens;
          return (
            <li key={e.id} className="px-1.5">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : e.id)}
                className={`group w-full rounded-md px-1.5 py-[7px] text-left transition-colors hover:bg-raised/70 ${
                  isOpen ? "bg-raised/70" : ""
                }`}
              >
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="w-11 shrink-0 tabular-nums text-ink-3">#{e.lineNo}</span>
                  <span className="flex w-24 shrink-0 items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: CATEGORY_COLOR[e.category] }}
                    />
                    <span className="truncate text-ink-2">{CATEGORY_SHORT[e.category]}</span>
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate group-hover:text-ink ${
                      e.inclusion === "compacted-out" ? "text-ink-3" : "text-ink/90"
                    }`}
                  >
                    {e.toolName && <span className="text-ink-2">[{e.toolName}] </span>}
                    {e.preview || <span className="text-ink-3">(empty)</span>}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-ink-2" title={`${e.chars.toLocaleString()} chars`}>
                    {e.estTokens > 0 ? `~${formatTokens(e.estTokens)}` : "·"}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-ink-3">{relTime(e.ts)}</span>
                  <span className="flex w-24 shrink-0 justify-end">
                    {exception ? (
                      <span
                        className={`rounded-sm border px-1 py-px text-[9px] uppercase tracking-wide ${exception.cls}`}
                      >
                        {exception.label}
                      </span>
                    ) : (
                      <span className="text-[9px] uppercase tracking-wide text-ink-3/80">in ctx</span>
                    )}
                  </span>
                </div>
                {/* size bar — only for entries that meaningfully occupy the window */}
                {e.estTokens >= 25 && (
                  <div className="ml-[8.75rem] mt-1 mr-40 h-px rounded bg-line/50">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${Math.max(1, sizeShare * 100)}%`,
                        backgroundColor: CATEGORY_COLOR[e.category],
                        opacity: e.inclusion === "assumed-included" ? 0.8 : 0.3,
                      }}
                    />
                  </div>
                )}
              </button>
              {isOpen && (
                <div className="mx-1.5 mb-2 rounded-md border border-line bg-raised px-3 py-2.5 text-[11px] leading-relaxed">
                  <p className="break-words text-ink-2">{e.preview}</p>
                  {e.filePath && <p className="mt-1.5 text-ink-3">file: {e.filePath}</p>}
                  <p className="mt-1.5 text-ink-3">
                    <span className="text-accent">why: </span>
                    {e.inclusionReason} Size is a chars/4 estimate ({e.chars.toLocaleString()} chars).
                  </p>
                </div>
              )}
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-3 py-2 text-xs text-ink-3">no evidence matches</li>}
      </ul>
    </Panel>
  );
}
