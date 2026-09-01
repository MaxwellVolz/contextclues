import type { ActivityEvent } from "@/lib/types.ts";
import Panel from "./Panel";
import { formatTokens, relTime } from "./util";

const KIND_ICON: Record<ActivityEvent["kind"], string> = {
  user_prompt: "❯",
  assistant_reply: "◆",
  tool_call: "⚙",
  tool_result: "⇤",
  file_read: "▤",
  compaction: "▽",
  context_injection: "✚",
  config_change: "⚑",
};

const KIND_COLOR: Record<ActivityEvent["kind"], string> = {
  user_prompt: "text-s-user",
  assistant_reply: "text-s-assistant",
  tool_call: "text-ink-2",
  tool_result: "text-s-tool",
  file_read: "text-s-tool",
  compaction: "text-s-summary",
  context_injection: "text-s-injected",
  config_change: "text-accent",
};

export default function ActivityFeed({ activity }: { activity: ActivityEvent[] }) {
  return (
    <Panel
      title="Live Activity"
      right={<span className="text-[10px] text-ink-3">newest first</span>}
      bodyClass="gap-0"
    >
      <ul className="flex min-h-0 flex-col overflow-y-auto scrollbox pr-1">
        {activity.map((a) => (
          <li key={a.id} className="relative flex gap-3 border-l border-line pb-3 pl-4 last:pb-0">
            <span className="absolute -left-[3px] top-[5px] h-[5px] w-[5px] rounded-full bg-line-2" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] leading-snug text-ink" title={a.title}>
                <span className={`mr-1.5 ${KIND_COLOR[a.kind]}`}>{KIND_ICON[a.kind]}</span>
                {a.title}
              </p>
              {a.detail && (
                <p className="mt-0.5 truncate pl-[1.1rem] text-[10px] text-ink-3" title={a.detail}>
                  {a.detail}
                </p>
              )}
            </div>
            <div className="shrink-0 pt-px text-right">
              <p className="text-[10px] tabular-nums text-ink-3">{relTime(a.ts)}</p>
              {a.estTokens != null && a.kind !== "assistant_reply" && (
                <p className="text-[10px] tabular-nums text-ink-3/70">~{formatTokens(a.estTokens)}</p>
              )}
            </div>
          </li>
        ))}
        {activity.length === 0 && <li className="text-xs text-ink-3">nothing recorded yet</li>}
      </ul>
    </Panel>
  );
}
