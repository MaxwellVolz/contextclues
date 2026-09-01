#!/usr/bin/env node
// CLI entry point for the published package.
//
// Runs the prebuilt Next server from the package directory, not the user's cwd,
// and binds to the loopback interface so a dashboard of your transcripts is never
// reachable from the local network.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

// node:sqlite is what removes the native build step. It appeared in 22.5, but stayed
// behind --experimental-sqlite until 22.13, so 22.5 through 22.12 cannot load it
// unflagged. Check before anything else, so an old runtime gets this instead of a
// module-not-found stack.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `contextclues: needs Node 22.13 or newer (found ${process.versions.node}).\n` +
      "It uses the built-in node:sqlite module, which older versions keep behind a flag.\n" +
      "Upgrade at https://nodejs.org, or with: nvm install 22"
  );
  process.exit(1);
}

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

const DEFAULT_PORT = 4310;
const DEFAULT_HOST = "127.0.0.1";

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, host: DEFAULT_HOST, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "--no-open") opts.open = false;
    else if (a === "-p" || a === "--port") opts.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) opts.port = Number(a.slice(7));
    else if (a === "-H" || a === "--host") opts.host = argv[++i];
    else if (a.startsWith("--host=")) opts.host = a.slice(7);
    else {
      console.error(`contextclues: unknown option "${a}"\n`);
      opts.help = true;
      opts.bad = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.version) {
  console.log(pkg.version);
  process.exit(0);
}

if (opts.help) {
  console.log(`
  ContextClues ${pkg.version}
  See what a running Claude Code session has in its context window.

  Usage
    $ contextclues [options]

  Options
    -p, --port <n>    Port to listen on (default ${DEFAULT_PORT})
    -H, --host <h>    Host to bind (default ${DEFAULT_HOST}, loopback only)
        --no-open     Do not open a browser on start
    -v, --version     Print version
    -h, --help        Show this help

  Environment
    CONTEXTCLUES_CLAUDE_DIR   Claude directory to read (default ~/.claude)
    CONTEXTCLUES_DATA_DIR     Where the local index lives (default ~/.contextclues)

  Claude's files are only ever read. Nothing leaves your machine.
`);
  process.exit(opts.bad ? 1 : 0);
}

if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
  console.error(`contextclues: invalid port "${opts.port}"`);
  process.exit(1);
}

const url = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;

/** Fail with a usable message rather than the runtime's EADDRINUSE stack trace. */
function checkPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err) => resolve(err.code ?? "EUNKNOWN"));
    probe.once("listening", () => probe.close(() => resolve(null)));
    probe.listen(port, host);
  });
}

const portError = await checkPortFree(opts.port, opts.host);
if (portError === "EADDRINUSE") {
  console.error(
    `contextclues: port ${opts.port} is already in use.\n` +
      `If ContextClues is already running, open ${url}\n` +
      `Otherwise pick another port:  contextclues --port ${opts.port + 1}`
  );
  process.exit(1);
} else if (portError === "EACCES") {
  console.error(`contextclues: not allowed to bind port ${opts.port}. Try a port above 1024.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next");
} catch {
  console.error(
    "contextclues: could not resolve the next runtime.\n" +
      "The package may be installed incompletely. Try reinstalling it."
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    nextBin,
    "start",
    pkgRoot,
    "-p",
    String(opts.port),
    "-H",
    opts.host,
  ],
  { stdio: ["inherit", "pipe", "inherit"], env: { ...process.env } }
);

let opened = false;
child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
  if (!opened && opts.open && /Ready in|started server on|Local:/i.test(String(buf))) {
    opened = true;
    openBrowser(url);
  }
});

function openBrowser(target) {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening a browser is a convenience, never a reason to fail the run.
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
    process.exit(0);
  });
}

child.on("exit", (code) => process.exit(code ?? 0));
