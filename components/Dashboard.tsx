"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseFile } from "@/lib/types.ts";
import ContextMeter from "./ContextMeter";
import Composition from "./Composition";
import CluesPanel from "./CluesPanel";
import EvidenceExplorer from "./EvidenceExplorer";
import ToolRegistry from "./ToolRegistry";
import ActivityFeed from "./ActivityFeed";
import { relTime } from "./util";

interface CaseListItem {
  sessionId: string;
  cwd: string | null;
  name: string | null;
  live: boolean;
  kind: string | null;
  status: string | null;
  pid: number | null;
  updatedAt: number | null;
  startedAt: number | null;
  model: string | null;
  eventCount: number;
}

export default function Dashboard() {
  const [cases, setCases] = useState<CaseListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [caseFile, setCaseFile] = useState<CaseFile | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const userPickedRef = useRef(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  selectedRef.current = selected;

  const fetchCases = useCallback(async () => {
    try {
      const res = await fetch("/api/cases");
      const data = (await res.json()) as { cases: CaseListItem[] };
      setCases(data.cases);
      // Auto-detect once: prefer a live interactive session with the most recent
      // activity. Re-run only if the current selection disappeared, so the view
      // doesn't flap between busy sessions.
      const currentStillExists = data.cases.some((c) => c.sessionId === selectedRef.current);
      if (!userPickedRef.current && data.cases.length > 0 && (!selectedRef.current || !currentStillExists)) {
        const best =
          data.cases.find((c) => c.live && c.kind === "interactive") ??
          data.cases.find((c) => c.live) ??
          data.cases[0];
        if (best) setSelected(best.sessionId);
      }
      setError(null);
    } catch {
      setError("collector unreachable");
    }
  }, []);

  const fetchCase = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/case/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as CaseFile;
      // Ignore late responses for a case the user has switched away from.
      if (selectedRef.current === id) setCaseFile(data);
    } catch {
      setError("collector unreachable");
    }
  }, []);

  useEffect(() => {
    void fetchCases();
  }, [fetchCases]);

  useEffect(() => {
    if (selected) void fetchCase(selected);
  }, [selected, fetchCase]);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("update", (ev) => {
      try {
        const { sessionId } = JSON.parse((ev as MessageEvent).data) as { sessionId: string };
        if (sessionId === selectedRef.current) {
          if (refetchTimer.current) clearTimeout(refetchTimer.current);
          refetchTimer.current = setTimeout(() => void fetchCase(sessionId), 400);
        }
      } catch {
        // malformed event — ignore
      }
    });
    es.addEventListener("registry", () => void fetchCases());
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => es.close();
  }, [fetchCase, fetchCases]);

  const current = cases.find((c) => c.sessionId === selected);

  return (
    <main className="mx-auto flex h-screen max-w-[1720px] flex-col gap-4 p-4 xl:px-6 xl:py-5">
      <header className="panel flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
        <h1 className="text-[15px] font-semibold leading-none tracking-[0.22em] text-accent">
          CONTEXT<span className="text-ink">CLUES</span>
        </h1>
        <span className="hidden h-5 w-px bg-line-2 sm:block" aria-hidden />
        <div className="flex min-w-0 items-center gap-2.5 text-[11px]">
          <span className="shrink-0 uppercase tracking-[0.16em] text-ink-3">case file</span>
          <select
            value={selected ?? ""}
            onChange={(e) => {
              userPickedRef.current = true;
              setSelected(e.target.value);
            }}
            className="control max-w-[440px] truncate py-1.5 text-[11px]"
          >
            {cases.map((c) => (
              <option key={c.sessionId} value={c.sessionId}>
                {c.live ? "● " : "○ "}
                {(c.name ?? c.sessionId.slice(0, 8)) + " — " + (c.cwd ?? "?")}
              </option>
            ))}
            {cases.length === 0 && <option value="">no sessions found</option>}
          </select>
        </div>
        {current &&
          (current.live ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-s-tool/40 bg-s-tool/10 px-2.5 py-1 text-[10px] tracking-wider text-s-tool">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-s-tool" />
              LIVE
              <span className="text-s-tool/70">· pid {current.pid} · {current.status}</span>
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-line-2 px-2.5 py-1 text-[10px] tracking-wider text-ink-3">
              CLOSED · last activity {relTime(current.updatedAt)}
            </span>
          ))}
        <span className="ml-auto flex shrink-0 items-center gap-4 text-[10px] text-ink-3">
          {error && <span className="text-thread">{error}</span>}
          <span title="Server-Sent Events stream" className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-s-tool live-dot" : "bg-thread"}`}
            />
            {connected ? "stream on" : "stream off"}
          </span>
          {caseFile && <span className="tabular-nums">rendered {relTime(caseFile.generatedAt)}</span>}
        </span>
      </header>

      {caseFile ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,380px)_1fr_minmax(300px,400px)]">
          <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto scrollbox">
            <ContextMeter meter={caseFile.meter} trajectory={caseFile.trajectory} />
            <Composition slices={caseFile.composition} />
            <CluesPanel clues={caseFile.clues} className="min-h-[180px] flex-1" />
          </div>
          <div className="flex min-h-0 min-w-0 flex-col gap-4">
            <EvidenceExplorer evidence={caseFile.evidence} />
          </div>
          <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1.15fr)] gap-4">
            <ToolRegistry tools={caseFile.tools} />
            <ActivityFeed activity={caseFile.activity} />
          </div>
        </div>
      ) : (
        <div className="panel flex flex-1 items-center justify-center text-sm text-ink-3">
          {cases.length === 0
            ? "Scanning ~/.claude for sessions… start a Claude CLI session to open a case."
            : "Opening case file…"}
        </div>
      )}

      {caseFile && caseFile.notes.length > 0 && (
        <footer className="panel px-5 py-2.5">
          <p className="text-[10px] leading-relaxed text-ink-3">
            <span className="mr-2 uppercase tracking-[0.16em] text-ink-3/80">notes</span>
            {caseFile.notes.map((n, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-2 text-line-2">·</span>}
                {n}
              </span>
            ))}
          </p>
        </footer>
      )}
    </main>
  );
}
