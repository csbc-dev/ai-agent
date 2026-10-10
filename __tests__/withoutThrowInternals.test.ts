/**
 * `withoutThrowInternals` (`@csbc-dev/ai-agent/server`) against the real
 * `@wc-bindable/remote` 0.10 `RemoteShellProxy`, whose `throw` replies carry
 * the server's `stack` and `cause` chain (wc-bindable-protocol#38).
 *
 * Every frame is JSON round-tripped at the boundary like a WebSocket, and
 * `wire` records the frames as they leave the server — after the helper, so
 * what a browser would actually receive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RemoteShellProxy, createRemoteCoreProxy } from "@wc-bindable/remote";
import type {
  ClientTransport, ServerTransport, ClientMessage, ServerMessage, RemoteSerializedError,
} from "@wc-bindable/remote";
import { AiCore, withoutThrowInternals } from "../src/server";
import type { AiContentPart, AiRequestOptions, IAiProvider } from "../src/server";
import { Ai } from "../src/components/Ai";
import { registerComponents } from "../src/registerComponents";

registerComponents();

const TOP_FRAME = "serverTopFrame_5eed";
const CAUSE_FRAME = "serverCauseFrame_5eed";
/** Strings only the server may see. None of them may appear on the wire. */
const SERVER_ONLY = [TOP_FRAME, CAUSE_FRAME, "/srv/app", "ECONNREFUSED", "10.0.0.9"];

/**
 * Like an upstream failure in Node: the thrown Error carries a `code` and a
 * `cause` that is another Error, each with a server stack.
 */
function serverError(message = "quota check failed"): Error & { code: string } {
  const socket = Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:443"), { code: "ECONNREFUSED" });
  socket.stack = `Error: connect ECONNREFUSED 10.0.0.9:443\n    at ${CAUSE_FRAME} (/srv/app/net.js:1:1)`;
  const error = Object.assign(new Error(message), { code: "E_QUOTA" });
  error.stack = `Error: ${message}\n    at ${TOP_FRAME} (/srv/app/quota.js:1:1)`;
  Object.defineProperty(error, "cause", { value: socket, writable: true, enumerable: false, configurable: true });
  return error;
}

/** A server Core whose `send()` / `provider` setter can be made to fail. */
class GuardedCore extends AiCore {
  sendFailure: { thrown: unknown; async: boolean } | null = null;
  providerFailure: unknown = null;

  override send(prompt: string | AiContentPart[], options: AiRequestOptions): Promise<string | null> {
    const failure = this.sendFailure;
    if (failure) {
      if (failure.async) return Promise.reject(failure.thrown);
      throw failure.thrown;
    }
    return super.send(prompt, options);
  }

  override set provider(value: IAiProvider | string | null) {
    if (this.providerFailure !== null) throw this.providerFailure;
    super.provider = value;
  }
  override get provider(): IAiProvider | null {
    return super.provider;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

function createWire(): {
  client: ClientTransport;
  server: ServerTransport;
  wire: ServerMessage[];
} {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;
  const wire: ServerMessage[] = [];
  const roundTrip = <T>(msg: T): T => JSON.parse(JSON.stringify(msg));
  const client: ClientTransport = {
    send: (msg) => {
      const decoded = roundTrip(msg);
      Promise.resolve().then(() => serverHandler?.(decoded));
    },
    onMessage: (handler) => { clientHandler = handler; },
  };
  const server: ServerTransport = {
    send: (msg) => {
      const decoded = roundTrip(msg);
      wire.push(decoded);
      Promise.resolve().then(() => clientHandler?.(decoded));
    },
    onMessage: (handler) => { serverHandler = handler; },
  };
  return { client, server, wire };
}

/**
 * Server Core + shell + a client-side RemoteCoreProxy. `wrap: false` hands
 * the shell the raw transport, which is what a server does today without
 * the helper.
 */
async function setup(options: { wrap?: boolean; onThrow?: (error: unknown) => void } = {}) {
  const { wrap = true, onThrow } = options;
  const core = new GuardedCore();
  const { client, server, wire } = createWire();
  const shellLogs: string[] = [];
  const shell = new RemoteShellProxy(core, wrap ? withoutThrowInternals(server, { onThrow }) : server, {
    logger: {
      warn: (msg: string) => { shellLogs.push(msg); },
      error: (msg: string) => { shellLogs.push(msg); },
    },
  });
  const proxy = createRemoteCoreProxy(AiCore.wcBindable, client);
  await settle();
  return { core, shell, proxy, wire, shellLogs };
}

function throwFrames(wire: ServerMessage[]): Extract<ServerMessage, { type: "throw" }>[] {
  return wire.filter((m): m is Extract<ServerMessage, { type: "throw" }> => m.type === "throw");
}

async function rejectionOf(p: Promise<unknown>): Promise<Error & { code?: string; cause?: unknown }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; cause?: unknown };
  }
  throw new Error("expected a rejection");
}

