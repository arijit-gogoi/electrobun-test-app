#!/usr/bin/env bun
// Quick diagnostic: spawn app, use bun_eval to probe what's actually
// reachable from the bundled bun runtime.

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { McpHarness, MCP_ENTRY } from "./harness.ts";

const APP_ROOT = resolve(import.meta.dir, "..");
const exe = resolve(APP_ROOT, "build/dev-win-x64/electrobun-test-app-dev/bin/launcher.exe");

let appProc: ChildProcess | null = spawn(exe, [], { cwd: APP_ROOT, stdio: ["ignore", "pipe", "pipe"] });
let token = "";
appProc.stdout!.on("data", (c) => {
  const s = c.toString();
  process.stderr.write(`[app] ${s}`);
  const m = s.match(/\[electrobun-devtools\] token: ([a-f0-9]+)/);
  if (m) token = m[1];
});
appProc.stderr!.on("data", (c) => process.stderr.write(`[app-err] ${c}`));

const start = Date.now();
while (Date.now() - start < 30_000) {
  if (token) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!token) {
  console.error("no token");
  appProc.kill();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 3000));

const mcp = new McpHarness(MCP_ENTRY, {
  ELECTROBUN_DEV_SESSION_TOKEN: token,
  ELECTROBUN_CDP_PORT: "9222",
  ELECTROBUN_DEVTOOLS_PORT: "9876",
  ELECTROBUN_ALLOW_EVAL: "true",
});
await mcp.start();

// Pure expressions — bun_eval wraps as `return (...)`. Use IIFE patterns + .catch.
const probes = [
  "Object.keys(globalThis).filter(k => k.toLowerCase().includes('electrobun')).join(',')",
  "import('electrobun/bun').then(m => Object.keys(m).slice(0,20).join(',')).catch(e => 'err: ' + e.message)",
  "import('electrobun/dist/api/bun/core/BrowserWindow').then(m => Object.keys(m).join(',')).catch(e => 'err: ' + e.message)",
  "import('electrobun/dist/api/bun/proc/native').then(m => Object.keys(m).join(',')).catch(e => 'err: ' + e.message)",
  "import('electrobun/dist/api/bun/core/BrowserWindow').then(m => { const map = m.BrowserWindowMap; return JSON.stringify({type: typeof map, keys: map ? Object.keys(map).slice(0,5) : null}); }).catch(e => 'err: ' + e.message)",
  "import('electrobun/dist/api/bun/proc/native').then(m => { const ffi = m.ffi; return JSON.stringify({type: typeof ffi, keys: ffi ? Object.keys(ffi).slice(0,10) : null, requestType: typeof ffi?.request, requestKeys: ffi?.request ? Object.keys(ffi.request).slice(0,5) : null}); }).catch(e => 'err: ' + e.message)",
];

for (const probe of probes) {
  const r = await mcp.callTool("electrobun_bun_eval", { code: probe });
  const text = r.content?.[0]?.text ?? "";
  console.log("\n>>", probe.slice(0, 100));
  console.log("<<", text);
}

mcp.stop();
appProc.kill();
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
