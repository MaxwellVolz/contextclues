"use client";

import { useState } from "react";
import type { TurnPoint } from "@/lib/types.ts";
import { formatTokens } from "./util";

/**
 * Context growth across the session's assistant turns. Single series, so no legend —
 * the panel title names it. Inline SVG, no chart library.
 */
export default function Sparkline({ turns, totalTurns }: { turns: TurnPoint[]; totalTurns: number }) {
  const [hover, setHover] = useState<number | null>(null);

  if (turns.length < 2) {
    return (
      <div className="flex h-14 items-center justify-center rounded-sm border border-dashed border-line text-[10px] text-ink-3">
        context curve appears after a few turns
      </div>
    );
  }

  const W = 100;
  const H = 30;
  // Scaled to the series, not the window: the meter bar directly above already shows
  // fullness, so this chart's job is the *shape* of growth — acceleration, plateaus,
  // and compaction drops. Baseline stays at zero so the rise stays proportional.
  const peak = Math.max(...turns.map((t) => t.contextTokens));
  const yMax = (peak || 1) * 1.08;

  const x = (i: number) => (i / (turns.length - 1)) * W;
  const y = (v: number) => H - (v / yMax) * H;

  const line = turns.map((t, i) => `${x(i).toFixed(2)},${y(t.contextTokens).toFixed(2)}`).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;

  const compactions = turns
    .map((t, i) => (t.afterCompaction ? i : -1))
    .filter((i) => i > 0);

  const active = hover != null ? turns[hover] : null;

  return (
    <figure className="flex flex-col gap-1">
      <div
        className="relative"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          setHover(Math.round(frac * (turns.length - 1)));
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-14 w-full"
          role="img"
          aria-label={`Context grew to ${formatTokens(turns.at(-1)!.contextTokens)} tokens over ${totalTurns} assistant turns`}
        >
          <polygon points={area} fill="var(--color-accent)" opacity="0.14" />
          <polyline
            points={line}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="0.9"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
          {compactions.map((i) => (
            <line
              key={i}
              x1={x(i)}
              x2={x(i)}
              y1="0"
              y2={H}
              stroke="var(--color-s-summary)"
              strokeWidth="0.8"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="2 2"
            />
          ))}
          {active && (
            <>
              <line
                x1={x(hover!)}
                x2={x(hover!)}
                y1="0"
                y2={H}
                stroke="var(--color-ink-3)"
                strokeWidth="0.7"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={x(hover!)}
                cy={y(active.contextTokens)}
                r="1.6"
                fill="var(--color-accent)"
                stroke="var(--color-panel)"
                strokeWidth="0.7"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>
      </div>
      <figcaption className="flex justify-between text-[9px] tabular-nums text-ink-3">
        {active ? (
          <>
            <span>request {active.n}</span>
            <span className="text-ink-2">
              {formatTokens(active.contextTokens)}
              {active.afterCompaction && <span className="ml-1 text-s-summary">· post-compaction</span>}
            </span>
          </>
        ) : (
          <>
            <span>{totalTurns} requests</span>
            <span>
              context growth
              {compactions.length > 0 && (
                <span className="ml-1 text-s-summary">· {compactions.length} compaction{compactions.length === 1 ? "" : "s"}</span>
              )}
            </span>
          </>
        )}
      </figcaption>
    </figure>
  );
}
