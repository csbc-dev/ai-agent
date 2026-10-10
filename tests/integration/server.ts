/**
 * E2E test server for ai-agent remote mode.
 *
 * - Serves static files (dist + test HTML) via HTTP
 * - Provides /api/ai endpoint that returns mock OpenAI-compatible responses
 * - Runs a WebSocket server with AiCore connected through RemoteShellProxy,
 *   over a transport wrapped in withoutThrowInternals (as in
 *   examples/remote/server)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { RemoteShellProxy } from "@wc-bindable/remote";
import type { ServerTransport, ServerMessage, ClientMessage } from "@wc-bindable/remote";
// The server entry (`@csbc-dev/ai-agent/server`), from source like the rest
// of this server: the default barrel defines <ai-agent> and cannot load in Node.
import { AiCore, withoutThrowInternals } from "../../src/server.js";

// ---------------------------------------------------------------------------
// ws → ServerTransport adapter
// ---------------------------------------------------------------------------

function createWsServerTransport(ws: import("ws").WebSocket): ServerTransport {
  return {
    send(message: ServerMessage) {
      ws.send(JSON.stringify(message));
    },
    onMessage(handler: (msg: ClientMessage) => void) {
      ws.on("message", (data) => {
        handler(JSON.parse(String(data)));
      });
    },
    onClose(handler: () => void) {
      ws.on("close", handler);
    },
  };
}

// ---------------------------------------------------------------------------
// MIME type helper
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
};

// ---------------------------------------------------------------------------
// Mock AI API responses
// ---------------------------------------------------------------------------

function buildNonStreamResponse(prompt: string): string {
  return JSON.stringify({
    choices: [{ message: { content: `Echo: ${prompt}` } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function buildStreamResponse(prompt: string): string {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Echo" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: ": " } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: prompt } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  return lines.join("");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(port: number): Promise<{
  close: () => Promise<void>;
  port: number;
  /** The error of every `throw` reply as onThrow got it: before stack / cause are stripped. */
  thrown: unknown[];
}> {
  const thrown: unknown[] = [];
  return new Promise((resolve) => {
    // Repo root is two levels up from `tests/integration/`. The previous
    // `../../../../` value was a leftover from the original wc-bindable
    // monorepo layout (where this file lived under `packages/ai/tests/...`)
    // and pointed outside the repository in this single-package repackage.
    const repoRoot = path.resolve(import.meta.dirname, "../../");
    const integrationDir = import.meta.dirname;

    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";

      // Route: /api/ai/error* — always returns 500. Must precede the
      // generic /api/ai handler below or the more-specific path is shadowed.
      if (url.startsWith("/api/ai/error")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        });
        return;
      }

      // Route: /api/ai/slow* — holds the request open (an inference that is
      // still running) until the caller aborts it. Answers after 5 s anyway so
      // a request nobody aborts cannot keep the server from closing.
      if (url.startsWith("/api/ai/slow")) {
        req.resume();
        const timer = setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(buildNonStreamResponse("slow"));
        }, 5000);
        res.on("close", () => clearTimeout(timer));
        return;
      }

      // Route: /api/ai/* — mock OpenAI-compatible API
      if (url.startsWith("/api/ai")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const prompt = parsed.messages?.at(-1)?.content ?? "";
            const wantStream = parsed.stream !== false;

            if (wantStream) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });
              res.end(buildStreamResponse(prompt));
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(buildNonStreamResponse(prompt));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad request" }));
          }
        });
        return;
      }

      // Route: /client.html
      if (url === "/" || url === "/client.html") {
        const file = path.join(integrationDir, "client.html");
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // Route: /element.html — <ai-agent> itself (built dist) in remote mode
      if (url === "/element.html") {
        const file = path.join(integrationDir, "element.html");
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // Route: /packages/{core,remote}/dist/... → node_modules/@wc-bindable/{core,remote}/dist/...
      // Route: /packages/ai/dist/... → repoRoot/dist/...
      // The /packages/ URL space is a leftover of the original wc-bindable
      // monorepo layout used by client.html's import map. In this single-
      // package repackage, sibling packages live under node_modules and the
      // ai package's own dist is at the repo root, so we translate at the
      // server boundary rather than rewriting the import map.
      if (url.startsWith("/packages/")) {
        let file: string | null = null;
        const aiMatch = url.match(/^\/packages\/ai\/dist\/(.*)$/);
        const wcMatch = url.match(/^\/packages\/(core|remote)\/dist\/(.*)$/);
        if (aiMatch) {
          file = path.join(repoRoot, "dist", aiMatch[1]);
        } else if (wcMatch) {
          file = path.join(repoRoot, "node_modules", "@wc-bindable", wcMatch[1], "dist", wcMatch[2]);
        } else {
          file = path.join(repoRoot, url);
        }
        if (file && fs.existsSync(file)) {
          const ext = path.extname(file);
          res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws) => {
      const core = new AiCore();
      core.provider = "openai";
      // Keep the server's stack / cause out of the `throw` replies
      // (wc-bindable-protocol#38). onThrow records what the browser no longer
      // receives, for the spec to check, instead of logging it.
      const transport = withoutThrowInternals(createWsServerTransport(ws), {
        onThrow: (error) => thrown.push(error),
      });
      new RemoteShellProxy(core, transport);
    });

    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        thrown,
        close: () => new Promise<void>((r) => {
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
}
