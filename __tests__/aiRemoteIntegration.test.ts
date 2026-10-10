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
import { registerComponents } from "../src/registerComponents";

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
function createMockTransportPair(): {
  client: ClientTransport;
  server: ServerTransport;
  clientSent: ClientMessage[];
} {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;
  const clientSent: ClientMessage[] = [];
  const wire = <T>(msg: T): T => JSON.parse(JSON.stringify(msg));

  const client: ClientTransport = {
    send: (msg) => {
      const decoded = wire(msg);
      clientSent.push(decoded);
      if (serverHandler) Promise.resolve().then(() => serverHandler!(wire(msg)));
    },
    onMessage: (handler) => { clientHandler = handler; },
  };

  const server: ServerTransport = {
    send: (msg) => {
      const decoded = wire(msg);
      if (clientHandler) Promise.resolve().then(() => clientHandler!(decoded));
    },
    onMessage: (handler) => { serverHandler = handler; },
  };

  return { client, server, clientSent };
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
function createRemoteAi(options: { deferConnect?: boolean } = {}): {
  el: Ai;
  core: AiCore;
  shell: RemoteShellProxy;
  clientSent: ClientMessage[];
  shellWarnings: string[];
  connect: () => void;
  cleanup: () => void;
} {
  const core = new AiCore();
  const { client, server, clientSent } = createMockTransportPair();
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
});
