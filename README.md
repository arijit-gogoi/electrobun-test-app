# electrobun-test-app

End-to-end test harness for [`electrobun-plugin`](https://github.com/arijit-gogoi/electrobun-plugin) v0.2.x — the Claude Code plugin that ships a 16-tool MCP server for driving Electrobun apps.

This is **not** a published library; it's a regression harness.

## What it does

Three test scripts under `e2e/`:

| Script | Tier | Backing | What it proves |
|---|---|---|---|
| `test-cdp.ts` | 1 | Headless Chromium 147 with `--remote-debugging-port=9222` | The plugin's CDP transport + 9 webview tools (list_views, eval, navigate, reload, screenshot, dom, console, network, devtools) speak the wire format correctly. Same Chromium version as electrobun's pinned CEF. |
| `test-bridge.ts` | 2 | In-process [`electrobun-devtools`](https://www.npmjs.com/package/electrobun-devtools) server with stubbed tool handlers | The plugin's bridge transport + 7 bun-side tools (list_windows, rpc_log, ffi_log, bun_eval, updater_state, app_log, native_log) speak the WS protocol correctly. Also verifies the security gate: `bun_eval` refuses when `allowEval: false`. |
| `test-live-app.ts` | 1 + 2 | A real built electrobun app (`bun run build`) | Validates against actual electrobun: CDP emitted by bundleCEF, `electrobun-devtools` hooks instrumenting real BrowserView RPC + native FFI calls. Requires CEF download (~150 MB). |

`run-all.ts` chains the first two and writes a Markdown + JSON report into `results/`.

## Layout

```
electrobun-test-app/
├── electrobun.config.ts        # bundleCEF: true + remote-debugging-port=9222
├── src/
│   ├── bun/index.ts            # devtools.start() then BrowserWindow + RPC
│   └── mainview/
│       ├── index.html
│       └── index.ts            # Electroview.defineRPC + console + fetch
└── e2e/
    ├── harness.ts              # stdio JSON-RPC client for the MCP server
    ├── test-cdp.ts             # Tier 1
    ├── test-bridge.ts          # Tier 2
    ├── test-live-app.ts        # Tier 1 + 2 against real app
    └── run-all.ts              # cdp + bridge + report
```

## Run

```bash
bun install
bun run test:all                # cdp + bridge (no electrobun build required)
bun run test:cdp
bun run test:bridge

# Live (requires real electrobun app build):
bun run build                   # ~150 MB CEF download on first run
bun run test:live
```

## How it talks to the plugin

`harness.ts` spawns the plugin's bundled MCP server (`electrobun-plugin/dist/mcp/index.js`) as a child process, exchanges newline-delimited JSON-RPC 2.0 messages on stdio, calls `tools/list` and `tools/call` per the [MCP spec](https://modelcontextprotocol.io). Plugin user-config is injected via env vars (`ELECTROBUN_DEV_SESSION_TOKEN`, `ELECTROBUN_CDP_PORT`, `ELECTROBUN_DEVTOOLS_PORT`, `ELECTROBUN_ALLOW_EVAL`).

Assumes the plugin repo is checked out as a sibling at `../i-create-skills/electrobun-plugin/`.

## Why a fresh repo

Test apps don't belong inside the plugin's marketplace tarball. Lives separately so the plugin stays tight, and `test-live-app.ts` runs against an honest "user-style" electrobun project (own `node_modules`, own `electrobun.config.ts`, own bun runtime install of `electrobun` from npm — no `file:` link back to upstream).

## Caveat — first-time electrobun CLI install

As of `electrobun@1.18.4-beta.3`, the lazy-download path in `node_modules/electrobun/bin/electrobun.cjs` has a tar-extraction bug on Windows. Workaround:

```bash
cd node_modules/electrobun/.cache
curl -L -o electrobun-win-x64.tar.gz \
  https://github.com/blackboardsh/electrobun/releases/download/v1.18.4-beta.3/electrobun-cli-win-x64.tar.gz
tar -xzf electrobun-win-x64.tar.gz
rm electrobun-win-x64.tar.gz
cp electrobun.exe ../bin/electrobun.exe
```

Then `./node_modules/electrobun/bin/electrobun.exe build` works.

## License

MIT.
