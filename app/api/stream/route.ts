import { getCollector } from "@/lib/collector.ts";

export const dynamic = "force-dynamic";

/** Server-Sent Events: pushes {sessionId} whenever the collector ingests new transcript lines. */
export async function GET(req: Request) {
  const collector = getCollector();
  const encoder = new TextEncoder();

  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const onUpdate = (sessionId: string) => send("update", { sessionId });
      const onRegistry = () => send("registry", {});
      collector.bus.on("update", onUpdate);
      collector.bus.on("registry", onRegistry);
      const heartbeat = setInterval(() => send("ping", { t: Date.now() }), 25_000);
      send("hello", { ok: true });

      cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        collector.bus.off("update", onUpdate);
        collector.bus.off("registry", onRegistry);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", () => cleanup?.());
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
