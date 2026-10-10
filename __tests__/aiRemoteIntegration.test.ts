/**
 * Remote integration tests
 *
 * End-to-end: Ai Shell → RemoteCoreProxy → mock transport → RemoteShellProxy → AiCore → fetch (mocked)
 *
 * Unlike the unit tests in aiRemote.test.ts (which verify individual branches),
 * these tests exercise full request/response cycles and verify that the
 * client-side Shell and server-side Core stay consistent throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ClientTransport,
  ServerTransport,
  ClientMessage,
  ServerMessage,
} from "@wc-bindable/remote";
import { RemoteShellProxy } from "@wc-bindable/remote";
import { Ai } from "../src/components/Ai";
import { AiCore } from "../src/core/AiCore";
import { OpenAiProvider } from "../src/providers/OpenAiProvider";
import { registerComponents } from "../src/registerComponents";
import { setConfig, resetConfig } from "../src/config";

registerComponents();

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

/**
 * Every frame is JSON round-tripped at the boundary, exactly like a real
 * WebSocket (SPEC-extensions.md § Design invariants, invariant 3: transports
 * MUST serialize so every transport presents the same view). A by-reference
 * mock would let an Error / class instance reach the other side intact and
 * hide wire-shape regressions. `clientSent` records the decoded client →
 * server frames so tests can assert what actually crossed the wire.
 */
