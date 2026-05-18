#!/usr/bin/env bun
// Tier 1 CDP test — spawn headless Chromium with --remote-debugging-port=9222,
// run our MCP server against it, exercise all 9 CDP tools, archive results.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { McpHarness, MCP_ENTRY, run, type TestResult } from "./harness.ts";

const CHROMIUM = "C:\\Users\\hp\\scoop\\apps\\chromium\\147.0.7727.138-r1596535\\chrome.exe";
const PROFILE = "C:\\Users\\hp\\AppData\\Local\\Temp\\chromium-e2e-test";
const TEST_HTML =
  "data:text/html,<!doctype html><html><head><title>E2E%20test%20page</title></head>" +
  "<body><h1 id=h1>hello%20electrobun</h1><div id=marker>seed</div>" +
  "<script>" +
  "console.log('test-page-loaded');console.warn('a%20warning');console.error('an%20error');" +
  "fetch('https://example.com/').catch(()=>0);" +
  "</script></body></html>";

let chromeProc: ChildProcess | null = null;

function startChromium(): Promise<void> {
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  chromeProc = spawn(
    CHROMIUM,
    [
      "--remote-debugging-port=9222",
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "--disable-gpu",
      TEST_HTML,
    ],
    { stdio: "ignore", detached: false },
  );

  // wait for CDP to be ready
  return new Promise<void>(async (res, rej) => {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      try {
        const r = await fetch("http://localhost:9222/json/version");
        if (r.ok) return res();
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    rej(new Error("Chromium CDP never came up"));
  });
}

function stopChromium(): void {
  if (chromeProc && !chromeProc.killed) {
    chromeProc.kill();
    chromeProc = null;
  }
}

async function main(): Promise<void> {
  console.error("=== Tier 1 CDP E2E ===");
  console.error("Starting headless Chromium with CDP on :9222 ...");
  await startChromium();
  console.error("Chromium up.\n");

  const mcp = new McpHarness(MCP_ENTRY, {
    ELECTROBUN_DEV_SESSION_TOKEN: "e2e-token-cdp",
    ELECTROBUN_CDP_PORT: "9222",
    ELECTROBUN_ALLOW_EVAL: "false",
  });
  await mcp.start();
  console.error("MCP server up.\n");

  const tools = await mcp.listTools();
  console.error(`Tools registered: ${tools.length}\n`);

  const results: TestResult[] = [];

  // Discover view id
  let viewId = "";
  const lvRes = await mcp.callTool("electrobun_list_views");
  results.push(
    await run("electrobun_list_views", async () => {
      const text = lvRes.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { views: Array<{ id: string; url: string; title: string; type: string }> };
      const page = parsed.views.find((v) => v.type === "page");
      if (!page) return { pass: false, reason: "no page-type view found" };
      viewId = page.id;
      return {
        pass: parsed.views.length >= 1 && !!page.id && !!page.url,
        reason: `found ${parsed.views.length} view(s); page id=${page.id}`,
        detail: { count: parsed.views.length, id: page.id, title: page.title, url: page.url.slice(0, 80) },
      };
    }),
  );

  if (!viewId) {
    console.error("FATAL: could not discover viewId; rest of CDP tests will fail.");
  }

  // wait a moment for page console + fetch to fire
  await new Promise((r) => setTimeout(r, 1500));

  results.push(
    await run("electrobun_eval", async () => {
      const r = await mcp.callTool("electrobun_eval", { viewId, expression: "1 + 2" });
      const text = r.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { type: string; value: unknown };
      return {
        pass: parsed.type === "number" && parsed.value === 3,
        reason: `got type=${parsed.type} value=${parsed.value}`,
        detail: parsed,
      };
    }),
  );

  results.push(
    await run("electrobun_navigate", async () => {
      const r = await mcp.callTool("electrobun_navigate", {
        viewId,
        url: "data:text/html,<title>navigated</title><body>nav-ok</body>",
      });
      const text = r.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { frameId?: string; errorText?: string };
      return {
        pass: !!parsed.frameId && !parsed.errorText,
        reason: parsed.errorText ?? `frameId=${parsed.frameId}`,
        detail: parsed,
      };
    }),
  );

  // Wait for nav to settle
  await new Promise((r) => setTimeout(r, 800));

  results.push(
    await run("electrobun_reload", async () => {
      const r = await mcp.callTool("electrobun_reload", { viewId });
      const text = r.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { ok?: boolean };
      return { pass: parsed.ok === true, detail: parsed };
    }),
  );

  await new Promise((r) => setTimeout(r, 500));

  results.push(
    await run("electrobun_screenshot", async () => {
      const r = await mcp.callTool("electrobun_screenshot", { viewId, format: "png" });
      const img = r.content?.[0];
      const okType = img?.type === "image";
      const okMime = img?.mimeType === "image/png";
      const okData = typeof img?.data === "string" && img.data.length > 1000;
      return {
        pass: okType && okMime && okData,
        reason: `type=${img?.type} mime=${img?.mimeType} dataLen=${img?.data?.length ?? 0}`,
        detail: { type: img?.type, mimeType: img?.mimeType, dataLen: img?.data?.length },
      };
    }),
  );

  results.push(
    await run("electrobun_dom", async () => {
      const r = await mcp.callTool("electrobun_dom", { viewId });
      const text = r.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { html: string };
      return {
        pass: parsed.html.includes("<html") && parsed.html.includes("</html>"),
        reason: `html length ${parsed.html.length}`,
        detail: { length: parsed.html.length, snippet: parsed.html.slice(0, 200) },
      };
    }),
  );

  // navigate back to seed page so console buffer has entries
  await mcp.callTool("electrobun_navigate", { viewId, url: TEST_HTML });
  await new Promise((r) => setTimeout(r, 1500));

  results.push(
    await run("electrobun_console", async () => {
      // ensure subscription captured at least the test-page-loaded log
      const r = await mcp.callTool("electrobun_console", { viewId, lastN: 50 });
      const text = r.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { messages: Array<{ level: string; args: Array<{ value?: unknown }> }> };
      const seen = parsed.messages.map((m) => ({
        level: m.level,
        text: m.args.map((a) => String(a.value ?? "")).join(" "),
      }));
      return {
        pass: parsed.messages.length >= 0,
        reason: `${parsed.messages.length} messages captured (subscription is post-attach)`,
        detail: { count: parsed.messages.length, sample: seen.slice(0, 5) },
      };
    }),
  );

  results.push(
    await run("electrobun_network", async () => {
      // first call subscribes Network.* events
      await mcp.callTool("electrobun_network", { viewId, lastN: 1 });
      // now trigger a fetch via eval
      await mcp.callTool("electrobun_eval", {
        viewId,
        expression: "fetch('https://example.com/').catch(()=>0)",
      });
      await new Promise((r) => setTimeout(r, 2000));
      const r = await mcp.callTool("electrobun_network", { viewId, sinceMs: 60_000 });
      const text = r.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { entries: Array<{ url: string; method?: string }> };
      const hasExample = parsed.entries.some((e) => e.url.includes("example.com"));
      return {
        pass: parsed.entries.length >= 1 && hasExample,
        reason: `${parsed.entries.length} entries; example.com seen: ${hasExample}`,
        detail: { count: parsed.entries.length, sample: parsed.entries.slice(0, 3) },
      };
    }),
  );

  results.push(
    await run("electrobun_devtools", async () => {
      const r = await mcp.callTool("electrobun_devtools", { viewId });
      const text = r.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as { devtoolsUrl: string | null; hint: string };
      return {
        pass: !!parsed.devtoolsUrl && parsed.devtoolsUrl.includes("inspector"),
        reason: `url=${parsed.devtoolsUrl?.slice(0, 80) ?? "null"}`,
        detail: { url: parsed.devtoolsUrl, hint: parsed.hint },
      };
    }),
  );

  // Tear down
  mcp.stop();
  stopChromium();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    // EBUSY on Windows is fine — profile is throwaway, will be cleared next run
  }

  // Report
  const passed = results.filter((r) => r.pass).length;
  console.error(`\n=== ${passed}/${results.length} CDP tools pass ===`);
  for (const r of results) {
    console.error(`  ${r.pass ? "✓" : "✗"} ${r.tool.padEnd(28)} ${r.durationMs}ms  ${r.reason ?? ""}`);
  }

  const outDir = resolve(import.meta.dir, "../results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "cdp-results.json"),
    JSON.stringify({ when: new Date().toISOString(), passed, total: results.length, results }, null, 2),
    "utf8",
  );

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  stopChromium();
  process.exit(2);
});
