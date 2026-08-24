// Tool provenance: what is enabled, and how we know.
//
// Sources, in decreasing confidence:
//   1. Transcript observations — tool_use blocks, deferred_tools_delta, skill_listing (observed)
//   2. Configuration files — ~/.claude.json, <cwd>/.mcp.json, settings.json, plugins, skills (configured)
//   3. A static list of Claude Code built-ins (assumed; this cannot be enumerated locally)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "./registry.ts";

/** Core Claude Code built-in tools (Claude Code 2.x). Static list — labeled "assumed" in the UI. */
export const BUILTIN_TOOLS: Record<string, string> = {
  Bash: "Execute shell commands",
  Read: "Read files (text, images, PDFs, notebooks)",
  Write: "Create or overwrite files",
  Edit: "Exact string replacement in files",
  Glob: "Find files by pattern",
  Grep: "Search file contents (ripgrep)",
  Task: "Launch subagents",
  Agent: "Launch subagents (newer alias)",
  WebFetch: "Fetch and summarize a URL",
  WebSearch: "Search the web",
  TodoWrite: "Manage the task list",
  NotebookEdit: "Edit Jupyter notebook cells",
  AskUserQuestion: "Ask the user a structured question",
  Skill: "Invoke an installed skill / slash command",
  EnterPlanMode: "Enter planning mode",
  ExitPlanMode: "Exit planning mode",
  KillShell: "Kill a background shell",
  TaskOutput: "Read background task output",
};

export interface ConfiguredMcpServer {
  name: string;
  scope: string; // "global (~/.claude.json)" | "project (~/.claude.json)" | "project (.mcp.json)"
  transport: string | null;
}

export interface ConfiguredSources {
  mcpServers: ConfiguredMcpServer[];
  plugins: { name: string; enabled: boolean }[];
  userSkills: string[];
  configNotes: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mcpEntries(obj: unknown, scope: string): ConfiguredMcpServer[] {
  if (obj == null || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, unknown>).map(([name, cfg]) => {
    const c = (cfg ?? {}) as Record<string, unknown>;
    const transport =
      typeof c.type === "string" ? c.type : typeof c.command === "string" ? "stdio" : typeof c.url === "string" ? "http/sse" : null;
    return { name, scope, transport };
  });
}

/** Enumerate MCP servers, plugins, and skills from configuration (read-only). */
export function readConfiguredSources(cwd: string | null): ConfiguredSources {
  const notes: string[] = [];
  const home = claudeDir();
  const dotClaudeJson =
    readJson(join(home, ".claude.json")) ?? readJson(join(home, "..", ".claude.json"));

  const mcpServers: ConfiguredMcpServer[] = [];
  if (dotClaudeJson) {
    mcpServers.push(...mcpEntries(dotClaudeJson.mcpServers, "global (~/.claude.json)"));
    if (cwd) {
      const projects = (dotClaudeJson.projects ?? {}) as Record<string, unknown>;
      const proj = (projects[cwd] ?? {}) as Record<string, unknown>;
      mcpServers.push(...mcpEntries(proj.mcpServers, "project (~/.claude.json)"));
    }
  } else {
    notes.push("~/.claude.json could not be read; MCP configuration unknown.");
  }
  if (cwd) {
    const projMcp = readJson(join(cwd, ".mcp.json"));
    if (projMcp) mcpServers.push(...mcpEntries(projMcp.mcpServers, "project (.mcp.json)"));
  }

  const settings = readJson(join(home, "settings.json"));
  const plugins: { name: string; enabled: boolean }[] = [];
  if (settings && settings.enabledPlugins && typeof settings.enabledPlugins === "object") {
    for (const [name, enabled] of Object.entries(settings.enabledPlugins as Record<string, unknown>)) {
      plugins.push({ name, enabled: enabled === true });
    }
  }

  let userSkills: string[] = [];
  try {
    userSkills = readdirSync(join(home, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // no user skills dir
  }

  return { mcpServers, plugins, userSkills, configNotes: notes };
}
