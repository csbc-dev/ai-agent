// Shared WebSocket server for the remote-mode examples.
//
// CSBC Case B1: `AiCore` runs here, on the server. Each browser-side
// <ai-agent> drives its own Core over WebSocket through RemoteCoreProxy
// (client) <-> RemoteShellProxy (server). The provider API key lives only
// in this process's environment and never reaches the browser.
//
// `@csbc-dev/ai-agent` ships no server helper — `AiCore` itself runs
// unchanged on the server; the only glue is RemoteShellProxy +
// WebSocketServerTransport from `@wc-bindable/remote`.
import { WebSocketServer } from "ws";
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import { AiCore } from "@csbc-dev/ai-agent";

const port = Number(process.env.PORT ?? 8080);
const provider = process.env.AI_PROVIDER || "openai";
const model = process.env.AI_MODEL || "";
const apiKey = process.env.AI_API_KEY || "";
const baseUrl = process.env.AI_BASE_URL || "";
const system = process.env.AI_SYSTEM || "";

// AiCore subclass that injects provider credentials server-side.
//
// In remote mode <ai-agent> does not forward api-key / base-url to the
// server by default, so the `options` arriving from the browser carry
// empty credential fields. We override them here from server env. We also
// pin `model` and `system` when configured, so the browser value (which is
// not trusted) cannot pick a costlier model or replace the system prompt.
class ServerAiCore extends AiCore {
  // `provider` is a wcBindable *input*: the client's `<ai-agent provider=...>`
  // is mirrored to the server-side Core via the remote proxy and would reach
  // AiCore's `provider` setter. Pin it to the server's env provider so a client
  // cannot switch providers and have the single server-held AI_API_KEY (issued
  // for one provider) sent to a different one. Ignoring the incoming value here
  // is the security boundary; the connection handler still sets the env value
  // explicitly below.
  set provider(_clientValue) {
    super.provider = provider;
  }
  get provider() {
    return super.provider;
  }

  async send(prompt, options) {
    // `provider` is intentionally absent here: it is not part of `options`
    // (AiCore reads it from the `provider` property, not the request) and the
    // setter above already pins it to the server's env provider. We only need
    // to override the credential / model / system fields that *do* travel in
    // `options` from the (untrusted) client.
    return super.send(prompt, {
      ...options,
      apiKey,
      baseUrl: baseUrl || options.baseUrl,
      model: model || options.model,
      system: system || options.system,
    });
  }
}

const wss = new WebSocketServer({ port, path: "/ai-agent" });

wss.on("connection", (ws) => {
  // One AiCore per connection — it owns conversation history, the in-flight
  // AbortController, and streaming state, and must not be shared across
  // sessions.
  const core = new ServerAiCore();
  core.provider = provider;

  const transport = new WebSocketServerTransport(ws);
  const shell = new RemoteShellProxy(core, transport);

  ws.on("close", () => {
    core.abort();    // cancel any in-flight inference
    shell.dispose(); // unbind and release the Core
  });
});

console.log(`[ai-agent] remote Core listening on ws://localhost:${port}/ai-agent`);
console.log(`[ai-agent] provider=${provider} model=${model || "(client-supplied)"}`);
if (!apiKey && !baseUrl) {
  console.warn(
    "[ai-agent] neither AI_API_KEY nor AI_BASE_URL is set — " +
      "set one in .env (see .env.example) or requests will fail.",
  );
}
