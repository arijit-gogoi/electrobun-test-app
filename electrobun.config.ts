import type { ElectrobunConfig } from "electrobun";

// Full-validation config for electrobun-plugin v0.2.0 E2E.
// bundleCEF + remote-debugging-port enables Tier 1 CDP tools.

export default {
  app: {
    name: "electrobun-test-app",
    identifier: "test.electrobun-plugin.e2e",
    version: "0.0.1",
  },
  build: {
    bun: { entrypoint: "src/bun/index.ts" },
    views: {
      mainview: { entrypoint: "src/mainview/index.ts" },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
    },
    mac: {
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "remote-debugging-port": "9222" },
    },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "remote-debugging-port": "9222" },
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "remote-debugging-port": "9222" },
    },
  },
} satisfies ElectrobunConfig;
