// Full real-electrobun test app for electrobun-plugin v0.2.0 E2E.
// Exercises every tool surface: BrowserWindow, BrowserView, RPC, FFI,
// console output, network requests, Updater state.

import { BrowserWindow, BrowserView } from "electrobun/bun";
import { devtools } from "electrobun-devtools";

// Shared RPC type — used by both sides
type AppRPC = {
  bun: {
    requests: {
      add: (a: { a: number; b: number }) => number;
      readSecret: () => string;
    };
    messages: {
      logFromView: (a: { msg: string }) => void;
    };
  };
  webview: {
    requests: { getViewTime: () => number };
    messages: { ping: (a: { n: number }) => void };
  };
};

// Start devtools BEFORE creating BrowserWindow so hooks intercept everything.
// Token will print + persist to .electrobun-devtools-token in cwd.
if (process.env.NODE_ENV !== "production") {
  await devtools.start({ port: 9876 });
  console.log("[test-app] devtools server started");
}

// Seed console output for app_log tool
console.log("[test-app] booting bun main process");
console.warn("[test-app] this is a warning for app_log");
console.error("[test-app] not really an error, seeded for app_log");

const win = new BrowserWindow({
  url: "views://mainview/index.html",
  width: 1024,
  height: 768,
  title: "electrobun-plugin E2E",
  rpc: BrowserView.defineRPC<AppRPC>({
    handlers: {
      requests: {
        add: ({ a, b }) => a + b,
        readSecret: () => "the-secret-is-42",
      },
      messages: {
        logFromView: ({ msg }) => console.log(`[from-view] ${msg}`),
      },
    },
  }),
});

console.log("[test-app] window created");

// After 2s, ping the view to populate RPC log with bun→view traffic
setTimeout(async () => {
  try {
    const t = await win.webview.rpc.request.getViewTime();
    console.log("[test-app] view time:", t);
    win.webview.rpc.send.ping({ n: 1 });
  } catch (err) {
    console.error("[test-app] view RPC failed:", err);
  }
}, 2000);
