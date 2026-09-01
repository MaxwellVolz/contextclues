// Tool provenance read from configuration files (read-only, best-effort).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "./helpers.ts";

const root = tempDir("toolsource");
const claude = join(root, "claude");
const project = join(root, "proj");
process.env.CONTEXTCLUES_CLAUDE_DIR = claude;

const { BUILTIN_TOOLS, readConfiguredSources } = await import("../lib/toolsource.ts");

mkdirSync(claude, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(join(claude, "skills", "brainstorming"), { recursive: true });
mkdirSync(join(claude, "skills", "shipping"), { recursive: true });
writeFileSync(join(claude, "skills", "loose-file.md"), "not a skill directory");

writeFileSync(
  join(claude, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      airtable: { type: "http", url: "https://example.invalid/mcp" },
      blender: { command: "uvx", args: ["blender-mcp"] },
      opaque: {},
    },
    projects: {
      [project]: { mcpServers: { projectScoped: { url: "https://example.invalid/p" } } },
      "/some/other/dir": { mcpServers: { elsewhere: { command: "x" } } },
    },
  }),
);
writeFileSync(
  join(claude, "settings.json"),
  JSON.stringify({ enabledPlugins: { "superpowers@marketplace": true, "old-thing@mp": false } }),
);
writeFileSync(
  join(project, ".mcp.json"),
  JSON.stringify({ mcpServers: { localOnly: { command: "node", args: ["server.js"] } } }),
);

test("built-ins are a non-empty static list with descriptions", () => {
  assert.ok(Object.keys(BUILTIN_TOOLS).length > 5);
  assert.equal(typeof BUILTIN_TOOLS.Bash, "string");
  for (const [name, desc] of Object.entries(BUILTIN_TOOLS)) {
    assert.ok(desc.length > 0, `${name} needs a description`);
  }
});

test("MCP servers are collected per scope with their transport inferred", () => {
  const cfg = readConfiguredSources(project);
  const byName = new Map(cfg.mcpServers.map((s) => [s.name, s]));

  assert.equal(byName.get("airtable")!.transport, "http", "explicit type wins");
  assert.equal(byName.get("airtable")!.scope, "global (~/.claude.json)");
  assert.equal(byName.get("blender")!.transport, "stdio", "a command implies stdio");
  assert.equal(byName.get("opaque")!.transport, null, "nothing to go on stays null");

  assert.equal(byName.get("projectScoped")!.transport, "http/sse", "a url implies http/sse");
  assert.equal(byName.get("projectScoped")!.scope, "project (~/.claude.json)");

  assert.equal(byName.get("localOnly")!.scope, "project (.mcp.json)");

  assert.ok(!byName.has("elsewhere"), "another project's servers are not ours");
  assert.deepEqual(cfg.configNotes, [], "a readable config produces no caveats");
});

test("a different cwd sees only the global servers", () => {
  const cfg = readConfiguredSources("/unrelated/path");
  const names = cfg.mcpServers.map((s) => s.name);
  assert.deepEqual(names.sort(), ["airtable", "blender", "opaque"]);
});

test("a null cwd is tolerated", () => {
  const cfg = readConfiguredSources(null);
  assert.ok(cfg.mcpServers.some((s) => s.name === "airtable"));
  assert.ok(!cfg.mcpServers.some((s) => s.name === "localOnly"));
});

test("plugins keep their enabled flag and skills come from directories only", () => {
  const cfg = readConfiguredSources(project);
  const plugins = new Map(cfg.plugins.map((p) => [p.name, p.enabled]));
  assert.equal(plugins.get("superpowers@marketplace"), true);
  assert.equal(plugins.get("old-thing@mp"), false);

  assert.deepEqual([...cfg.userSkills].sort(), ["brainstorming", "shipping"]);
});

test("an unreadable config is reported as a caveat rather than an empty registry", () => {
  const bare = join(root, "bare-home");
  mkdirSync(bare, { recursive: true });
  const previous = process.env.CONTEXTCLUES_CLAUDE_DIR;
  process.env.CONTEXTCLUES_CLAUDE_DIR = bare;
  try {
    const cfg = readConfiguredSources(null);
    assert.deepEqual(cfg.mcpServers, []);
    assert.deepEqual(cfg.plugins, []);
    assert.deepEqual(cfg.userSkills, []);
    assert.match(cfg.configNotes.join(" "), /MCP configuration unknown/);
  } finally {
    process.env.CONTEXTCLUES_CLAUDE_DIR = previous;
  }
});

test("malformed JSON is treated as absent, not fatal", () => {
  const broken = join(root, "broken-home");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, ".claude.json"), "{{{ not json");
  writeFileSync(join(broken, "settings.json"), "also not json");
  const previous = process.env.CONTEXTCLUES_CLAUDE_DIR;
  process.env.CONTEXTCLUES_CLAUDE_DIR = broken;
  try {
    const cfg = readConfiguredSources(null);
    assert.deepEqual(cfg.mcpServers, []);
    assert.deepEqual(cfg.plugins, []);
    assert.match(cfg.configNotes.join(" "), /MCP configuration unknown/);
  } finally {
    process.env.CONTEXTCLUES_CLAUDE_DIR = previous;
  }
});
