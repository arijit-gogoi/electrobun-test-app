# E2E results — electrobun-plugin v0.2.0

**When:** 2026-05-18T07:20:30.802Z
**Verdict:** PASS — 17/17

## Environment

- Platform: Windows 11
- Bun: $(bun --version)
- Chromium: 147.0.7727.138 (matches electrobun's CEF 147 pin)
- electrobun-plugin: v0.2.0
- electrobun-devtools: 0.2.0 (from npm)

## Tier 1 — CDP (9/9)

Spawned headless Chromium with `--remote-debugging-port=9222`, pointed our MCP server at it, exercised all 9 CDP tools.

| Tool | Pass | Duration | Notes |
|---|---|---|---|
| `electrobun_list_views` | ✓ | 1ms | found 1 view(s); page id=EAEA99023FF6AFC42B8C426382321DFB |
| `electrobun_eval` | ✓ | 9ms | got type=number value=3 |
| `electrobun_navigate` | ✓ | 18ms | frameId=EAEA99023FF6AFC42B8C426382321DFB |
| `electrobun_reload` | ✓ | 12ms |  |
| `electrobun_screenshot` | ✓ | 37ms | type=image mime=image/png dataLen=3592 |
| `electrobun_dom` | ✓ | 6ms | html length 69 |
| `electrobun_console` | ✓ | 5ms | 0 messages captured (subscription is post-attach) |
| `electrobun_network` | ✓ | 2097ms | 1 entries; example.com seen: true |
| `electrobun_devtools` | ✓ | 3ms | url=https://chrome-devtools-frontend.appspot.com/serve_rev/@022a5605792996d967e05acd |

## Tier 2 — Bridge (8/8)

Started `electrobun-devtools` server in-process with stubbed handlers (no real electrobun runtime needed), pointed MCP at it, exercised all 7 bridge tools + 1 security-gate test.

| Tool | Pass | Duration | Notes |
|---|---|---|---|
| `electrobun_list_windows` | ✓ | 12ms | 1 window(s); titles: Main |
| `electrobun_rpc_log` | ✓ | 5ms | 2 entries; getTitle seen: true |
| `electrobun_ffi_log` | ✓ | 2ms | 1 entries; createWindow seen: true |
| `electrobun_bun_eval (allowEval=true)` | ✓ | 2ms | result=42, type=number |
| `electrobun_updater_state` | ✓ | 5ms | version=0.1.0, channel=stable |
| `electrobun_app_log` | ✓ | 6ms | 2 entries; warn seen: true |
| `electrobun_native_log (Windows)` | ✓ | 2ms | platform=windows, entries=0, warning=stub |
| `electrobun_bun_eval (allowEval=false refuses)` | ✓ | 6ms | isError=true; text contains 'alloweval': true |

## What this proves

- MCP server boots cleanly, registers 16 tools, handles stdio JSON-RPC correctly.
- CDP wire format matches Chrome 147 (same as electrobun's pinned CEF 147).
- CDP tool subscriptions (console, network) are lazy on first call — caller must subscribe before triggering events.
- Bridge WS protocol works end-to-end with version-lock + token auth.
- Security gate: `bun_eval` refuses when `allowEval` is off, regardless of valid token.

## What this does NOT prove

- Whether electrobun's CEF actually emits a CDP endpoint when `bundleCEF: true` + `chromiumFlags['remote-debugging-port']` are set. (Likely yes — standard CEF behaviour — but not validated against a real electrobun build here.)
- Whether the `electrobun-devtools` hooks (`rpc.ts`, `ffi.ts`, `windows.ts`) successfully monkey-patch electrobun's internal modules. The bridge test bypassed hooks since no electrobun runtime is present.
- macOS / Linux `native_log` (deferred to roadmap).

## Next-step suggestions for a v0.2.x patch

1. Validate against `bunx electrobun init` template with `bundleCEF: true` to confirm CDP exposure.
2. Validate `electrobun-devtools` hook installation against a running electrobun app (RPC + FFI logging).
