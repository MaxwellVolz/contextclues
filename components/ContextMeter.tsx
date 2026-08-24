import type { Meter, Trajectory } from "@/lib/types.ts";
import ConfidenceTag from "./ConfidenceTag";
import Panel from "./Panel";
import Sparkline from "./Sparkline";
import { fmtTokens, relTime } from "./util";

function fmtDuration(minutes: number | null): string | null {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  if (minutes < 1) return "<1 min";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  return h < 24 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} d`;
}

export default function ContextMeter({ meter, trajectory }: { meter: Meter; trajectory: Trajectory }) {
  const pct = meter.pct;
  const pressure = pct == null ? null : pct >= 85 ? "critical" : pct >= 70 ? "elevated" : null;
  const { burnRatePerTurn, burnRateTypical, turnsRemaining, turnsRemainingOptimistic, minutesRemaining, volatility } =
    trajectory;
  const runwayTime = fmtDuration(minutesRemaining);
  // A request is one API call — a single exchange is usually several of them.
  const runwayRequests =
    turnsRemaining == null
      ? null
      : turnsRemainingOptimistic != null
        ? `~${fmtTokens(turnsRemaining)}–${fmtTokens(turnsRemainingOptimistic)} req`
        : `~${fmtTokens(turnsRemaining)} req`;

  return (
    <Panel
      title="Context Meter"
      className="shrink-0"
      right={<ConfidenceTag level={meter.confidence} />}
      bodyClass="gap-4"
      foot={
        <>
          Token count is the API&apos;s own figure from the last assistant turn (observed). Max
          window is <em>{meter.maxTokensConfidence}</em> — Claude CLI does not expose it.
        </>
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[42px] font-semibold leading-none tabular-nums tracking-tight text-ink">
          {pct == null ? "—" : `${pct.toFixed(1)}%`}
        </span>
        <div className="text-right">
          <p className="text-sm tabular-nums text-ink-2">
            {fmtTokens(meter.contextTokens)}{" "}
            <span className="text-ink-3">/ {fmtTokens(meter.maxTokens)}</span>
          </p>
          {pressure ? (
            <p
              className={`mt-1 inline-block rounded-sm border px-1.5 py-0.5 text-[9px] uppercase tracking-widest ${
                pressure === "critical" ? "border-thread text-thread" : "border-accent text-accent"
              }`}
            >
              ⚠ {pressure}
            </p>
          ) : (
            <p className="mt-1 text-[10px] uppercase tracking-widest text-ink-3">tokens</p>
          )}
        </div>
      </div>

      {/* meter bar with threshold ticks at 70 / 85 */}
      <div>
        <div
          className="relative h-3.5 overflow-hidden rounded-sm border border-line bg-raised"
          role="img"
          aria-label={pct == null ? "context usage unknown" : `context window ${pct.toFixed(1)} percent full`}
        >
          {pct != null && (
            <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${Math.max(0.5, pct)}%` }} />
          )}
          <div className="absolute inset-y-0 border-l border-ink-3/70" style={{ left: "70%" }} />
          <div className="absolute inset-y-0 border-l border-thread/80" style={{ left: "85%" }} />
        </div>
        <div className="relative mt-0.5 h-3 text-[9px] tabular-nums text-ink-3">
          <span className="absolute -translate-x-1/2" style={{ left: "70%" }}>70</span>
          <span className="absolute -translate-x-1/2 text-thread/80" style={{ left: "85%" }}>85</span>
        </div>
      </div>

      {/* trajectory: where the window is heading, not just where it is */}
      <div className="flex flex-col gap-2 rounded-md border border-line bg-raised/50 p-2.5">
        <Sparkline turns={trajectory.turns} totalTurns={trajectory.totalTurns} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
          <Row
            k="burn rate"
            v={burnRatePerTurn == null ? "—" : `~${fmtTokens(burnRatePerTurn)}/req`}
            title={
              burnRatePerTurn == null
                ? (trajectory.reason ?? "no rate yet")
                : `Average growth per model request across the last ${trajectory.sampleSize} requests (observed).` +
                  (burnRateTypical != null
                    ? ` A typical request adds ~${fmtTokens(burnRateTypical)}; the average is higher because occasional large reads count at the rate they actually occur.`
                    : "") +
                  " A request is one API call — a single exchange is usually several."
            }
          />
          <Row
            k="runway"
            v={runwayTime ?? runwayRequests ?? "—"}
            title={
              turnsRemaining == null
                ? (trajectory.reason ?? "cannot project yet")
                : `Projected headroom at the current rate — inferred, not a guarantee. ${runwayRequests ?? ""}`
            }
          />
        </dl>
        <p className="text-[9px] leading-relaxed text-ink-3">
          {burnRatePerTurn == null ? (
            (trajectory.reason ?? "Projection unavailable.")
          ) : (
            <>
              {runwayRequests && (
                <>
                  <span className="text-ink-2">{runwayRequests}</span> of headroom.{" "}
                </>
              )}
              Rate <span className="text-ink-2">observed</span>, runway{" "}
              <span className="text-ink-2">projected</span>
              {volatility === "variable" &&
                burnRateTypical != null &&
                `; a typical request adds only ~${fmtTokens(burnRateTypical)}, so large reads dominate`}
              .
            </>
          )}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
        {meter.usageBreakdown && (
          <>
            <Row k="cache read" v={fmtTokens(meter.usageBreakdown.cacheRead)} />
            <Row k="cache write" v={fmtTokens(meter.usageBreakdown.cacheCreation)} />
            <Row k="fresh input" v={fmtTokens(meter.usageBreakdown.input)} />
            <Row k="output" v={fmtTokens(meter.usageBreakdown.output)} />
          </>
        )}
        <Row k="observed" v={meter.observedAt ? relTime(meter.observedAt) : "never"} />
        <Row k="since then" v={`+~${fmtTokens(meter.estTokensSinceObserved)}`} />
        {meter.budgetTokensLeft != null && <Row k="budget left" v={fmtTokens(meter.budgetTokensLeft)} />}
        <Row k="model" v={meter.model ?? "unknown"} />
      </dl>
    </Panel>
  );
}

function Row({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 overflow-hidden" title={title}>
      <dt className="shrink-0 text-ink-3">{k}</dt>
      <span className="mx-1 flex-1 border-b border-dotted border-line-2/70" aria-hidden />
      <dd className="max-w-[55%] truncate tabular-nums text-ink-2" title={title ?? v}>
        {v}
      </dd>
    </div>
  );
}
