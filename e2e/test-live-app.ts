#!/usr/bin/env bun
// Full E2E against a real running electrobun-test-app.
//
// Prerequisites:
//   1. `electrobun build` has been run (CEF + bun + native bins in artifacts/).
//   2. The app is launched via this script and runs with bundleCEF + remote-debugging-port=9222
//      AND devtools.start() listening on :9876 via electrobun-devtools.
//
// What we exercise:
//   - all 9 CDP tools against the real BrowserWindow webview
//   - all 7 bridge tools against the real bun process (hooks installed)
//   - rpc + ffi logging from real electrobun runtime traffic

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { McpHarness, MCP_ENTRY, run, type TestResult } from "./harness.ts";

const APP_ROOT = resolve(import.meta.dir, "..");
const TOKEN_FILE = resolve(APP_ROOT, ".electrobun-devtools-token");

function findArtifactExe(): string | null {
  // electrobun build produces `artifacts/{Name}.app` on mac, .exe on win.
  // Hunt for the launcher binary.
  const candidates = [
    resolve(APP_ROOT, "artifacts/win/electrobun-test-app/electrobun-test-app.exe"),
    resolve(APP_ROOT, "artifacts/win-x64/electrobun-test-app/electrobun-test-app.exe"),
    resolve(APP_ROOT, "artifacts/win-x64/launcher.exe"),
    resolve(APP_ROOT, "artifacts/launcher.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

let appProc: ChildProcess | null = null;

function startApp(): Promise<{ port: number; token: string }> {
  const exe = findArtifactExe();
  if (!exe) {
    throw new Error(
      "Could not find built electrobun-test-app launcher. Run `bun run build` first.",
    );
  }
  console.error(`Launching ${exe}`);

  // Remove stale token so devtools rotates it
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);

  appProc = spawn(exe, [], {
    cwd: APP_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });

  let token = "";
  appProc.stdout!.on("data", (chunk) => {
    const s = chunk.toString("utf8");
    process.stderr.write(`[app-stdout] ${s}`);
    const m = s.match(/\[electrobun-devtools\] token: ([a-f0-9]+)/);
    if (m) token = m[1];
  });
  appProc.stderr!.on("data", (chunk) => process.stderr.write(`[app-stderr] ${chunk.toString("utf8")}`));

  return new Promise<{ port: number; token: string }>(async (res, rej) => {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      try {
        const r = await fetch("http://localhost:9222/json/version");
        if (r.ok && existsSync(TOKEN_FILE)) {
          const t = token || readFileSync(TOKEN_FILE, "utf8").trim();
          if (t) return res({ port: 9876, token: t });
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    rej(new Error("App did not come up with CDP:9222 + devtools:9876 within 60s"));
  });
}

function stopApp(): void {
  if (appProc && !appProc.killed) {
    appProc.kill();
    appProc = null;
  }
}

async function main(): Promise<void> {
  console.error("=== LIVE E2E (real electrobun app) ===\n");
  const { port, token } = await startApp();
  console.error(`App up. devtoolsPort=${port} token=${token.slice(0, 16)}...\n`);

  // Give the app another beat to settle hooks
  await new Promise((r) => setTimeout(r, 2000));

  const mcp = new McpHarness(MCP_ENTRY, {
    ELECTROBUN_DEV_SESSION_TOKEN: token,
    ELECTROBUN_CDP_PORT: "9222",
    ELECTROBUN_DEVTOOLS_PORT: String(port),
    ELECTROBUN_ALLOW_EVAL: "true",
  });
  await mcp.start();
  const tools = await mcp.listTools();
  console.error(`MCP up. ${tools.length} tools.\n`);

  const results: TestResult[] = [];

  // ── Tier 1 against real electrobun CEF ───────────────────────────────
  let viewId = "";
  results.push(
    await run("electrobun_list_views (real CEF)", async () => {
      const r = await mcp.callTool("electrobun_list_views");
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        views: Array<{ id: string; url: string; title: string; type: string }>;
      };
      const page = parsed.views.find((v) => v.url.startsWith("views://"));
      if (page) viewId = page.id;
      return {
        pass: parsed.views.length >= 1 && !!viewId,
        reason: `${parsed.views.length} view(s); page id=${viewId.slice(0, 16)}`,
        detail: parsed,
      };
    }),
  );

  if (viewId) {
    results.push(
      await run("electrobun_eval (real)", async () => {
        const r = await mcp.callTool("electrobun_eval", {
          viewId,
          expression: "document.getElementById('h1')?.textContent",
        });
        const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { value: unknown };
        return {
          pass: parsed.value === "hello electrobun",
          reason: `got value=${JSON.stringify(parsed.value)}`,
          detail: parsed,
        };
      }),
    );

    results.push(
      await run("electrobun_dom (real)", async () => {
        const r = await mcp.callTool("electrobun_dom", { viewId });
        const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { html: string };
        return {
          pass: parsed.html.includes("hello electrobun") && parsed.html.includes("<html"),
          reason: `html length ${parsed.html.length}`,
        };
      }),
    );

    results.push(
      await run("electrobun_screenshot (real)", async () => {
        const r = await mcp.callTool("electrobun_screenshot", { viewId });
        const img = r.content?.[0];
        return {
          pass: img?.type === "image" && (img.data?.length ?? 0) > 1000,
          reason: `mime=${img?.mimeType} dataLen=${img?.data?.length}`,
        };
      }),
    );

    results.push(
      await run("electrobun_console (real)", async () => {
        // Warm subscription, trigger console.log, read
        await mcp.callTool("electrobun_console", { viewId, lastN: 1 });
        await mcp.callTool("electrobun_eval", {
          viewId,
          expression: "console.log('e2e-live-message')",
        });
        await new Promise((r) => setTimeout(r, 1000));
        const r = await mcp.callTool("electrobun_console", { viewId, lastN: 50 });
        const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
          messages: Array<{ args: Array<{ value?: unknown }> }>;
        };
        const seen = parsed.messages.some((m) =>
          m.args.some((a) => String(a.value ?? "").includes("e2e-live-message")),
        );
        return { pass: seen, reason: `${parsed.messages.length} messages, target seen: ${seen}` };
      }),
    );

    results.push(
      await run("electrobun_network (real)", async () => {
        await mcp.callTool("electrobun_network", { viewId, lastN: 1 });
        await mcp.callTool("electrobun_eval", {
          viewId,
          expression: "fetch('https://example.com/?live-e2e').catch(()=>0)",
        });
        await new Promise((r) => setTimeout(r, 2000));
        const r = await mcp.callTool("electrobun_network", { viewId, sinceMs: 60_000 });
        const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
          entries: Array<{ url: string }>;
        };
        const hit = parsed.entries.some((e) => e.url.includes("live-e2e"));
        return { pass: hit, reason: `${parsed.entries.length} entries; live-e2e seen: ${hit}` };
      }),
    );

    results.push(
      await run("electrobun_navigate (real)", async () => {
        const r = await mcp.callTool("electrobun_navigate", {
          viewId,
          url: "data:text/html,<title>nav-test</title>",
        });
        const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { frameId?: string };
        return { pass: !!parsed.frameId, reason: `frameId=${parsed.frameId}` };
      }),
    );

    results.push(
      await run("electrobun_reload (real)", async () => {
        const r = await mcp.callTool("electrobun_reload", { viewId });
        const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { ok?: boolean };
        return { pass: parsed.ok === true };
      }),
    );

    results.push(
      await run("electrobun_devtools (real)", async () => {
        const r = await mcp.callTool("electrobun_devtools", { viewId });
        const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { devtoolsUrl: string | null };
        return { pass: !!parsed.devtoolsUrl, reason: `url present: ${!!parsed.devtoolsUrl}` };
      }),
    );
  }

  // ── Tier 2 bridge against real electrobun-devtools + real hooks ──────
  results.push(
    await run("electrobun_list_windows (real)", async () => {
      const r = await mcp.callTool("electrobun_list_windows");
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { windows: unknown[] };
      return { pass: parsed.windows.length >= 1, reason: `${parsed.windows.length} window(s)` };
    }),
  );

  results.push(
    await run("electrobun_rpc_log (real)", async () => {
      const r = await mcp.callTool("electrobun_rpc_log", { sinceMs: 120_000 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        entries: Array<{ method?: string }>;
      };
      const sawAdd = parsed.entries.some((e) => e.method === "add" || e.method === "readSecret");
      return {
        pass: parsed.entries.length > 0,
        reason: `${parsed.entries.length} entries; add/readSecret seen: ${sawAdd}`,
      };
    }),
  );

  results.push(
    await run("electrobun_ffi_log (real)", async () => {
      const r = await mcp.callTool("electrobun_ffi_log", { sinceMs: 120_000 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { entries: unknown[] };
      return { pass: parsed.entries.length > 0, reason: `${parsed.entries.length} entries` };
    }),
  );

  results.push(
    await run("electrobun_bun_eval (real, allowEval=true)", async () => {
      const r = await mcp.callTool("electrobun_bun_eval", { code: "process.platform" });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { result?: unknown };
      return { pass: parsed.result === "win32", reason: `result=${JSON.stringify(parsed.result)}` };
    }),
  );

  results.push(
    await run("electrobun_updater_state (real)", async () => {
      const r = await mcp.callTool("electrobun_updater_state");
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { state: unknown };
      return { pass: !!parsed.state, reason: `state present: ${!!parsed.state}` };
    }),
  );

  results.push(
    await run("electrobun_app_log (real)", async () => {
      const r = await mcp.callTool("electrobun_app_log", { sinceMs: 120_000 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        entries: Array<{ message: string }>;
      };
      const seenBoot = parsed.entries.some((e) => e.message.includes("booting bun"));
      return {
        pass: parsed.entries.length > 0,
        reason: `${parsed.entries.length} entries; boot log seen: ${seenBoot}`,
      };
    }),
  );

  results.push(
    await run("electrobun_native_log (real, Windows)", async () => {
      const r = await mcp.callTool("electrobun_native_log", { sinceMs: 300_000 });
      const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as {
        platform: string;
        entries: unknown[];
      };
      return { pass: parsed.platform === "windows", reason: `platform=${parsed.platform}` };
    }),
  );

  // ── Teardown ─────────────────────────────────────────────────────────
  mcp.stop();
  stopApp();
  await new Promise((r) => setTimeout(r, 500));

  const passed = results.filter((r) => r.pass).length;
  console.error(`\n=== LIVE: ${passed}/${results.length} pass ===`);
  for (const r of results) {
    console.error(`  ${r.pass ? "✓" : "✗"} ${r.tool.padEnd(45)} ${r.durationMs}ms  ${r.reason ?? ""}`);
  }

  const outDir = resolve(APP_ROOT, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "live-results.json"),
    JSON.stringify({ when: new Date().toISOString(), passed, total: results.length, results }, null, 2),
    "utf8",
  );

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  stopApp();
  process.exit(2);
});
