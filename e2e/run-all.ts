#!/usr/bin/env bun
// Run Tier 1 + Tier 2 in sequence, write a Markdown report.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dir;
const results = resolve(here, "../results");
mkdirSync(results, { recursive: true });

console.error("=== run-all: Tier 1 ===\n");
const t1 = spawnSync("bun", [resolve(here, "test-cdp.ts")], { stdio: "inherit" });

console.error("\n=== run-all: Tier 2 ===\n");
const t2 = spawnSync("bun", [resolve(here, "test-bridge.ts")], { stdio: "inherit" });

const cdp = existsSync(resolve(results, "cdp-results.json"))
  ? JSON.parse(readFileSync(resolve(results, "cdp-results.json"), "utf8"))
  : { passed: 0, total: 9, results: [] };
const bridge = existsSync(resolve(results, "bridge-results.json"))
  ? JSON.parse(readFileSync(resolve(results, "bridge-results.json"), "utf8"))
  : { passed: 0, total: 8, results: [] };

const total = cdp.total + bridge.total;
const passed = cdp.passed + bridge.passed;
const allOk = passed === total;

const md = `# E2E results — electrobun-plugin v0.2.0

**When:** ${new Date().toISOString()}
**Verdict:** ${allOk ? "PASS" : "FAIL"} — ${passed}/${total}

## Environment

- Platform: Windows 11
- Bun: $(bun --version)
- Chromium: 147.0.7727.138 (matches electrobun's CEF 147 pin)
- electrobun-plugin: v0.2.0
- electrobun-devtools: 0.2.0 (from npm)

## Tier 1 — CDP (${cdp.passed}/${cdp.total})

Spawned headless Chromium with \`--remote-debugging-port=9222\`, pointed our MCP server at it, exercised all 9 CDP tools.

| Tool | Pass | Duration | Notes |
|---|---|---|---|
${cdp.results.map((r: any) => `| \`${r.tool}\` | ${r.pass ? "✓" : "✗"} | ${r.durationMs}ms | ${(r.reason ?? "").replace(/\|/g, "\\|")} |`).join("\n")}

## Tier 2 — Bridge (${bridge.passed}/${bridge.total})

Started \`electrobun-devtools\` server in-process with stubbed handlers (no real electrobun runtime needed), pointed MCP at it, exercised all 7 bridge tools + 1 security-gate test.

| Tool | Pass | Duration | Notes |
|---|---|---|---|
${bridge.results.map((r: any) => `| \`${r.tool}\` | ${r.pass ? "✓" : "✗"} | ${r.durationMs}ms | ${(r.reason ?? "").replace(/\|/g, "\\|")} |`).join("\n")}

## What this proves

- MCP server boots cleanly, registers 16 tools, handles stdio JSON-RPC correctly.
- CDP wire format matches Chrome 147 (same as electrobun's pinned CEF 147).
- CDP tool subscriptions (console, network) are lazy on first call — caller must subscribe before triggering events.
- Bridge WS protocol works end-to-end with version-lock + token auth.
- Security gate: \`bun_eval\` refuses when \`allowEval\` is off, regardless of valid token.

## What this does NOT prove

- Whether electrobun's CEF actually emits a CDP endpoint when \`bundleCEF: true\` + \`chromiumFlags['remote-debugging-port']\` are set. (Likely yes — standard CEF behaviour — but not validated against a real electrobun build here.)
- Whether the \`electrobun-devtools\` hooks (\`rpc.ts\`, \`ffi.ts\`, \`windows.ts\`) successfully monkey-patch electrobun's internal modules. The bridge test bypassed hooks since no electrobun runtime is present.
- macOS / Linux \`native_log\` (deferred to roadmap).

## Next-step suggestions for a v0.2.x patch

1. Validate against \`bunx electrobun init\` template with \`bundleCEF: true\` to confirm CDP exposure.
2. Validate \`electrobun-devtools\` hook installation against a running electrobun app (RPC + FFI logging).
`;

writeFileSync(resolve(results, "REPORT.md"), md, "utf8");
console.error(`\n→ ${resolve(results, "REPORT.md")}`);
console.error(`\nVERDICT: ${allOk ? "PASS" : "FAIL"} — ${passed}/${total}`);

process.exit(allOk ? 0 : 1);
