"use client";

import { useMemo, useState } from "react";
import type { ToolInfo } from "@/lib/types.ts";
import Panel from "./Panel";
import { relTime } from "./util";

const STATUS_STYLE: Record<ToolInfo["status"], string> = {
  used: "text-s-tool border-s-tool/70",
  active: "text-accent border-accent/70",
  deferred: "text-ink-2 border-ink-3 border-dashed",
  configured: "text-ink-2 border-ink-3",
  assumed: "text-ink-3 border-line-2",
};

export default function ToolRegistry({ tools }: { tools: ToolInfo[] }) {
  const [q, setQ] = useState("");
  // The registry runs to hundreds of entries; fold the needle once, not twice per row.
  const filtered = useMemo(() => {
    if (!q) return tools;
    const needle = q.toLowerCase();
    return tools.filter(
      (t) => t.name.toLowerCase().includes(needle) || t.provider.toLowerCase().includes(needle),
    );
  }, [tools, q]);
  const used = tools.filter((t) => t.status === "used").length;

  return (
    <Panel
      title="Tool Registry"
      right={
        <span className="text-[10px] tabular-nums text-ink-3">
          {used} used · {tools.length} known
        </span>
      }
      bodyClass="gap-3"
      foot={
        <>
          &ldquo;Assumed&rdquo; built-ins come from a static list — the CLI does not expose a runtime
          enumeration. Used/deferred entries were observed in this session&apos;s transcript.
        </>
      }
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="filter tools…"
        className="control w-full"
      />
      <ul className="flex min-h-0 flex-col divide-y divide-line/50 overflow-y-auto scrollbox pr-1 text-[11px]">
        {filtered.map((t) => (
          <li
            key={t.name}
            className="flex items-center gap-2.5 py-[7px]"
            title={`${t.description ?? ""}\nSource: ${t.source}`}
          >
            <span
              className={`w-[4.6rem] shrink-0 rounded-sm border px-1 py-px text-center text-[9px] uppercase tracking-wide ${STATUS_STYLE[t.status]}`}
            >
              {t.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink" title={t.name}>
              {t.name}
            </span>
            {t.useCount > 0 && (
              <span
                className="shrink-0 tabular-nums text-s-tool"
                title={t.lastUsedAt ? `last used ${relTime(t.lastUsedAt)}` : ""}
              >
                ×{t.useCount}
              </span>
            )}
            <span className="w-24 shrink-0 truncate text-right text-ink-3" title={t.provider}>
              {t.provider}
            </span>
          </li>
        ))}
        {filtered.length === 0 && <li className="py-2 text-ink-3">no matches</li>}
      </ul>
    </Panel>
  );
}