describe("withoutThrowInternals（throw応答からサーバのstack / causeを外す）", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // If this starts failing, @wc-bindable/remote no longer sends `stack` /
  // `cause` (wc-bindable-protocol#38 fixed) and the helper can be retired.
  it("helperを通さないと、0.10のRemoteShellProxyはcommand / set-ackのthrow応答にサーバのstackとcauseを載せる（現状の確認）", async () => {
    const { core, shell, proxy, wire } = await setup({ wrap: false });
    core.sendFailure = { thrown: serverError(), async: false };
    core.providerFailure = serverError("provider refused");

    const sendErr = await rejectionOf(proxy.invoke("send", "Hi", { model: "gpt-4o" }));
    const setErr = await rejectionOf(proxy.setWithAck("provider", "openai"));

    const [cmdFrame, setFrame] = throwFrames(wire);
    for (const frame of [cmdFrame, setFrame]) {
      const error = frame.error as RemoteSerializedError & { cause: RemoteSerializedError };
      expect(error.stack).toContain(TOP_FRAME);
      expect(error.cause.stack).toContain(CAUSE_FRAME);
      expect(error.cause.message).toBe("connect ECONNREFUSED 10.0.0.9:443");
    }
    // …and the client's rejection takes the server's stack as its own.
    expect(sendErr.stack).toContain(TOP_FRAME);
    expect(setErr.stack).toContain(TOP_FRAME);

    shell.dispose();
  });

  describe("RemoteShellProxyを通したthrow応答", () => {
    it.each([
      ["同期throw", false],
      ["reject", true],
    ])("commandの%s: stackとcauseチェーンは外れ、name / message / codeは届く", async (_label, async) => {
      const { core, shell, proxy, wire, shellLogs } = await setup();
      core.sendFailure = { thrown: serverError(), async };

      const err = await rejectionOf(proxy.invoke("send", "Hi", { model: "gpt-4o" }));

      expect(throwFrames(wire)).toHaveLength(1);
      expect(throwFrames(wire)[0].error).toStrictEqual({ name: "Error", message: "quota check failed", code: "E_QUOTA" });
      for (const marker of SERVER_ONLY) expect(JSON.stringify(wire)).not.toContain(marker);
      // The browser's rejection: name / message / code as thrown, its own stack.
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({ name: "Error", message: "quota check failed", code: "E_QUOTA" });
      expect(err.stack).not.toContain(TOP_FRAME);
      expect(err.cause).toStrictEqual({ name: "Error", message: "quota check failed", code: "E_QUOTA" });
      // The thrown error itself is untouched.
      expect((core.sendFailure.thrown as Error).stack).toContain(TOP_FRAME);
      expect(shellLogs).toEqual([]);

      shell.dispose();
    });

    it("AiCore.send()の検証エラー（実物）は{ name, message }だけで届く", async () => {
      const { shell, proxy, wire } = await setup();

      // No provider on the server Core: AiCore.send() throws before dispatch.
      const err = await rejectionOf(proxy.invoke("send", "Hi", { model: "gpt-4o" }));

      expect(err.message).toContain("provider is required");
      const error = throwFrames(wire)[0].error as Record<string, unknown>;
      expect(Object.keys(error).sort()).toEqual(["message", "name"]);
      expect(error).toStrictEqual({ name: "Error", message: err.message });

      shell.dispose();
    });

    it("set-ackの失敗（providerの代入、messagesの代入）も{ name, message }だけで届く", async () => {
      const { shell, proxy, wire } = await setup();

      // Real AiCore setters: an unknown provider name, and a history the
      // server-side validateMessages refuses (the client proxy only checks
      // that it is JSON).
      const providerErr = await rejectionOf(proxy.setWithAck("provider", "no-such-provider"));
      const messagesErr = await rejectionOf(proxy.setWithAck("messages", [{ role: "narrator", content: "x" }]));

      expect(providerErr.message).toContain("Unknown provider");
      expect(messagesErr.message).toContain("narrator");
      const frames = throwFrames(wire);
      expect(frames).toHaveLength(2);
      expect(frames.map((f) => f.error)).toStrictEqual([
        { name: "Error", message: providerErr.message },
        { name: "Error", message: messagesErr.message },
      ]);

      shell.dispose();
    });

    it("Errorでない値のthrow: envelopeのcause（thrownした値そのもの）も外れる", async () => {
      const { core, shell, proxy, wire } = await setup();
      core.sendFailure = { thrown: { reason: "quota", host: "10.0.0.9" }, async: true };

      const err = await rejectionOf(proxy.invoke("send", "Hi", { model: "gpt-4o" }));

      // RemoteShellProxy's canonical mapping for a non-Error throw.
      expect(throwFrames(wire)[0].error).toStrictEqual({ name: "NonErrorThrow", message: "[object Object]" });
      expect(JSON.stringify(wire)).not.toContain("10.0.0.9");
      expect(err.name).toBe("NonErrorThrow");

      shell.dispose();
    });

    it("onThrowには外す前のenvelope（stack / cause入り）が渡り、そのenvelopeは書き換えない", async () => {
      const seen: unknown[] = [];
      const { core, shell, proxy, wire } = await setup({ onThrow: (error) => { seen.push(error); } });
      core.sendFailure = { thrown: serverError(), async: false };
      core.providerFailure = serverError("provider refused");

      await rejectionOf(proxy.invoke("send", "Hi", { model: "gpt-4o" }));
      await rejectionOf(proxy.setWithAck("provider", "openai"));

      expect(seen).toHaveLength(2);
      const [cmdError, setError] = seen as Array<RemoteSerializedError & { cause: RemoteSerializedError }>;
      expect(cmdError).toMatchObject({ name: "Error", message: "quota check failed", code: "E_QUOTA" });
      expect(setError).toMatchObject({ name: "Error", message: "provider refused", code: "E_QUOTA" });
      for (const error of [cmdError, setError]) {
        // Still the full envelope after the reply went out.
        expect(error.stack).toContain(TOP_FRAME);
        expect(error.cause).toMatchObject({ name: "Error", message: "connect ECONNREFUSED 10.0.0.9:443", code: "ECONNREFUSED" });
        expect(error.cause.stack).toContain(CAUSE_FRAME);
      }
      for (const marker of SERVER_ONLY) expect(JSON.stringify(wire)).not.toContain(marker);

      shell.dispose();
    });

    it("onThrowが例外を投げても応答は届き、shellのloggerにも何も出ない", async () => {
      const onThrow = vi.fn(() => { throw new Error("log sink down"); });
      const { core, shell, proxy, wire, shellLogs } = await setup({ onThrow });
      core.sendFailure = { thrown: serverError(), async: false };

      const err = await rejectionOf(proxy.invoke("send", "Hi", { model: "gpt-4o" }));

      expect(onThrow).toHaveBeenCalledTimes(1);
      expect(err).toMatchObject({ name: "Error", message: "quota check failed", code: "E_QUOTA" });
      expect(throwFrames(wire)[0].error).toStrictEqual({ name: "Error", message: "quota check failed", code: "E_QUOTA" });
      expect(shellLogs).toEqual([]);

      shell.dispose();
    });

    it("throw以外（sync / update / return）はそのまま届き、send()は通常どおり動く", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: null,
        json: () => Promise.resolve({ choices: [{ message: { content: "Hello!" } }] }),
        text: () => Promise.resolve(""),
      } as unknown as Response);
      const onThrow = vi.fn();
      const { core, shell, proxy, wire } = await setup({ onThrow });
      core.provider = "openai";

      await expect(proxy.invoke("send", "Hi", { model: "gpt-4o", stream: false })).resolves.toBe("Hello!");
      await settle();

      expect(wire.some((m) => m.type === "sync")).toBe(true);
      expect(wire.some((m) => m.type === "update" && m.name === "content" && m.value === "Hello!")).toBe(true);
      expect(wire.some((m) => m.type === "return" && m.value === "Hello!")).toBe(true);
      expect(throwFrames(wire)).toEqual([]);
      expect(onThrow).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      shell.dispose();
    });
  });

  describe("transportの包み方", () => {
    function innerTransport(withLifecycle: boolean) {
      const sent: ServerMessage[] = [];
      const inner: ServerTransport = {
        send: vi.fn((msg: ServerMessage) => { sent.push(msg); }),
        onMessage: vi.fn(),
      };
      if (withLifecycle) {
        inner.onClose = vi.fn();
        inner.dispose = vi.fn();
      }
      return { inner, sent };
    }

    it("throw以外のmessageは同じオブジェクトのまま渡す", () => {
      const { inner, sent } = innerTransport(false);
      const wrapped = withoutThrowInternals(inner);
      const messages: ServerMessage[] = [
        { type: "sync", values: { error: { name: "Error", message: "m", stack: "kept: not a throw" } } },
        { type: "update", name: "error", value: { name: "Error", message: "m" } },
        { type: "return", id: "1", value: { stack: "a value, not an error" } },
      ];
      for (const m of messages) wrapped.send(m);
      expect(sent).toHaveLength(3);
      sent.forEach((m, i) => expect(m).toBe(messages[i]));
    });

    it("errorのstack / causeだけを外したコピーを送る（他のフィールドは残す）", () => {
      const { inner, sent } = innerTransport(false);
      const onThrow = vi.fn();
      const wrapped = withoutThrowInternals(inner, { onThrow });
      const error = { name: "E", message: "m", code: "E_X", stack: "s", cause: { stack: "c" }, extra: 1 };
      const message: ServerMessage = { type: "throw", id: "7", error };

      wrapped.send(message);

      expect(sent).toStrictEqual([{ type: "throw", id: "7", error: { name: "E", message: "m", code: "E_X", extra: 1 } }]);
      expect(onThrow).toHaveBeenCalledWith(error);
      // Neither the message nor its error is modified.
      expect(message.error).toBe(error);
      expect(error).toStrictEqual({ name: "E", message: "m", code: "E_X", stack: "s", cause: { stack: "c" }, extra: 1 });
    });

    it.each([
      ["文字列", "boom"],
      ["null", null],
      ["配列", [{ stack: "payload" }]],
    ])("objectでないerror（%s）はそのまま送り、onThrowにも渡す", (_label, error) => {
      const { inner, sent } = innerTransport(false);
      const onThrow = vi.fn();
      withoutThrowInternals(inner, { onThrow }).send({ type: "throw", id: "1", error });
      expect(sent).toStrictEqual([{ type: "throw", id: "1", error }]);
      expect(onThrow).toHaveBeenCalledWith(error);
    });

    it("onMessage / onClose / disposeは包んだtransportへ転送する", () => {
      const { inner } = innerTransport(true);
      const wrapped = withoutThrowInternals(inner);
      const onMessage = vi.fn();
      const onClose = vi.fn();

      wrapped.onMessage(onMessage);
      wrapped.onClose!(onClose);
      wrapped.dispose!();

      expect(inner.onMessage).toHaveBeenCalledWith(onMessage);
      expect(inner.onClose).toHaveBeenCalledWith(onClose);
      expect(inner.dispose).toHaveBeenCalledTimes(1);
    });

    it("包んだtransportにonClose / disposeが無ければ、包んだ側にも生やさない", () => {
      const { inner } = innerTransport(false);
      const wrapped = withoutThrowInternals(inner);
      expect(wrapped.onClose).toBeUndefined();
      expect(wrapped.dispose).toBeUndefined();
    });

    it("RemoteShellProxyのdispose / 接続断はそのまま元のtransportに届く", () => {
      let closeHandler: (() => void) | null = null;
      const inner: ServerTransport = {
        send: vi.fn(),
        onMessage: vi.fn(),
        onClose: (handler) => { closeHandler = handler; },
        dispose: vi.fn(),
      };
      const shell = new RemoteShellProxy(new AiCore(), withoutThrowInternals(inner));
      // The connection closing disposes the shell, which releases the transport.
      closeHandler!();
      expect(inner.dispose).toHaveBeenCalledTimes(1);
      shell.dispose(); // idempotent
      expect(inner.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("<ai-agent>から見たとき", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
    afterEach(() => { fetchSpy.mockRestore(); });

    function connectElement(core: AiCore, server: ServerTransport, client: ClientTransport) {
      const shell = new RemoteShellProxy(core, server);
      const el = document.createElement("ai-agent") as Ai;
      (el as unknown as { _connectRemote(t: ClientTransport): void })._connectRemote(client);
      document.body.appendChild(el);
      return { el, shell };
    }

    it("send()のrejectとproviderのset-ack失敗（el.error）にサーバのstackが無い", async () => {
      const core = new GuardedCore();
      const { client, server, wire } = createWire();
      const logged: unknown[] = [];
      const { el, shell } = connectElement(core, withoutThrowInternals(server, { onThrow: (e) => logged.push(e) }), client);
      await settle();

      // A server-side refusal of send(): the promise rejects (it is not a
      // transport failure), with the message and code but not the stack.
      core.provider = "openai";
      core.sendFailure = { thrown: serverError(), async: true };
      el.setAttribute("model", "gpt-4o");
      el.prompt = "Hi";
      const sendErr = await rejectionOf(el.send());
      expect(sendErr).toMatchObject({ name: "Error", message: "quota check failed", code: "E_QUOTA" });
      expect(String(sendErr.stack)).not.toContain(TOP_FRAME);

      // A refused provider change surfaces on el.error, and send() then
      // rejects with it.
      core.sendFailure = null;
      core.providerFailure = serverError("provider refused");
      el.provider = "anthropic";
      await settle();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error).toMatchObject({ name: "Error", message: "provider refused" });
      expect(String((el.error as Error).stack)).not.toContain(TOP_FRAME);
      await expect(el.send()).rejects.toThrow("provider refused");

      for (const marker of SERVER_ONLY) expect(JSON.stringify(wire)).not.toContain(marker);
      expect(logged).toHaveLength(2);
      for (const error of logged) expect((error as RemoteSerializedError).stack).toContain(TOP_FRAME);
      expect(fetchSpy).not.toHaveBeenCalled();

      shell.dispose();
    });
  });
});