function createMockTransportPair(options: {
  rewriteServerMessage?: (msg: ServerMessage) => ServerMessage | null;
} = {}): {
  client: ClientTransport;
  server: ServerTransport;
  clientSent: ClientMessage[];
  closeClient: () => void;
} {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;
  let clientCloseHandler: (() => void) | null = null;
  const clientSent: ClientMessage[] = [];
  const wire = <T>(msg: T): T => JSON.parse(JSON.stringify(msg));

  const client: ClientTransport = {
    send: (msg) => {
      const decoded = wire(msg);
      clientSent.push(decoded);
      if (serverHandler) Promise.resolve().then(() => serverHandler!(wire(msg)));
    },
    onMessage: (handler) => { clientHandler = handler; },
    // `closeClient` stands in for the WebSocket closing under the proxy.
    onClose: (handler) => { clientCloseHandler = handler; },
  };

  const server: ServerTransport = {
    send: (msg) => {
      // `rewriteServerMessage` stands in for a different producer (another
      // protocol version, a legacy server) or a server that never answers
      // `sync` (return null to drop the frame).
      const decoded = options.rewriteServerMessage
        ? options.rewriteServerMessage(wire(msg))
        : wire(msg);
      if (decoded && clientHandler) Promise.resolve().then(() => clientHandler!(decoded));
    },
    onMessage: (handler) => { serverHandler = handler; },
  };

  return { client, server, clientSent, closeClient: () => clientCloseHandler?.() };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait long enough for async transport + Core processing to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

// ---------------------------------------------------------------------------
// Response factories
// ---------------------------------------------------------------------------

function jsonResponse(body: any, status = 200): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: null,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function sseData(data: string): string {
  return `data: ${data}\n\n`;
}

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers({ "Content-Type": "text/event-stream" }),
    body: stream,
    json: () => Promise.reject(new Error("streaming")),
    text: () => Promise.reject(new Error("streaming")),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * `deferConnect` leaves the client unconnected so a test can put the server
 * Core into a state first and then observe it through the initial `sync`
 * (which reads `core[name]` directly) instead of through an `update` (which
 * reads the event detail). `shellWarnings` collects RemoteShellProxy's
 * logger output — a non-JsonValue property value is reported there as a
 * dropped update / dropped sync value.
 */
function createRemoteAi(options: {
  deferConnect?: boolean;
  rewriteServerMessage?: (msg: ServerMessage) => ServerMessage | null;
} = {}): {
  el: Ai;
  core: AiCore;
  shell: RemoteShellProxy;
  clientSent: ClientMessage[];
  shellWarnings: string[];
  connect: () => void;
  closeTransport: () => void;
  cleanup: () => void;
} {
  const core = new AiCore();
  const { client, server, clientSent, closeClient } = createMockTransportPair({
    rewriteServerMessage: options.rewriteServerMessage,
  });
  const shellWarnings: string[] = [];
  const shell = new RemoteShellProxy(core, server, {
    logger: {
      warn: (msg: string) => { shellWarnings.push(msg); },
      error: (msg: string) => { shellWarnings.push(msg); },
    },
  });

  const el = document.createElement("ai-agent") as Ai;
  const connect = () => { (el as any)._connectRemote(client); };
  if (!options.deferConnect) connect();

  return {
    el,
    core,
    shell,
    clientSent,
    shellWarnings,
    connect,
    closeTransport: closeClient,
    cleanup: () => {
      shell.dispose();
      el.remove();
    },
  };
}

function sentSendArgs(clientSent: ClientMessage[]): unknown[] {
  const cmd = clientSent.filter(
    (m): m is Extract<ClientMessage, { type: "cmd" }> => m.type === "cmd" && m.name === "send",
  ).at(-1);
  if (!cmd) throw new Error("no send cmd was put on the wire");
  return cmd.args;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Remote integration", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    document.body.innerHTML = "";
  });

  const wireKinds = (sent: ClientMessage[]): string[] =>
    sent.map(m => (m.type === "sync" ? "sync" : `${m.type}:${m.name}`));

  function hangingFetchUntilAbort(): void {
    fetchSpy.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }));
  }

  // -----------------------------------------------------------------------
  // Non-streaming full cycle
  // -----------------------------------------------------------------------
  describe("非ストリーミング完全サイクル", () => {
    it("send → API応答 → 状態反映 → 会話履歴が一貫している", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "Hello from server!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";

      el.prompt = "Hi there";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      // 全イベントを記録
      const events: Array<{ name: string; value: any }> = [];
      for (const prop of Ai.wcBindable.properties) {
        el.addEventListener(prop.event, (e: Event) => {
          events.push({ name: prop.name, value: (e as CustomEvent).detail });
        });
      }

      const result = await el.send();
      await settle();

      // 返り値
      expect(result).toBe("Hello from server!");

      // クライアント側の状態がサーバーと一致
      expect(el.content).toBe("Hello from server!");
      expect(el.loading).toBe(false);
      expect(el.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(el.error).toBeNull();

      // 会話履歴が正しい
      expect(el.messages).toEqual([
        { role: "user", content: "Hi there" },
        { role: "assistant", content: "Hello from server!" },
      ]);

      // サーバー側と同期
      expect(core.content).toBe("Hello from server!");
      expect(core.messages).toEqual(el.messages);

      // loading の遷移が記録されている (true → false)
      const loadingEvents = events.filter(e => e.name === "loading");
      expect(loadingEvents.some(e => e.value === true)).toBe(true);
      expect(loadingEvents[loadingEvents.length - 1].value).toBe(false);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Streaming full cycle
  // -----------------------------------------------------------------------
  describe("ストリーミング完全サイクル", () => {
    it("ストリーミングチャンクがリアルタイムでクライアントに到達する", async () => {
      const chunks = [
        sseData('{"choices":[{"delta":{"content":"Hello"}}]}'),
        sseData('{"choices":[{"delta":{"content":" world"}}]}'),
        sseData('{"choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}'),
        sseData("[DONE]"),
      ];
      fetchSpy.mockResolvedValueOnce(streamResponse(chunks));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.prompt = "Stream test";
      el.setAttribute("model", "gpt-4o");

      const contentSnapshots: string[] = [];
      el.addEventListener("ai-agent:content-changed", (e: Event) => {
        contentSnapshots.push((e as CustomEvent).detail);
      });

      const result = await el.send();
      await settle();

      expect(result).toBe("Hello world");
      expect(el.content).toBe("Hello world");
      expect(el.streaming).toBe(false);
      expect(el.loading).toBe(false);
      expect(el.usage).toEqual({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });

      // content-changed が複数回発火している（中間更新 + 最終値）
      expect(contentSnapshots.length).toBeGreaterThanOrEqual(1);
      expect(contentSnapshots[contentSnapshots.length - 1]).toBe("Hello world");

      // 会話履歴
      expect(el.messages).toEqual([
        { role: "user", content: "Stream test" },
        { role: "assistant", content: "Hello world" },
      ]);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple sends — conversation accumulation
  // -----------------------------------------------------------------------
  describe("複数回sendによる会話履歴の蓄積", () => {
    it("連続sendで会話履歴が正しく蓄積される", async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({
          choices: [{ message: { content: "Reply 1" } }],
        }))
        .mockResolvedValueOnce(jsonResponse({
          choices: [{ message: { content: "Reply 2" } }],
        }));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;

      // 1回目
      el.prompt = "First";
      await el.send();
      await settle();

      expect(el.messages).toEqual([
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply 1" },
      ]);

      // 2回目
      el.prompt = "Second";
      await el.send();
      await settle();

      expect(el.messages).toEqual([
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Second" },
        { role: "assistant", content: "Reply 2" },
      ]);

      // サーバー側と一致
      expect(core.messages).toEqual(el.messages);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // History reset via messages setter
  // -----------------------------------------------------------------------
  describe("messagesセッターによる履歴リセット", () => {
    it("クライアントからの履歴クリアがサーバーに反映される", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "Hi" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Hello";

      await el.send();
      await settle();
      expect(core.messages).toHaveLength(2);

      // クライアントから履歴をクリア
      el.messages = [];
      await settle();

      expect(core.messages).toEqual([]);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // HTTP error
  // -----------------------------------------------------------------------
  describe("HTTPエラーのハンドリング", () => {
    it("APIエラーがクライアント側のerrorプロパティに反映される", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse("Unauthorized", 401));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Fail test";

      const errorEvents: any[] = [];
      el.addEventListener("ai-agent:error", (e: Event) => {
        errorEvents.push((e as CustomEvent).detail);
      });

      const result = await el.send();
      await settle();

      expect(result).toBeNull();
      expect(el.loading).toBe(false);
      expect(el.error).not.toBeNull();
      expect(el.error.status).toBe(401);

      // エラー時はユーザーメッセージが履歴から除去される
      expect(el.messages).toEqual([]);
      expect(core.messages).toEqual([]);

      // エラーイベントがクライアント側で発火している
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Abort mid-request
  // -----------------------------------------------------------------------
  describe("リクエスト中のabort", () => {
    it("abort()がサーバー側のリクエストをキャンセルする", async () => {
      // サーバー側fetchがabortされるまで解決しない
      fetchSpy.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Abort test";

      const sendPromise = el.send();
      await settle();

      // サーバー側Coreを直接abort（リモートinvokeはfire-and-forget的に届く）
      core.abort();
      await settle();

      const result = await sendPromise;
      await settle();

      expect(result).toBeNull();
      expect(el.loading).toBe(false);
      // abort時はユーザーメッセージが除去される
      expect(el.messages).toEqual([]);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Anthropic provider via remote
  // -----------------------------------------------------------------------
  describe("Anthropicプロバイダ経由のストリーミング", () => {
    it("Anthropic SSE形式のストリーミングが正しく処理される", async () => {
      const chunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bonjour"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" le monde"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      fetchSpy.mockResolvedValueOnce(streamResponse(chunks));

      const { el, core, cleanup } = createRemoteAi();
      await settle();

      core.provider = "anthropic";
      el.prompt = "Say hello in French";
      el.setAttribute("model", "claude-sonnet-4-20250514");

      const result = await el.send();
      await settle();

      expect(result).toBe("Bonjour le monde");
      expect(el.content).toBe("Bonjour le monde");
      expect(el.usage).toEqual({ promptTokens: 20, completionTokens: 8, totalTokens: 28 });
      expect(el.streaming).toBe(false);
      expect(el.loading).toBe(false);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // system message collection
  // -----------------------------------------------------------------------
  describe("systemメッセージの収集", () => {
    it("system属性がリモートsendのオプションに含まれる", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "OK" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.setAttribute("system", "You are a pirate.");
      el.stream = false;
      el.prompt = "Hello";

      await el.send();
      await settle();

      // fetchに渡されたbodyにsystemメッセージが含まれる
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.messages[0]).toEqual({ role: "system", content: "You are a pirate." });

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // trigger integration
  // -----------------------------------------------------------------------
  describe("trigger経由の完全サイクル", () => {
    it("trigger=true → send → 結果反映 → trigger=false の一連の流れ", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "Triggered response" } }],
      }));

      const { el, core, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Trigger test";

      const triggerEvents: boolean[] = [];
      el.addEventListener("ai-agent:trigger-changed", (e: Event) => {
        triggerEvents.push((e as CustomEvent).detail);
      });

      el.trigger = true;
      expect(el.trigger).toBe(true);

      // コマンド配送 + 処理 + 結果配送 + finally
      await settle();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(el.trigger).toBe(false);
      expect(el.content).toBe("Triggered response");
      expect(triggerEvents).toContain(false);

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // @wc-bindable/remote 0.10 strict JsonValue gate — regressions
  // -----------------------------------------------------------------------
  describe("@wc-bindable/remote 0.10 JsonValue要件の回帰", () => {
    function noDroppedValues(warnings: string[]): void {
      expect(warnings.filter(w => /dropped|not a JsonValue/.test(w))).toEqual([]);
    }

    // OpenAI-shaped tool-call turn with a fresh id each time, so the history
    // synced to the client stays valid for validateMessages (unique ids).
    function toolLoopFetch(): void {
      let n = 0;
      fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: `call_${n++}`, type: "function", function: { name: "loop", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
      })));
    }

    it("オプション未設定（既定設定）のリモートsendが成功し、undefinedキーをwireに載せない", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "default ok" } }],
      }));

      const { el, core, clientSent, shellWarnings, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      // temperature / max-tokens / tools / toolChoice / maxToolRoundtrips /
      // responseSchema / responseSchemaName / stream-options are all unset.

      await expect(el.send()).resolves.toBe("default ok");
      await settle();

      const [prompt, options] = sentSendArgs(clientSent);
      expect(prompt).toBe("Hi");
      expect(Object.keys(options as object).sort()).toEqual(["model", "stream", "system"]);
      expect(el.error).toBeNull();
      expect(el.content).toBe("default ok");
      noDroppedValues(shellWarnings);

      cleanup();
    });

    it("設定済みのオプションは従来どおり転送され、tool handlerは剥がされる", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "configured ok" } }],
      }));

      const { el, core, clientSent, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();

      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.temperature = 0.5;
      el.maxTokens = 64;
      el.streamOptions = "never";
      el.tools = [{ name: "lookup", description: "d", parameters: { type: "object" }, handler: () => "x" }];
      el.toolChoice = { name: "lookup" };
      el.maxToolRoundtrips = 3;
      el.responseSchemaName = "unused";
      el.prompt = "Hi";

      await expect(el.send()).resolves.toBe("configured ok");

      const [, options] = sentSendArgs(clientSent);
      expect(options).toEqual({
        model: "gpt-4o",
        stream: true,
        system: "",
        temperature: 0.5,
        maxTokens: 64,
        tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }],
        toolChoice: { name: "lookup" },
        maxToolRoundtrips: 3,
        responseSchemaName: "unused",
        streamOptions: "never",
      });

      cleanup();
    });

    describe("非HTTPエラーがリモートでel.errorに届く", () => {
      it("update経路: ネットワーク障害", async () => {
        fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

        const { el, core, shellWarnings, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        await settle();

        core.provider = "openai";
        el.setAttribute("model", "gpt-4o");
        el.prompt = "Hi";

        await expect(el.send()).resolves.toBeNull();
        await settle();

        expect(el.error).toBeInstanceOf(Error);
        expect(el.error).toMatchObject({ name: "TypeError", message: "Failed to fetch" });
        expect(el.loading).toBe(false);
        expect(el.messages).toEqual([]);
        noDroppedValues(shellWarnings);

        cleanup();
      });

      it("update経路: maxToolRoundtrips超過（サーバー側handler）", async () => {
        toolLoopFetch();

        const { el, core, shellWarnings, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        await settle();

        core.provider = "openai";
        core.registerTool("loop", async () => ({ again: true }));
        el.setAttribute("model", "gpt-4o");
        el.stream = false;
        el.tools = [{ name: "loop", description: "loops", parameters: { type: "object" } }];
        el.maxToolRoundtrips = 1;
        el.prompt = "loop";

        await expect(el.send()).resolves.toBeNull();
        await settle();

        expect(el.error).toBeInstanceOf(Error);
        expect((el.error as Error).message).toContain("maxToolRoundtrips (1) exceeded");
        expect(el.messages).toEqual([]);
        expect(el.loading).toBe(false);
        noDroppedValues(shellWarnings);

        cleanup();
      });

      it("sync経路: 接続前にサーバーCoreがネットワーク障害を保持している", async () => {
        fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

        const { el, core, shellWarnings, connect, cleanup } = createRemoteAi({ deferConnect: true });
        core.provider = "openai";
        await core.send("Hi", { model: "gpt-4o", stream: false });
        expect(core.error).toMatchObject({ name: "TypeError" });

        // sync は core.error を直接読む（宣言 getter を通らない）
        connect();
        document.body.appendChild(el);
        await settle();

        expect(el.error).toBeInstanceOf(Error);
        expect(el.error).toMatchObject({ name: "TypeError", message: "Failed to fetch" });
        noDroppedValues(shellWarnings);

        cleanup();
      });

      it("sync経路: 接続前にサーバーCoreがmaxToolRoundtrips超過を保持している", async () => {
        toolLoopFetch();

        const { el, core, shellWarnings, connect, cleanup } = createRemoteAi({ deferConnect: true });
        core.provider = "openai";
        await core.send("loop", {
          model: "gpt-4o",
          stream: false,
          maxToolRoundtrips: 1,
          tools: [{ name: "loop", description: "", parameters: {}, handler: async () => "again" }],
        });

        connect();
        document.body.appendChild(el);
        await settle();

        expect(el.error).toBeInstanceOf(Error);
        expect((el.error as Error).message).toContain("maxToolRoundtrips (1) exceeded");
        noDroppedValues(shellWarnings);

        cleanup();
      });
    });

    describe("status/statusTextを持つ非Errorの例外がリモートでel.errorに届く", () => {
      class UpstreamHttpError {
        status = 429;
        statusText = "Too Many Requests";
        body = "slow down";
        retryAfter = 7;
        headers = new Map([["retry-after", "7"]]);
      }
      const cases: Array<{ label: string; thrown: () => unknown; expected: Record<string, unknown> }> = [
        {
          label: "Responseオブジェクト",
          thrown: () => new Response("upstream down", { status: 503, statusText: "Service Unavailable" }),
          expected: { status: 503, statusText: "Service Unavailable", body: "" },
        },
        {
          label: "Errorを継承しないHTTPエラークラス",
          thrown: () => new UpstreamHttpError(),
          expected: { status: 429, statusText: "Too Many Requests", body: "slow down", retryAfter: 7 },
        },
        {
          label: "undefinedキー入りのplain object",
          thrown: () => ({ status: 500, statusText: "Internal Server Error", body: "oops", retryAfter: undefined }),
          expected: { status: 500, statusText: "Internal Server Error", body: "oops" },
        },
      ];

      for (const { label, thrown, expected } of cases) {
        it(`update経路: ${label}`, async () => {
          fetchSpy.mockRejectedValueOnce(thrown());

          const { el, core, shellWarnings, cleanup } = createRemoteAi();
          document.body.appendChild(el);
          await settle();

          core.provider = "openai";
          el.setAttribute("model", "gpt-4o");
          el.stream = false;
          el.prompt = "Hi";

          await expect(el.send()).resolves.toBeNull();
          await settle();

          expect(el.error).not.toBeInstanceOf(Error);
          expect(el.error).toStrictEqual(expected);
          expect(el.loading).toBe(false);
          expect(el.messages).toEqual([]);
          noDroppedValues(shellWarnings);

          cleanup();
        });

        it(`sync経路: ${label}`, async () => {
          fetchSpy.mockRejectedValueOnce(thrown());

          const { el, core, shellWarnings, connect, cleanup } = createRemoteAi({ deferConnect: true });
          core.provider = "openai";
          await core.send("Hi", { model: "gpt-4o", stream: false });

          connect();
          document.body.appendChild(el);
          await settle();

          expect(el.error).toStrictEqual(expected);
          noDroppedValues(shellWarnings);

          cleanup();
        });
      }
    });

    describe("undefined値の任意フィールド（A3）", () => {
      it("messagesセッターの明示的undefinedフィールドは省いて送られ、サーバーに反映される", async () => {
        const { el, core, clientSent, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        await settle();

        el.messages = [
          {
            role: "user",
            content: [{ type: "image", url: "https://example.com/a.png", mediaType: undefined }],
            toolCallId: undefined,
          },
          { role: "assistant", content: "seen", toolCalls: undefined, finishReason: undefined },
        ];
        await settle();

        const expected = [
          { role: "user", content: [{ type: "image", url: "https://example.com/a.png" }] },
          { role: "assistant", content: "seen" },
        ];
        const set = clientSent.find(m => m.type === "set" && m.name === "messages");
        expect(set && "value" in set ? set.value : undefined).toEqual(expected);
        expect(core.messages).toStrictEqual(expected);
        expect(el.messages).toStrictEqual(expected);
        expect(el.error).toBeNull();

        cleanup();
      });

      it("prompt parts / tools / responseSchema の明示的undefinedキーは省いてsendが成功する", async () => {
        fetchSpy
          .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "tools ok" } }] }))
          .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "{}" } }] }));

        const { el, core, clientSent, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        await settle();

        core.provider = "openai";
        el.setAttribute("model", "gpt-4o");
        el.stream = false;
        el.prompt = [
          { type: "text", text: "describe" },
          { type: "image", url: "https://example.com/a.png", mediaType: undefined },
        ];
        el.tools = [{
          name: "lookup",
          description: "d",
          parameters: { type: "object", properties: { q: { type: "string", description: undefined } } },
        }];

        await expect(el.send()).resolves.toBe("tools ok");
        const [prompt, options] = sentSendArgs(clientSent) as [unknown, Record<string, unknown>];
        expect(prompt).toEqual([
          { type: "text", text: "describe" },
          { type: "image", url: "https://example.com/a.png" },
        ]);
        expect(options.tools).toEqual([
          { name: "lookup", description: "d", parameters: { type: "object", properties: { q: { type: "string" } } } },
        ]);

        el.tools = null;
        el.prompt = "structured";
        el.responseSchema = { type: "object", properties: { a: { type: "string", format: undefined } } };
        await expect(el.send()).resolves.toBe("{}");
        expect((sentSendArgs(clientSent)[1] as Record<string, unknown>).responseSchema).toEqual({
          type: "object", properties: { a: { type: "string" } },
        });

        cleanup();
      });

      it("JSONで表せない値（Date等）は送信前にWC_BINDABLE_INVALID_JSON_VALUEでrejectされる", async () => {
        const { el, core, clientSent, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        await settle();

        core.provider = "openai";
        el.setAttribute("model", "gpt-4o");
        el.prompt = "Hi";
        el.responseSchema = { type: "object", default: new Date(0) };

        const sentBefore = clientSent.length;
        const error = await el.send().then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as { code?: string }).code).toBe("WC_BINDABLE_INVALID_JSON_VALUE");
        expect((error as Error).message).toMatch(/responseSchema\.default is Date/);
        // 何も送られず、transport errorとしても扱われない
        expect(clientSent.slice(sentBefore).some(m => m.type === "cmd")).toBe(false);
        expect(el.error).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();

        cleanup();
      });

      it("サーバー側でundefined入りの履歴をcore.messagesに入れてもupdate/syncでクライアントに届く", async () => {
        const history = [
          {
            role: "user" as const,
            content: [{ type: "image" as const, url: "https://example.com/a.png", mediaType: undefined }],
            providerHints: { anthropic: { cacheControl: { type: "ephemeral", ttl: undefined } } },
          },
        ];
        const normalized = [{
          role: "user",
          content: [{ type: "image", url: "https://example.com/a.png" }],
          providerHints: { anthropic: { cacheControl: { type: "ephemeral" } } },
        }];

        // update 経路
        const live = createRemoteAi();
        document.body.appendChild(live.el);
        await settle();
        live.core.messages = history;
        await settle();
        expect(live.el.messages).toStrictEqual(normalized);
        noDroppedValues(live.shellWarnings);
        live.cleanup();

        // sync 経路
        const late = createRemoteAi({ deferConnect: true });
        late.core.messages = history;
        late.connect();
        document.body.appendChild(late.el);
        await settle();
        expect(late.el.messages).toStrictEqual(normalized);
        noDroppedValues(late.shellWarnings);
        late.cleanup();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Calls issued before the initial sync response (pre-sync)
  // -----------------------------------------------------------------------
  // SPEC-extensions.md § Pre-sync call state machine: setWithAck / invoke
  // issued before the first sync response MUST be queued and replayed in
  // caller order once that response has been processed. `<ai-agent>` issues
  // such calls whenever it is used right after connecting: a `provider`
  // attribute ack, `el.messages = [...]`, `send()`, `abort()`.
  describe("sync応答前の操作（pre-sync queue）", () => {
    it("接続直後のprovider / messages / sendはsync応答の処理後に呼び出し順で送られ、結果が一貫する", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: "Answer" } }],
      }));

      const { el, core, clientSent, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      // Everything below runs before the sync response can arrive.
      el.setAttribute("provider", "openai");
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.messages = [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ];
      el.prompt = "Follow-up";
      const result = el.send();

      // Nothing but the proxy's own sync request is on the wire yet.
      expect(wireKinds(clientSent)).toEqual(["sync"]);

      await expect(result).resolves.toBe("Answer");
      await settle();

      expect(wireKinds(clientSent)).toEqual(["sync", "set:provider", "set:messages", "cmd:send"]);
      // The send ran on a Core that already had the provider and the history.
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.messages).toEqual([
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Follow-up" },
      ]);
      const expected = [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Follow-up" },
        { role: "assistant", content: "Answer" },
      ];
      expect(el.messages).toEqual(expected);
      expect(core.messages).toEqual(expected);
      expect(el.content).toBe("Answer");
      expect(el.loading).toBe(false);
      expect(el.error).toBeNull();

      cleanup();
    });

    it("sync応答前に要素が外されたら、sendもabortもサーバーに届かずLLMへのリクエストは発行されない", async () => {
      hangingFetchUntilAbort();

      const { el, core, clientSent, cleanup } = createRemoteAi();
      core.provider = "openai"; // the server decides the provider
      document.body.appendChild(el);
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      const result = el.send();
      el.remove(); // e.g. an SPA route change right after triggering a send

      await expect(result).resolves.toBeNull();
      await settle();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(wireKinds(clientSent)).toEqual(["sync"]);
      expect(core.messages).toEqual([]);
      expect((el.error as { code?: string } | null)?.code).toBe("WC_BINDABLE_DISPOSED");
      expect(el.loading).toBe(false);

      cleanup();
    });

    it("サーバーのdeclaration protocolが異なる場合、sync前に出したmessages / sendはサーバーで実行されない", async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        choices: [{ message: { content: "must not run" } }],
      }));

      const { el, core, clientSent, cleanup } = createRemoteAi({
        rewriteServerMessage: (msg) => (msg.type === "sync" && msg.declarationFingerprint
          ? { ...msg, declarationFingerprint: { ...msg.declarationFingerprint, protocol: "wc-bindable-2" } }
          : msg),
      });
      core.provider = "openai";
      document.body.appendChild(el);
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.messages = [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ];
      el.prompt = "Hi";

      const error = await el.send().then(() => null, (e: unknown) => e);
      await settle();

      expect((error as { code?: string } | null)?.code).toBe("WC_BINDABLE_PROTOCOL_ERROR");
      expect((el.error as { code?: string } | null)?.code).toBe("WC_BINDABLE_PROTOCOL_ERROR");
      // The client reported failure, so the server must not have acted.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(core.messages).toEqual([]);
      expect(wireKinds(clientSent)).toEqual(["sync"]);

      cleanup();
    });

    it("setAckを広告しないサーバーには、sync前のprovider変更を送らずWC_BINDABLE_SET_ACK_UNSUPPORTEDで拒否する", async () => {
      const { el, core, clientSent, cleanup } = createRemoteAi({
        rewriteServerMessage: (msg) => (msg.type === "sync"
          ? { ...msg, capabilities: { ...msg.capabilities, setAck: false } }
          : msg),
      });
      core.provider = "openai";
      document.body.appendChild(el);
      el.setAttribute("provider", "anthropic");
      await settle();

      // No id-bearing set reached a server that cannot acknowledge it
      // (CONFORMANCE.md vector 10), so the server's provider is what the
      // client says it is: unchanged.
      expect(clientSent.some(m => m.type === "set")).toBe(false);
      expect(core.provider).toBeInstanceOf(OpenAiProvider);
      expect((el.error as { code?: string } | null)?.code).toBe("WC_BINDABLE_SET_ACK_UNSUPPORTED");

      // send() refuses instead of running on the server's previous provider.
      el.setAttribute("model", "claude-sonnet-4-20250514");
      el.prompt = "Hi";
      await expect(el.send()).rejects.toMatchObject({ code: "WC_BINDABLE_SET_ACK_UNSUPPORTED" });
      expect(fetchSpy).not.toHaveBeenCalled();

      cleanup();
    });

    it("sync応答前のsend → abortは呼び出し順のまま送られ、サーバー側の推論が中断される", async () => {
      hangingFetchUntilAbort();

      const { el, core, clientSent, cleanup } = createRemoteAi();
      core.provider = "openai";
      document.body.appendChild(el);
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      const result = el.send();
      el.abort();

      await expect(result).resolves.toBeNull();
      await settle();

      expect(wireKinds(clientSent)).toEqual(["sync", "cmd:send", "cmd:abort"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(el.loading).toBe(false);
      expect(el.messages).toEqual([]);
      expect(core.messages).toEqual([]);
      expect(el.error).toBeNull();

      cleanup();
    });

    it("サーバーが応答しない間、send（timeoutMs: 0）は保留され続け、要素を外すとWC_BINDABLE_DISPOSEDでnullに決着する", async () => {
      fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));

      const { el, shell, cleanup } = createRemoteAi();
      shell.dispose(); // the server never answers anything, sync included
      document.body.appendChild(el);
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      let settled = false;
      const result = el.send().finally(() => { settled = true; });

      await settle();
      expect(settled).toBe(false);

      el.remove();
      await expect(result).resolves.toBeNull();
      expect((el.error as { code?: string } | null)?.code).toBe("WC_BINDABLE_DISPOSED");
      expect(el.loading).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();

      cleanup();
    });

    it("サーバーが応答しないまま既定の30秒が過ぎると、providerのackはTimeoutErrorになりsendは拒否される", async () => {
      vi.useFakeTimers();
      try {
        const { el, shell, cleanup } = createRemoteAi();
        shell.dispose();
        document.body.appendChild(el);
        el.setAttribute("provider", "openai");

        await vi.advanceTimersByTimeAsync(29_000);
        expect(el.error).toBeNull();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(el.error).toBeInstanceOf(Error);
        expect(el.error).toMatchObject({ name: "TimeoutError" });
        el.setAttribute("model", "gpt-4o");
        el.prompt = "Hi";
        await expect(el.send()).rejects.toMatchObject({ name: "TimeoutError" });

        cleanup();
      } finally {
        vi.useRealTimers();
      }
    });

    it("config.remote.preSyncBehavior: \"eager\" で従来の即時送信に戻せる（互換サーバーなら結果は同じ）", async () => {
      setConfig({ remote: { preSyncBehavior: "eager" } });
      try {
        fetchSpy.mockResolvedValueOnce(jsonResponse({
          choices: [{ message: { content: "Answer" } }],
        }));

        const { el, core, clientSent, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        el.setAttribute("provider", "openai");
        el.setAttribute("model", "gpt-4o");
        el.stream = false;
        el.prompt = "Hi";
        const result = el.send();

        // Written immediately, behind the proxy's own sync request.
        expect(wireKinds(clientSent)).toEqual(["sync", "set:provider"]);

        await expect(result).resolves.toBe("Answer");
        await settle();
        expect(wireKinds(clientSent)).toEqual(["sync", "set:provider", "cmd:send"]);
        expect(core.messages).toEqual([
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Answer" },
        ]);
        expect(el.messages).toEqual(core.messages);
        expect(el.error).toBeNull();

        cleanup();
      } finally {
        resetConfig();
      }
    });
  });

  // -----------------------------------------------------------------------
  // abort() while send() still waits for the `provider` acknowledgement
  // -----------------------------------------------------------------------
  // A remote send() waits for an in-flight `provider` setWithAck before it
  // invokes the server's `send`. An abort() in that window used to put the
  // `abort` command on the wire ahead of the `send` (a no-op on an idle
  // server), and the `send` then ran normally.
  describe("providerのack待ち中のabort()", () => {
    function answerFetch(content: string): void {
      fetchSpy.mockResolvedValue(jsonResponse({ choices: [{ message: { content } }] }));
    }

    for (const timing of ["sync後", "sync前"] as const) {
      it(`${timing}: ack待ちのsendはサーバーに送られず、ローカルのabortと同じくnullに決着する`, async () => {
        answerFetch("must not run");

        const { el, core, clientSent, cleanup } = createRemoteAi();
        document.body.appendChild(el);
        if (timing === "sync後") await settle();
        el.setAttribute("provider", "openai");
        el.setAttribute("model", "gpt-4o");
        el.stream = false;
        el.prompt = "Hi";
        const result = el.send(); // waits for the provider ack
        el.abort();

        await expect(result).resolves.toBeNull();
        await settle();

        expect(wireKinds(clientSent)).toEqual(["sync", "set:provider", "cmd:abort"]);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(core.provider).toBeInstanceOf(OpenAiProvider);
        expect(core.messages).toEqual([]);
        expect(el.messages).toEqual([]);
        expect(el.loading).toBe(false);
        expect(el.error).toBeNull();

        cleanup();
      });
    }

    it("ackが返らなくてもabort()の時点でnullに決着する", async () => {
      const { el, shell, clientSent, cleanup } = createRemoteAi();
      shell.dispose(); // the server never answers, sync included
      document.body.appendChild(el);
      el.setAttribute("provider", "openai");
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      let settled = false;
      const result = el.send().finally(() => { settled = true; });

      await settle();
      expect(settled).toBe(false);

      el.abort();
      await flush();
      expect(settled).toBe(true);
      await expect(result).resolves.toBeNull();
      expect(wireKinds(clientSent)).toEqual(["sync"]);
      expect(fetchSpy).not.toHaveBeenCalled();

      cleanup();
    });

    it("abort()直後の次のsendは中断されず、それだけがサーバーで実行される", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "Second answer" } }] }));

      const { el, core, clientSent, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();
      el.setAttribute("provider", "openai");
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "First";
      const first = el.send();
      el.abort();
      el.prompt = "Second";
      const second = el.send(); // waits for the same provider ack

      await expect(first).resolves.toBeNull();
      await expect(second).resolves.toBe("Second answer");
      await settle();

      expect(wireKinds(clientSent)).toEqual(["sync", "set:provider", "cmd:abort", "cmd:send"]);
      expect(sentSendArgs(clientSent)[0]).toBe("Second");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(core.messages).toEqual([
        { role: "user", content: "Second" },
        { role: "assistant", content: "Second answer" },
      ]);
      expect(el.messages).toEqual(core.messages);
      expect(el.error).toBeNull();

      cleanup();
    });

    it("abort()直後にack待ちのないsendを呼んでも中断されない", async () => {
      answerFetch("After abort");

      const { el, core, clientSent, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();
      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Hi";
      el.abort();

      await expect(el.send()).resolves.toBe("After abort");
      expect(wireKinds(clientSent)).toEqual(["sync", "cmd:abort", "cmd:send"]);

      cleanup();
    });

    it("invoke済みのsendは従来どおりabortコマンドで中断され、ack待ちのsendは送られない", async () => {
      hangingFetchUntilAbort();

      const { el, core, clientSent, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();
      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.stream = false;
      el.prompt = "Running";
      const running = el.send(); // invoked right away: no provider ack pending
      await settle();
      expect(el.loading).toBe(true);

      el.setAttribute("provider", "openai");
      el.prompt = "Waiting";
      const waiting = el.send(); // waits for the provider ack
      el.abort();

      await expect(running).resolves.toBeNull();
      await expect(waiting).resolves.toBeNull();
      await settle();

      expect(wireKinds(clientSent)).toEqual(["sync", "cmd:send", "set:provider", "cmd:abort"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(core.messages).toEqual([]);
      expect(el.loading).toBe(false);
      expect(el.error).toBeNull();

      cleanup();
    });

    it("ack待ち中にabort()し、そのackが失敗してもsendはnullに決着し、失敗はel.errorに残る", async () => {
      const { el, clientSent, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();
      el.setAttribute("provider", "no-such-provider");
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      const result = el.send();
      el.abort();

      await expect(result).resolves.toBeNull();
      await settle();
      expect((el.error as Error).message).toContain('Unknown provider: "no-such-provider"');
      expect(clientSent.some(m => m.type === "cmd" && m.name === "send")).toBe(false);
      // The provider failure still blocks the next send().
      await expect(el.send()).rejects.toThrow('Unknown provider: "no-such-provider"');

      cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Transport failures are recognised by error.code (0.10 coded errors)
  // -----------------------------------------------------------------------
  describe("transport errorのerror.code判定", () => {
    it("send中にtransportがcloseするとWC_BINDABLE_TERMINAL_FAILUREでnullに決着しloadingが戻る", async () => {
      hangingFetchUntilAbort();

      const { el, core, closeTransport, cleanup } = createRemoteAi();
      document.body.appendChild(el);
      await settle();
      core.provider = "openai";
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      const result = el.send();
      await settle();
      expect(el.loading).toBe(true);

      closeTransport();

      await expect(result).resolves.toBeNull();
      expect((el.error as { code?: string } | null)?.code).toBe("WC_BINDABLE_TERMINAL_FAILURE");
      expect(el.loading).toBe(false);

      cleanup();
    });

    it("declaration protocol不一致の後のsendはWC_BINDABLE_TERMINAL_FAILUREのtransport errorとしてnullに決着する", async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "must not run" } }] }));

      const { el, core, clientSent, cleanup } = createRemoteAi({
        rewriteServerMessage: (msg) => (msg.type === "sync" && msg.declarationFingerprint
          ? { ...msg, declarationFingerprint: { ...msg.declarationFingerprint, protocol: "wc-bindable-2" } }
          : msg),
      });
      core.provider = "openai";
      document.body.appendChild(el);
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";

      // The call caught by the mismatch itself carries the trigger code and
      // is re-thrown (a client/server incompatibility, not a transport glitch).
      await expect(el.send()).rejects.toMatchObject({ code: "WC_BINDABLE_PROTOCOL_ERROR" });
      expect(el.error).toBeNull();

      // Later calls find the proxy in its terminal state.
      await expect(el.send()).resolves.toBeNull();
      expect((el.error as { code?: string } | null)?.code).toBe("WC_BINDABLE_TERMINAL_FAILURE");
      expect((el.error as Error).message).toBe("RemoteCoreProxy: transport in terminal state");
      expect(el.loading).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(wireKinds(clientSent)).toEqual(["sync"]);

      cleanup();
    });

    it("pre-sync queueが満杯のときのsendはWC_BINDABLE_PRE_SYNC_QUEUE_FULLのtransport errorとしてnullに決着する", async () => {
      const { el, shell, clientSent, cleanup } = createRemoteAi();
      shell.dispose(); // the server never answers the sync
      document.body.appendChild(el);
      // 1 024 (the library's maxPreSyncQueue default) queued abort commands.
      for (let i = 0; i < 1024; i++) el.abort();
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";

      await expect(el.send()).resolves.toBeNull();
      expect((el.error as { code?: string } | null)?.code).toBe("WC_BINDABLE_PRE_SYNC_QUEUE_FULL");
      expect(el.loading).toBe(false);
      expect(wireKinds(clientSent)).toEqual(["sync"]);

      cleanup();
    });
  });
});
