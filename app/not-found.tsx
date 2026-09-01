import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Not found — ContextClues",
};

/**
 * The dashboard is a single page, so a 404 here almost always means a mistyped
 * or stale URL rather than a missing feature. Point back at the board.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="panel w-full max-w-md px-8 py-10 text-center">
        <p className="text-[11px] uppercase tracking-[0.28em] text-accent">Error 404</p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">
          No evidence at this address
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-2">
          That page is not part of the case file. The dashboard lives at the root.
        </p>

        <div
          className="mt-7 rounded-md border border-line bg-raised px-4 py-3 text-left"
          role="img"
          aria-label="An empty context meter reading zero of zero tokens."
        >
          <div className="flex justify-between text-[10px] uppercase tracking-wider text-ink-3">
            <span>context meter</span>
            <span className="tabular-nums">0 / 0 tokens</span>
          </div>
          <div className="mt-2 h-3.5 rounded-sm border border-line bg-bg" />
        </div>

        <Link
          href="/"
          className="mt-7 inline-block rounded-md border border-accent bg-accent px-5 py-2.5 text-[12px] font-medium tracking-wider text-bg transition-colors hover:bg-accent/90"
        >
          Back to the dashboard
        </Link>
      </section>
    </main>
  );
}
