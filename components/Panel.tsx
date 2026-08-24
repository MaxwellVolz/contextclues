import type { ReactNode } from "react";

/**
 * Shared panel chrome: a bordered card with a header strip, a body, and an
 * optional footnote strip. Keeps spacing and hierarchy identical across panels.
 */
export default function Panel({
  title,
  right,
  children,
  foot,
  bodyClass = "",
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  bodyClass?: string;
  className?: string;
}) {
  return (
    <section className={`panel flex min-h-0 min-w-0 flex-col ${className}`}>
      <header className="panel-head shrink-0">
        <h2 className="panel-title">{title}</h2>
        {right && <div className="ml-auto flex min-w-0 items-center gap-3">{right}</div>}
      </header>
      <div className={`flex min-h-0 flex-1 flex-col p-4 ${bodyClass}`}>{children}</div>
      {foot && <div className="panel-foot shrink-0">{foot}</div>}
    </section>
  );
}
