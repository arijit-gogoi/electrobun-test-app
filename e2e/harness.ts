// Shared E2E harness — spawn MCP server, talk stdio JSON-RPC, assert results.
//
// MCP protocol: JSON-RPC 2.0 over stdio. Each message = single JSON object,
// newline-delimited (Content-Length framing is OPTIONAL for stdio; bun's
// MCP SDK uses newline-delimited).

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

export type ToolCallResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

export class McpHarness {
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (msg: unknown) => void>();
  private notifications: unknown[] = [];

  constructor(
    private mcpEntry: string,
    private env: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn("bun", [this.mcpEntry], {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          } else {
            this.notifications.push(msg);
          }
        } catch {
          // ignore non-JSON
        }
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // MCP server prints status to stderr per stdio convention.
      process.stderr.write(`[mcp-stderr] ${chunk.toString("utf8")}`);
    });

    // Initialize handshake — required by MCP spec.
    await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-harness", version: "0.0.0" },
    });
    await this.sendNotification("notifications/initialized", {});
  }

  private send(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolveFn) => {
      this.pending.set(id, (m) => resolveFn(m as { result?: unknown; error?: unknown }));
      this.proc!.stdin!.write(msg);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolveFn({ error: { code: -1, message: `timeout: ${method}` } });
        }
      }, 30_000);
    });
  }

  private sendNotification(method: string, params: unknown): Promise<void> {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc!.stdin!.write(msg);
    return Promise.resolve();
  }

  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const res = await this.send("tools/list", {});
    if (res.error) throw new Error(`tools/list failed: ${JSON.stringify(res.error)}`);
    return (res.result as { tools: Array<{ name: string; description: string }> }).tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const res = await this.send("tools/call", { name, arguments: args });
    if (res.error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(res.error) }] };
    }
    return res.result as ToolCallResult;
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

export type TestResult = {
  tool: string;
  pass: boolean;
  reason?: string;
  detail?: unknown;
  durationMs: number;
};

export async function run(
  name: string,
  fn: () => Promise<{ pass: boolean; reason?: string; detail?: unknown }>,
): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { tool: name, pass: r.pass, reason: r.reason, detail: r.detail, durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      tool: name,
      pass: false,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}

export const PLUGIN_REPO = resolve(import.meta.dir, "../../i-create-skills/electrobun-plugin");
export const MCP_ENTRY = resolve(PLUGIN_REPO, "dist/mcp/index.js");
