#!/usr/bin/env bun
// Tier 2 bridge test — start electrobun-devtools server with a stub tools map
// (since we don't have a full electrobun runtime here), run our MCP server
// against it, exercise all 7 bridge tools.
//
// The stub bypasses electrobun monkey-patching (hooks would fail anyway with
// no electrobun running) — we test the wire protocol + MCP integration only.

import { mkdirSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "../node_modules/electrobun-devtools/src/server.ts";

import { McpHarness, MCP_ENTRY, run, type TestResult } from "./harness.ts";

const TEST_DIR = resolve(import.meta.dir, "../.test-bridge-state");
const TOKEN_FILE = resolve(TEST_DIR, ".electrobun-devtools-token");

async function main(): Promise<void> {
  console.error("=== Tier 2 Bridge E2E ===\n");

  // Clean state
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // Seed test data
  const rpcEntries = [
    { ts: Date.now() - 1000, direction: "view→bun", kind: "request", method: "getTitle", payload: {} },
    { ts: Date.now() - 500, direction: "bun→view", kind: "response", method: "getTitle", payload: "My App" },
  ];
  const ffiEntries = [
    { ts: Date.now() - 800, ns: "request", symbol: "createWindow", args: [{ width: 800 }], result: { id: 1 }, durationMs: 5 },
  ];
  const appLogEntries = [
    { ts: Date.now() - 600, level: "log", message: "app started" },
    { ts: Date.now() - 300, level: "warn", message: "deprecation warning" },
  ];

  // Start devtools server with stub tools
  const server = startServer({
    port: 19876,
    tokenFile: TOKEN_FILE,
    forceToken: true,
    tools: {
      list_windows: async () => ({ windows: [{ id: 1, title: "Main", url: "views://main/index.html" }] }),
      rpc_log: async (args) => ({ entries: rpcEntries.slice(-((args.lastN as number) ?? 200)) }),
      ffi_log: async (args) => ({ entries: ffiEntries.slice(-((args.lastN as number) ?? 200)) }),
      bun_eval: async (args) => {
        const code = String(args.code);
        // eslint-disable-next-line no-new-func
        const result = await new Function(`return (async () => ${code})()`)();
        return { result, type: typeof result };
      },
      updater_state: async () => ({
        state: { currentVersion: "0.1.0", channel: "stable", isChecking: false },
      }),
      app_log: async (args) => ({ entries: appLogEntries.slice(-((args.lastN as number) ?? 200)) }),
      native_log: async () => ({ entries: [], platform: "windows", warning: "stub" }),
    },
  });

  const token = server.token;
  console.error(`devtools server on :19876, token=${token.slice(0, 16)}...\n`);

  // Start MCP server pointing at the devtools port
  const mcp = new McpHarness(MCP_ENTRY, {
    ELECTROBUN_DEV_SESSION_TOKEN: token,
    ELECTROBUN_DEVTOOLS_PORT: "19876",
    ELECTROBUN_ALLOW_EVAL: "true", // for bun_eval test
  });
  await mcp.start();
  const tools = await mcp.listTools();
  console.error(`MCP up. ${tools.length} tools.\n`);

  const results: TestResult[] = [];

  results.push(
    await run("electrobun_list_windows", async () => {
      const r = await mcp.callTool("electrobun_list_windows");
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        windows: Array<{ id: number; title: string }>;
      };
      return {
        pass: parsed.windows.length === 1 && parsed.windows[0].title === "Main",
        reason: `${parsed.windows.length} window(s); titles: ${parsed.windows.map((w) => w.title).join(", ")}`,
        detail: parsed,
      };
    }),
  );

  results.push(
    await run("electrobun_rpc_log", async () => {
      const r = await mcp.callTool("electrobun_rpc_log", { sinceMs: 60_000, lastN: 50 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { entries: Array<{ method: string }> };
      const hasReq = parsed.entries.some((e) => e.method === "getTitle");
      return {
        pass: parsed.entries.length === 2 && hasReq,
        reason: `${parsed.entries.length} entries; getTitle seen: ${hasReq}`,
        detail: parsed,
      };
    }),
  );

  results.push(
    await run("electrobun_ffi_log", async () => {
      const r = await mcp.callTool("electrobun_ffi_log", { sinceMs: 60_000 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { entries: Array<{ symbol: string }> };
      const hasCreate = parsed.entries.some((e) => e.symbol === "createWindow");
      return {
        pass: parsed.entries.length === 1 && hasCreate,
        reason: `${parsed.entries.length} entries; createWindow seen: ${hasCreate}`,
        detail: parsed,
      };
    }),
  );

  results.push(
    await run("electrobun_bun_eval (allowEval=true)", async () => {
      const r = await mcp.callTool("electrobun_bun_eval", { code: "21 * 2" });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { result: number; type: string };
      return {
        pass: parsed.result === 42 && parsed.type === "number",
        reason: `result=${parsed.result}, type=${parsed.type}`,
        detail: parsed,
      };
    }),
  );

  results.push(
    await run("electrobun_updater_state", async () => {
      const r = await mcp.callTool("electrobun_updater_state");
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        state: { currentVersion: string; channel: string };
      };
      return {
        pass: parsed.state.currentVersion === "0.1.0" && parsed.state.channel === "stable",
        reason: `version=${parsed.state.currentVersion}, channel=${parsed.state.channel}`,
        detail: parsed,
      };
    }),
  );

  results.push(
    await run("electrobun_app_log", async () => {
      const r = await mcp.callTool("electrobun_app_log", { sinceMs: 60_000 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        entries: Array<{ level: string; message: string }>;
      };
      const hasWarn = parsed.entries.some((e) => e.level === "warn");
      return {
        pass: parsed.entries.length === 2 && hasWarn,
        reason: `${parsed.entries.length} entries; warn seen: ${hasWarn}`,
        detail: parsed,
      };
    }),
  );

  results.push(
    await run("electrobun_native_log (Windows)", async () => {
      const r = await mcp.callTool("electrobun_native_log", { sinceMs: 60_000 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        entries: unknown[];
        platform: string;
        warning?: string;
      };
      return {
        pass: parsed.platform === "windows" && Array.isArray(parsed.entries),
        reason: `platform=${parsed.platform}, entries=${parsed.entries.length}, warning=${parsed.warning ?? "none"}`,
        detail: parsed,
      };
    }),
  );

  // Now test the gate: allowEval=false should refuse bun_eval
  console.error("\n--- gate test: allowEval=false ---");
  mcp.stop();
  const mcpGated = new McpHarness(MCP_ENTRY, {
    ELECTROBUN_DEV_SESSION_TOKEN: token,
    ELECTROBUN_DEVTOOLS_PORT: "19876",
    ELECTROBUN_ALLOW_EVAL: "false",
  });
  await mcpGated.start();
  results.push(
    await run("electrobun_bun_eval (allowEval=false refuses)", async () => {
      const r = await mcpGated.callTool("electrobun_bun_eval", { code: "1+1" });
      const text = r.content?.[0]?.text ?? "";
      const refused = r.isError === true && text.toLowerCase().includes("alloweval");
      return {
        pass: refused,
        reason: `isError=${r.isError}; text contains 'alloweval': ${text.toLowerCase().includes("alloweval")}`,
        detail: { isError: r.isError, text: text.slice(0, 200) },
      };
    }),
  );
  mcpGated.stop();

  // Tear down
  server.stop();

  const passed = results.filter((r) => r.pass).length;
  console.error(`\n=== ${passed}/${results.length} bridge tools pass ===`);
  for (const r of results) {
    console.error(`  ${r.pass ? "✓" : "✗"} ${r.tool.padEnd(45)} ${r.durationMs}ms  ${r.reason ?? ""}`);
  }

  const outDir = resolve(import.meta.dir, "../results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "bridge-results.json"),
    JSON.stringify({ when: new Date().toISOString(), passed, total: results.length, results }, null, 2),
    "utf8",
  );

  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
