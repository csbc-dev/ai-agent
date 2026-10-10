import { config, getRemoteCoreUrl } from "../config.js";
import {
  warnApiKeyInRemoteMode, errorApiKeyDroppedInRemoteMode,
  warnAiPartnerMissing, warnAiClassUnregistered, remoteLogger,
} from "../debug.js";
import type {
  IWcBindable, AiMessage, AiHttpError, AiContentPart, AiTool, AiToolChoice,
} from "../types.js";
import { AiCore, inProcessErrorStack } from "../core/AiCore.js";
import { cloneMessage } from "../core/cloneMessage.js";
import { validateMessages } from "../core/validateMessages.js";
import { narrowError } from "../narrowError.js";
import { AiMessageElement } from "./AiMessage.js";
import { registerAutoTrigger, unregisterAutoTrigger } from "../autoTrigger.js";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
  type ClientTransport,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { omitUndefinedProperties } from "../omitUndefinedProperties.js";

// Errors revived from a Core's frozen AiSerializedError snapshot, keyed by
// that snapshot. Memoizing keeps the element-level value identity-stable:
// `el.error` and every bind() consumer of the element (which reads the event
// through the declaration getter below) observe the very same Error for one
// failure, as they did when the Core stored the Error itself.
const revivedErrors = new WeakMap<object, Error>();

/**
 * `error.code` values (SPEC-extensions.md § Error envelope) under which a
 * rejected remote `send` invocation is a transport failure: the connection,
 * not the call, failed. All four are codes the registry reserves for errors
 * the client proxy builds itself; when one arrives in a server `throw`, the
 * proxy replaces it with `WC_BINDABLE_REMOTE_THROW`, so a server-side error
 * can never pass for a transport failure. See `Ai._isTransportError`.
 */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  // The transport closed, or the proxy is in its terminal state (e.g. after a
  // declaration protocol mismatch, for every call after the one it rejected).
  "WC_BINDABLE_TERMINAL_FAILURE",
  // The proxy was disposed: the element was removed.
  "WC_BINDABLE_DISPOSED",
  // The server did not reply within AckOptions.timeoutMs. Not seen today:
  // send() passes timeoutMs: 0, and 0.10 does not code its timeouts yet.
  "WC_BINDABLE_TIMEOUT",
  // The server has not answered the initial sync and the queue of calls
  // waiting for it is full.
  "WC_BINDABLE_PRE_SYNC_QUEUE_FULL",
]);

/**
 * Resolves once `promise` settles — either way; the outcome is read elsewhere
 * — or `signal` aborts, whichever comes first. Its handlers are registered
 * after any the caller already attached to `promise`, so those run first.
 */
function settledOrAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    const settled = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    promise.then(settled, settled);
  });
}

export class Ai extends HTMLElement {
  static wcBindable: IWcBindable = {
    ...AiCore.wcBindable,
    properties: [
      // `error` carries an element-level getter. AiCore holds non-HTTP
      // failures as JSON-safe AiSerializedError snapshots (required by
      // @wc-bindable/remote >= 0.10), and in local mode it dispatches
      // `ai-agent:error` directly on this element (target injection) with that
      // snapshot as `detail`. The getter revives it so bind() consumers of
      // <ai-agent> keep receiving the same `Error` as `el.error`, in local and
      // remote mode alike. Values that are already an Error / AiHttpError /
      // null (remote-mode and Shell-level dispatches) pass through unchanged.
      // AiCore.wcBindable itself stays getter-free: the server-side
      // RemoteShellProxy builds `update`s from it and must ship the snapshot.
      ...AiCore.wcBindable.properties.map(p => p.name === "error"
        ? { ...p, getter: (event: Event) => Ai._reviveError((event as CustomEvent).detail) }
        : p),
      { name: "trigger", event: "ai-agent:trigger-changed" },
    ],
  };
  static get observedAttributes(): string[] {
    return ["provider"];
  }

  private _core: AiCore | null = null;
  private _proxy: RemoteCoreProxy | null = null;
  private _remoteValues: Record<string, unknown> = {};
  private _unbind: (() => void) | null = null;
  private _ws: WebSocket | null = null;
  private _trigger: boolean = false;
  private _warnedApiKeyLeak: boolean = false;
  private _warnedApiKeyDropped: boolean = false;
  private _prompt: string | AiContentPart[] = "";
  private _tools: AiTool[] | null = null;
  private _toolChoice: AiToolChoice | undefined = undefined;
  private _maxToolRoundtrips: number | undefined = undefined;
  private _responseSchema: Record<string, any> | null = null;
  private _responseSchemaName: string | undefined = undefined;
  private _errorState: AiHttpError | Error | null = null;
  private _hasLocalError: boolean = false;
  private _lastProviderError: Error | null = null;
  private _providerUpdate: Promise<unknown> | null = null;
  // Aborted, then replaced by a fresh controller, by every abort() call. A
  // send() takes the signal that is current when it is called, so abort()
  // cancels exactly the sends issued before it and none issued after it.
  // Removing a remote element replaces it too, without aborting it: the
  // removal settles the sends issued before it (see disconnectedCallback).
  private _sendAbort: AbortController = new AbortController();
  private _autoTriggerRegistered: boolean = false;

  private get _isRemote(): boolean {
    return this._proxy !== null;
  }

  constructor() {
    super();
    if (!config.remote.enableRemote) {
      this._core = new AiCore(this);
    }
  }

  private _initRemote(): void {
    const url = getRemoteCoreUrl();
    if (!url) {
      throw new Error("[@csbc-dev/ai-agent] remote.enableRemote is true but remoteCoreUrl is empty. Set remote.remoteCoreUrl or AI_REMOTE_CORE_URL environment variable.");
    }
    const ws = new WebSocket(url);
    this._ws = ws;

    // Surface async connection failures. A deliberate close from disconnectedCallback
    // nulls out _ws before the event fires, so those are suppressed.
    let opened = false;
    let failed = false;
    ws.addEventListener("open", () => { opened = true; }, { once: true });
    const onFail = () => {
      if (failed) return;
      failed = true;
      if (this._ws !== ws) return;
      this._setErrorState(new Error(
        `[@csbc-dev/ai-agent] WebSocket connection ${opened ? "lost" : "failed"}: ${url}`
      ));
      // The socket may drop outside any active send() — reset busy state so the
      // UI does not stay stuck showing loading/streaming from the last sync.
      this._resetRemoteBusyState();
    };
    ws.addEventListener("error", onFail, { once: true });
    ws.addEventListener("close", onFail, { once: true });

    const transport = new WebSocketClientTransport(ws);
    this._connectRemote(transport);
  }

  /**
   * Reset remote-synced busy state on transport failure so the UI does not
   * stay stuck. `values` is the synced state to reset — by default the
   * current one; disconnectedCallback passes the state it has just detached.
   */
  private _resetRemoteBusyState(values: Record<string, unknown> = this._remoteValues): void {
    if (values.loading) {
      values.loading = false;
      this.dispatchEvent(new CustomEvent("ai-agent:loading-changed", { detail: false, bubbles: true }));
    }
    if (values.streaming) {
      values.streaming = false;
      this.dispatchEvent(new CustomEvent("ai-agent:streaming-changed", { detail: false, bubbles: true }));
    }
  }

  private _setErrorState(error: unknown): void {
    const narrowed = narrowError(error);
    this._errorState = narrowed;
    this._hasLocalError = true;
    this.dispatchEvent(new CustomEvent("ai-agent:error", {
      detail: narrowed,
      bubbles: true,
    }));
  }

  /** Clear only client-side (local) errors; leave server-synced errors untouched. */
  private _clearErrorState(): void {
    if (!this._hasLocalError) return;
    this._hasLocalError = false;
    this._errorState = null;
    this.dispatchEvent(new CustomEvent("ai-agent:error", {
      detail: this.error,
      bubbles: true,
    }));
  }

  private _applyProvider(value: string | null): void {
    if (this._isRemote) {
      // Track the latest in-flight ack so send() can wait for it before
      // gating on _lastProviderError. Stale acks (superseded by a newer
      // _applyProvider call) no longer mutate state.
      const ack = this._proxy!.setWithAck("provider", value || null);
      this._providerUpdate = ack;
      ack.then(
        () => {
          if (this._providerUpdate !== ack) return;
          this._providerUpdate = null;
          this._lastProviderError = null;
          this._clearErrorState();
        },
        (e: unknown) => {
          if (this._providerUpdate !== ack) return;
          this._providerUpdate = null;
          this._lastProviderError = e instanceof Error ? e : new Error(String(e));
          this._setErrorState(e);
        },
      );
    } else if (this._core) {
      try {
        this._core.provider = value || null;
        this._lastProviderError = null;
        this._clearErrorState();
      } catch (e: unknown) {
        // Invalid provider names throw synchronously. Swallow here so setAttribute
        // does not re-throw through attributeChangedCallback, and surface the failure
        // via error state so send() can refuse rather than silently using the
        // previously resolved provider.
        this._lastProviderError = e instanceof Error ? e : new Error(String(e));
        this._setErrorState(e);
      }
    }
  }

  /** @internal — visible for testing */
  private _connectRemote(transport: ClientTransport): void {
    // `logger` routes the proxy's diagnostic warnings (declaration-fingerprint
    // mismatch on client/server version skew, ignored-sync values, the
    // `getterFailures` "keeping the last known value" notice, etc.) through
    // this package's dev-gated channel.
    //
    // `preSyncBehavior` defaults to "queue" (config.remote.preSyncBehavior),
    // overriding the @wc-bindable/remote default, which is still "eager"
    // through 0.10 and documented upstream as non-conformant.
    // SPEC-extensions.md § Pre-sync call state machine says setWithAck /
    // invoke issued before the first `sync` response MUST be queued and
    // replayed in call order only after that response has been processed.
    // `<ai-agent>` issues exactly such calls whenever it is used right after
    // connecting — the `provider` attribute ack, `el.messages = [...]`,
    // `send()`, `abort()` — and with "eager" they reach the server before the
    // client has validated the server at all:
    //   - the element is removed before the sync arrives: the server still
    //     receives the `send` (an LLM request is issued, then aborted),
    //     although the client settled send() as disposed;
    //   - the sync carries another declaration `protocol`: the client rejects
    //     with WC_BINDABLE_PROTOCOL_ERROR, yet the server has already applied
    //     `messages` and run the inference;
    //   - the server does not advertise `setAck`: the `provider` change is
    //     applied server-side while the client rejects it (without an
    //     error.code) and send() refuses.
    // With "queue" nothing but the `sync` request leaves the client until the
    // server is known to be compatible. Against a compatible server the
    // outcome is unchanged (RemoteShellProxy answers in frame order either
    // way). Side effects of the queue: it is bounded by maxPreSyncQueue (1024
    // calls → WC_BINDABLE_PRE_SYNC_QUEUE_FULL, far beyond what an element
    // issues); a queued setWithAck (`provider` / `messages`) still times out
    // after its default 30 s if no sync arrives, and gets a fresh 30 s for
    // the reply once replayed; a queued send() (timeoutMs: 0) waits for the
    // sync just as it would wait for the reply — dispose (element removal) or
    // a transport close settles it as a transport error.
    this._proxy = createRemoteCoreProxy(AiCore.wcBindable, transport, {
      logger: remoteLogger,
      preSyncBehavior: config.remote.preSyncBehavior,
    });

    // Bridge proxy events to this HTMLElement so framework adapters work
    this._unbind = bind(this._proxy, (name, value) => {
      // Revive the server Core's AiSerializedError snapshot back into an Error
      // instance so el.error instanceof Error holds in remote mode just as it
      // does locally (where `get error()` revives the local Core's snapshot).
      if (name === "error") {
        value = Ai._reviveError(value);
        // Preserve local provider error: a pending provider validation failure
        // is still blocking send(), so we must not let a server-side error=null
        // sync make the UI look healthy while send() continues to reject.
        if (!this._lastProviderError) {
          this._errorState = null;
          this._hasLocalError = false;
        }
      }
      // Sanitize server-synced messages before storing: a compromised /
      // misconfigured server should not be able to inject a malformed
      // history shape that the client then exposes through `el.messages`.
      // validateMessages enforces the structural contract; cloneMessage
      // breaks aliasing with the proxy's internal buffer so later in-place
      // mutation by the proxy cannot reach into _remoteValues.
      if (name === "messages") {
        try {
          if (Array.isArray(value)) {
            validateMessages(value as AiMessage[]);
            value = (value as AiMessage[]).map(cloneMessage);
          }
        } catch (e) {
          // Surface the validation failure through the error channel and
          // drop the malformed sync so a downstream `get messages()` does
          // not return a structurally invalid array.
          this._setErrorState(e);
          return;
        }
      }
      this._remoteValues[name] = value;
      // Find the matching event name from the declaration
      const prop = Ai.wcBindable.properties.find(p => p.name === name);
      /* v8 ignore start -- bind callback names always come from declared wcBindable properties */
      if (prop) {
        this.dispatchEvent(new CustomEvent(prop.event, {
          detail: value,
          bubbles: true,
        }));
      }
      /* v8 ignore stop */
    });
  }

  // --- Input attributes ---

  get provider(): string {
    return this.getAttribute("provider") || "";
  }

  set provider(value: string) {
    this.setAttribute("provider", value);
  }

  get model(): string {
    return this.getAttribute("model") || "";
  }

  set model(value: string) {
    this.setAttribute("model", value);
  }

  get baseUrl(): string {
    return this.getAttribute("base-url") || "";
  }

  set baseUrl(value: string) {
    this.setAttribute("base-url", value);
  }

  /**
   * API key passed through the `api-key` attribute.
   * This value is exposed in the DOM, so it is intended for development and prototyping only.
   * In production, point `base-url` at a backend proxy that injects the provider API key server-side.
   */
  get apiKey(): string {
    return this.getAttribute("api-key") || "";
  }

  set apiKey(value: string) {
    this.setAttribute("api-key", value);
  }

  get system(): string {
    return this.getAttribute("system") || "";
  }

  set system(value: string) {
    this.setAttribute("system", value);
  }

  get stream(): boolean {
    return !this.hasAttribute("no-stream");
  }

  set stream(value: boolean) {
    if (value) {
      this.removeAttribute("no-stream");
    } else {
      this.setAttribute("no-stream", "");
    }
  }

  get apiVersion(): string {
    return this.getAttribute("api-version") || "";
  }

  set apiVersion(value: string) {
    this.setAttribute("api-version", value);
  }

  /**
   * OpenAI / Azure / OpenAI-compatible-only knob. Controls whether
   * `stream_options: { include_usage: true }` is emitted in the request body.
   *
   * - `"auto"` (default when attribute absent): include only when `base-url` is unset.
   * - `"always"`: include unconditionally — use with a transparent proxy that
   *   supports the field, otherwise streaming `usage` is silently dropped.
   * - `"never"`: never include — use with OpenAI-compatible servers that 400
   *   on `stream_options`.
   *
   * Invalid values are ignored (treated as `undefined` → "auto").
   */
  get streamOptions(): "auto" | "always" | "never" | undefined {
    const v = this.getAttribute("stream-options");
    if (v === "auto" || v === "always" || v === "never") return v;
    return undefined;
  }

  set streamOptions(value: "auto" | "always" | "never" | undefined) {
    if (value === undefined) {
      this.removeAttribute("stream-options");
    } else {
      this.setAttribute("stream-options", value);
    }
  }

  /**
   * In remote mode, controls whether the client-side `apiKey` / `baseUrl` /
   * `apiVersion` attributes are sent to the server in the `send()` payload.
   *
   * Default: `false` — credentials stay on the client and are not transmitted.
   * The server is expected to hold provider credentials (the canonical
   * Case B1 deployment shape).
   *
   * Set to `true` only when the server is a trusted transparent proxy that
   * needs the per-request key (e.g. a multi-tenant gateway that rotates keys
   * per user). Local mode ignores this flag entirely.
   */
  get forwardCredentials(): boolean {
    return this.hasAttribute("forward-credentials") && this.getAttribute("forward-credentials") !== "false";
  }

  set forwardCredentials(value: boolean) {
    if (value) {
      this.setAttribute("forward-credentials", "true");
    } else {
      this.removeAttribute("forward-credentials");
    }
  }

  // --- JS-only properties ---

  get prompt(): string | AiContentPart[] { return this._prompt; }
  set prompt(value: string | AiContentPart[]) { this._prompt = value; }

  get tools(): AiTool[] | null { return this._tools; }
  set tools(value: AiTool[] | null) { this._tools = value; }

  get toolChoice(): AiToolChoice | undefined { return this._toolChoice; }
  set toolChoice(value: AiToolChoice | undefined) { this._toolChoice = value; }

  get maxToolRoundtrips(): number | undefined { return this._maxToolRoundtrips; }
  set maxToolRoundtrips(value: number | undefined) { this._maxToolRoundtrips = value; }

  get responseSchema(): Record<string, any> | null { return this._responseSchema; }
  set responseSchema(value: Record<string, any> | null) { this._responseSchema = value; }

  get responseSchemaName(): string | undefined { return this._responseSchemaName; }
  set responseSchemaName(value: string | undefined) { this._responseSchemaName = value; }

  get temperature(): number | undefined {
    const v = this.getAttribute("temperature");
    // Guard against `Number("")` → 0 and `Number("non-numeric")` → NaN
    // both silently shipping a bogus value to the provider. `undefined`
    // here makes AiCore's validation skip the temperature field, which
    // matches the "attribute absent" intent better than 0/NaN ever could.
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  set temperature(value: number | undefined) {
    if (value !== undefined) {
      this.setAttribute("temperature", String(value));
    } else {
      this.removeAttribute("temperature");
    }
  }

  get maxTokens(): number | undefined {
    const v = this.getAttribute("max-tokens");
    // Same guard as `temperature`: `Number("")` is 0 and `Number("abc")`
    // is NaN, both of which would fail AiCore's positive-integer check
    // anyway but with a confusing error pointing at the user-supplied
    // raw value rather than the absent-attribute intent.
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  set maxTokens(value: number | undefined) {
    if (value !== undefined) {
      this.setAttribute("max-tokens", String(value));
    } else {
      this.removeAttribute("max-tokens");
    }
  }

  // --- Output state ---

  get content(): string {
    if (this._isRemote) return (this._remoteValues.content as string) ?? "";
    return this._core?.content ?? "";
  }

  get loading(): boolean {
    if (this._isRemote) return (this._remoteValues.loading as boolean) ?? false;
    return this._core?.loading ?? false;
  }

  get streaming(): boolean {
    if (this._isRemote) return (this._remoteValues.streaming as boolean) ?? false;
    return this._core?.streaming ?? false;
  }

  get error(): AiHttpError | Error | null {
    if (this._isRemote) {
      // Client-side errors (from setWithAck / transport failures) take priority.
      if (this._hasLocalError) return this._errorState;
      // Otherwise return the server-synced value, falling back to _errorState
      // only before the first server sync.
      if ("error" in this._remoteValues) {
        return this._remoteValues.error as AiHttpError | Error | null;
      }
      return this._errorState;
    }
    // AiCore stores non-HTTP failures as a JSON-safe AiSerializedError
    // snapshot; present it as an Error at the element level, memoized so
    // repeated reads (and the declaration getter) return the same instance.
    // The snapshot has no stack; the revived Error takes it from the Core's
    // original exception, which is in this page (see _reviveError).
    const coreError = this._core?.error;
    return coreError != null ? Ai._reviveError(coreError) as AiHttpError | Error : this._errorState;
  }

  get usage(): any {
    if (this._isRemote) return this._remoteValues.usage ?? null;
    return this._core?.usage ?? null;
  }

  get messages(): AiMessage[] {
    if (this._isRemote) {
      const msgs = this._remoteValues.messages as AiMessage[] | undefined;
      return msgs ? msgs.map(cloneMessage) : [];
    }
    return this._core?.messages ?? [];
  }

  set messages(value: AiMessage[]) {
    // Validate client-side even in remote mode so malformed payloads do not
    // travel over the WebSocket just to fail on the server (and so the
    // client-side assertions are consistent with AiCore.messages =).
    validateMessages(value);
    if (this._isRemote) {
      // Send the same normalized copy AiCore.messages = would store locally:
      // cloneMessage drops `undefined`-valued optional fields (`toolCalls:
      // undefined`, `mediaType: undefined`, …), which validateMessages accepts
      // and which mean "absent", but which @wc-bindable/remote >= 0.10 would
      // otherwise reject as non-JsonValue (WC_BINDABLE_INVALID_JSON_VALUE)
      // before anything is sent. Genuinely non-JSON values (Date, NaN, class
      // instances, …) are left for the proxy to reject; see README §Remote Mode.
      this._proxy!.setWithAck("messages", value.map(cloneMessage))
        .then(() => this._clearErrorState())
        .catch((e: unknown) => this._setErrorState(e));
    } else if (this._core) {
      this._core!.messages = value;
    }
  }

  // --- Trigger ---

  get trigger(): boolean { return this._trigger; }

  set trigger(value: boolean) {
    const v = !!value;
    if (v) {
      this._trigger = true;
      this.dispatchEvent(new CustomEvent("ai-agent:trigger-changed", {
        detail: true,
        bubbles: true,
      }));
      // send() normally surfaces failures through `ai-agent:error` via the
      // core / _setErrorState. Early-failure paths that reject *before* the
      // core dispatches (e.g. remote mode unreachable, invalid provider in
      // local mode) still reach here as a rejection — route them into the
      // same error channel instead of swallowing silently.
      this.send().catch((e: unknown) => {
        if (!this._hasLocalError && this._core?.error == null) {
          this._setErrorState(e);
        }
      }).finally(() => {
        this._trigger = false;
        this.dispatchEvent(new CustomEvent("ai-agent:trigger-changed", {
          detail: false,
          bubbles: true,
        }));
      });
    }
  }

  // --- Methods ---

  private _collectSystem(): string {
    // system属性が優先
    if (this.system) return this.system;
    // First <ai-message> child whose `messageKind` resolves to "system"
    // (explicit kind="system" or no attribute at all). Walked in JS rather than
    // via a CSS selector so the dev-mode unknown-kind warning fires from the
    // AiMessageElement getter exactly once per element.
    const tag = config.tagNames.aiMessage;
    const els = Array.from(this.querySelectorAll<AiMessageElement>(tag));
    for (const el of els) {
      if (el.messageKind === "system") {
        return el.messageContent;
      }
    }
    return "";
  }

  /**
   * Seed `_core.messages` from `<ai-message kind="user|assistant">` children
   * for few-shot prompt templates declared in markup. Runs once at connect
   * time and only when the core's history is still empty so programmatic
   * `el.messages = [...]` before connect wins.
   *
   * kind="system" children are intentionally skipped — they flow through
   * `_collectSystem()` into `options.system` on each send, not into the
   * conversation history.
   *
   * Remote mode is not seeded from DOM: the server owns conversation state
   * and client-side seeding at connect would race with the initial sync.
   * Remote callers can still `el.messages = [...]` imperatively after sync.
   */
  private _seedMessagesFromDom(): void {
    if (this._isRemote) return;
    if (!this._core) return;
    if (this._core.messages.length > 0) return;

    const tag = config.tagNames.aiMessage;
    const els = Array.from(this.querySelectorAll<AiMessageElement>(tag));
    const seed: AiMessage[] = [];
    for (const el of els) {
      const kind = el.messageKind;
      if (kind === "user" || kind === "assistant") {
        const content = el.messageContent;
        if (content) seed.push({ role: kind, content });
      }
    }
    if (seed.length > 0) {
      this._core.messages = seed;
    }
  }

  async send(): Promise<string | null> {
    const abortSignal = this._sendAbort.signal;
    // The connection this call belongs to (null in local mode). A remote
    // send() is invoked on it even if the element is removed — or moved,
    // which opens a new connection — while the call waits for the `provider`
    // ack below: removal disposes it, so the invoke rejects with
    // WC_BINDABLE_DISPOSED and the call settles as a transport failure,
    // exactly like a send() that was already on the wire when the element
    // was removed. It is never re-routed to a newer connection.
    const proxy = this._proxy;
    // Wait for any in-flight provider update so we gate on the latest result,
    // not a stale error from a previously superseded attempt.
    //
    // The ack.then(...) handlers in _applyProvider are registered before
    // settledOrAborted's, so per the Promise spec they execute first when ack
    // settles — _lastProviderError is therefore guaranteed to reflect ack's
    // outcome by the time control returns here.
    //
    // This wait is the only point where a remote send() has been called but
    // its `send` command has not been handed to the proxy yet. An abort() in
    // this window cannot reach the server-side Core — nothing is running
    // there yet, and the `abort` command would reach the server ahead of the
    // `send` — so the call is cancelled here instead, without waiting for
    // the ack: like an aborted local send() it resolves to null, and as
    // nothing was sent, loading / error / messages stay as they are. Abort
    // takes precedence over a provider failure reported by the same ack
    // (that failure still lands in `error` and blocks the next send()).
    //
    // Removing the element in this window disposes the proxy, which rejects
    // the ack with WC_BINDABLE_DISPOSED. disconnectedCallback has already
    // dropped that ack as stale — it is not a failed provider change — so
    // the wait ends with no provider error and the invoke below settles the
    // call on the disposed `proxy`.
    if (this._providerUpdate) {
      await settledOrAborted(this._providerUpdate, abortSignal);
      if (abortSignal.aborted) return null;
    }
    // Refuse when the current provider attribute failed to apply so that callers
    // do not silently send with a stale, previously resolved provider.
    const providerError = this._lastProviderError;
    if (providerError) {
      if (Ai._isTransportError(providerError)) {
        // The change was not refused: the connection failed before the ack
        // came back (closed, timed out, pre-sync queue full; classified by
        // error.code like an invoke failure, see _isTransportError). Still
        // refuse to send — the server may be on its previous provider — but
        // settle the way a send() whose invoke fails like this does: resolve
        // to null with the failure in `error` and busy state reset. The ack
        // has already put it in `error`; dispatch it again only if something
        // has replaced it since.
        if (!(this._hasLocalError && this._errorState === providerError)) {
          this._setErrorState(providerError);
        }
        this._resetRemoteBusyState();
        return null;
      }
      // A refusal (unknown provider, server error, WC_BINDABLE_INVALID_JSON_VALUE,
      // WC_BINDABLE_SET_ACK_UNSUPPORTED, ...): something for the caller to fix.
      throw providerError;
    }
    if (proxy) {
      try {
        // Strip `handler` from tools before serialization — functions are not
        // JSON-encodable. The server resolves handlers by name from the
        // `registerTool()` registry at invocation time.
        const remoteTools = this._tools?.map(({ handler: _handler, ...rest }) => rest);
        // Credential gating in remote mode:
        //   - Default (forwardCredentials=false): apiKey/baseUrl/apiVersion are
        //     dropped from the payload. The server is the source of truth for
        //     provider credentials (Case B1). If apiKey is set on the element
        //     in this state, fire a one-time production-visible error so the
        //     developer sees that their key is not being sent.
        //   - Opt-in (forwardCredentials=true): credentials are forwarded as
        //     before, with a dev-only nudge that this is only for trusted
        //     transparent-proxy deployments.
        const forward = this.forwardCredentials;
        if (forward) {
          if (!this._warnedApiKeyLeak && this.apiKey) {
            this._warnedApiKeyLeak = true;
            warnApiKeyInRemoteMode();
          }
        } else if (!this._warnedApiKeyDropped && this.apiKey) {
          this._warnedApiKeyDropped = true;
          errorApiKeyDroppedInRemoteMode();
        }
        // The arguments must be a strict JsonValue: @wc-bindable/remote >= 0.10
        // rejects the whole invoke (WC_BINDABLE_INVALID_JSON_VALUE, before
        // anything is sent) if any property is `undefined` — it no longer
        // drops such keys the way JSON.stringify did. Unset options are
        // therefore OMITTED with conditional spreads, exactly like the local
        // path below; substituting `null` is not an option because AiCore.send
        // validates temperature / maxTokens / maxToolRoundtrips /
        // responseSchema / streamOptions and rejects `null`. Caller-supplied
        // structures (prompt parts, tool declarations, toolChoice,
        // responseSchema) additionally get their `undefined`-valued keys
        // omitted, matching how they behave in local mode (where they end up
        // in a JSON.stringify'd provider request body). Other non-JSON values
        // are left for the proxy to reject with a path.
        //
        // Use invokeWithOptions with timeoutMs: 0 to disable the default 30s
        // timeout — AI inference and long streaming responses routinely exceed it.
        const temperature = this.temperature;
        const maxTokens = this.maxTokens;
        const streamOptions = this.streamOptions;
        return await proxy.invokeWithOptions("send", [omitUndefinedProperties(this._prompt), {
          model: this.model,
          stream: this.stream,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          system: this._collectSystem(),
          ...(forward ? {
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            apiVersion: this.apiVersion,
          } : {}),
          ...(remoteTools ? { tools: omitUndefinedProperties(remoteTools) } : {}),
          ...(this._toolChoice !== undefined ? { toolChoice: omitUndefinedProperties(this._toolChoice) } : {}),
          ...(this._maxToolRoundtrips !== undefined ? { maxToolRoundtrips: this._maxToolRoundtrips } : {}),
          ...(this._responseSchema != null ? { responseSchema: omitUndefinedProperties(this._responseSchema) } : {}),
          ...(this._responseSchemaName !== undefined ? { responseSchemaName: this._responseSchemaName } : {}),
          ...(streamOptions !== undefined ? { streamOptions } : {}),
        }], { timeoutMs: 0 }) as string | null;
      } catch (e) {
        if (Ai._errorCode(e) === "WC_BINDABLE_ABORTED") {
          // A cancelled call, not a failure: the abort contract (resolves to
          // null, `error` not set). Not produced today — the invoke above
          // passes no AckOptions.signal — but this is the code a conformant
          // proxy reports a signal-aborted call with.
          return null;
        }
        if (Ai._isTransportError(e)) {
          // Transport-level failures (disconnect, disposed proxy) are not surfaced
          // by the server's AiCore error events, so expose them through the component state.
          // Also reset loading/streaming so UI does not stay permanently busy.
          this._setErrorState(e);
          this._resetRemoteBusyState();
          return null;
        }
        // Server-side command errors (validation, provider errors) are re-thrown
        // to match local mode's reject behavior.
        throw e;
      }
    }
    if (!this._core) {
      throw this._errorState ?? new Error("[@csbc-dev/ai-agent] Ai is not initialized yet. Attach the element to the DOM before calling send().");
    }
    return this._core.send(this._prompt, {
      model: this.model,
      stream: this.stream,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      system: this._collectSystem(),
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      apiVersion: this.apiVersion,
      ...(this._tools ? { tools: this._tools } : {}),
      ...(this._toolChoice !== undefined ? { toolChoice: this._toolChoice } : {}),
      ...(this._maxToolRoundtrips !== undefined ? { maxToolRoundtrips: this._maxToolRoundtrips } : {}),
      ...(this._responseSchema !== null ? { responseSchema: this._responseSchema } : {}),
      ...(this._responseSchemaName !== undefined ? { responseSchemaName: this._responseSchemaName } : {}),
      ...(this.streamOptions !== undefined ? { streamOptions: this.streamOptions } : {}),
    });
  }

  abort(): void {
    // Cancel every send() still waiting to hand its `send` command to the
    // proxy (a remote send() waiting for the `provider` ack; see send()).
    // The fresh controller leaves a send() issued after this call unaffected.
    this._sendAbort.abort();
    this._sendAbort = new AbortController();
    if (this._isRemote) {
      // A send already handed to the proxy — on the wire or in its pre-sync
      // queue — is ahead of this command, so the server aborts it.
      this._proxy!.invoke("abort").catch(() => {});
    } else if (this._core) {
      this._core!.abort();
    }
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    this.style.display = "none";
    Ai._verifyRegistration(this.tagName.toLowerCase());
    if (config.remote.enableRemote && !this._isRemote) {
      try {
        this._initRemote();
        this._errorState = null;
      } catch (error) {
        this._setErrorState(error);
      }
    }
    if (this.provider) this._applyProvider(this.provider);
    if (config.autoTrigger) {
      registerAutoTrigger();
      this._autoTriggerRegistered = true;
    }
    // Deferred to a microtask so child `<ai-message>` elements have a
    // chance to upgrade when constructed imperatively before append.
    queueMicrotask(() => this._seedMessagesFromDom());
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "provider") {
      this._applyProvider(newValue);
    }
  }

  disconnectedCallback(): void {
    let detachedValues: Record<string, unknown> | null = null;
    if (this._isRemote) {
      // Send abort to cancel any in-flight server-side inference before disposing.
      this._proxy!.invoke("abort").catch(() => {});
      this._unbind?.();
      this._unbind = null;
      // Removal settles every send() of this connection as a transport
      // failure (WC_BINDABLE_DISPOSED) — on the wire, queued before the sync,
      // or still waiting for the `provider` ack; the latter through its own
      // invoke on the disposed proxy (see send()). Two things would otherwise
      // decide those calls differently:
      // - The `provider` state belongs to this connection. dispose() rejects
      //   a pending ack with WC_BINDABLE_DISPOSED, which is not a failed
      //   provider change (re-attaching re-applies the attribute on the new
      //   connection). Dropping the ack here makes its handlers treat it as
      //   stale, so it neither makes the waiting send() reject nor lingers in
      //   _lastProviderError to refuse send()s on the next connection.
      // - An abort() after the removal must not turn those sends into aborts:
      //   it belongs to the next connection, so they keep the old signal.
      this._providerUpdate = null;
      this._lastProviderError = null;
      this._sendAbort = new AbortController();
      this._proxy!.dispose();
      this._proxy = null;
      detachedValues = this._remoteValues;
      this._remoteValues = {};
      if (this._ws) {
        // Clear the reference first so that any close/error dispatched
        // synchronously by close() is suppressed by the _ws !== ws guard
        // in _initRemote's onFail handler.
        const ws = this._ws;
        this._ws = null;
        ws.close();
      }
    } else if (this._core) {
      this._core!.abort();
    }
    if (this._autoTriggerRegistered) {
      unregisterAutoTrigger();
      this._autoTriggerRegistered = false;
    }
    if (detachedValues) {
      // The getters fall back to `false` now; tell bind() consumers too, as
      // the transport-failure contract (and a local removal, which aborts)
      // does. send()'s own reset cannot: it runs after _remoteValues was
      // cleared. Dispatched last, once the teardown is complete, in case a
      // listener re-attaches the element.
      this._resetRemoteBusyState(detachedValues);
    }
  }

  /**
   * Sanity check that bootstrap registered both elements together. Catches
   * the case where a consumer manually calls `customElements.define(..., Ai)`
   * but skips AiMessageElement — system / few-shot children then silently
   * produce no seed. Cannot catch the much more common `import "@csbc-dev/ai-agent"`
   * without bootstrapAi() trap because in that case Ai is never registered
   * and connectedCallback never fires; that path is documented in README
   * §Quick Start as the reason `/auto` exists.
   */
  private static _verifyRegistration(tagName: string): void {
    if (typeof customElements === "undefined") return;
    const getName = (customElements as unknown as { getName?: (c: CustomElementConstructor) => string | null }).getName;
    if (typeof getName !== "function") return;
    if (getName.call(customElements, Ai) == null) {
      warnAiClassUnregistered(tagName);
      return;
    }
    if (getName.call(customElements, AiMessageElement) == null) {
      warnAiPartnerMissing(tagName);
    }
  }

  /**
   * Revive an AiSerializedError snapshot — the local Core's frozen `error`
   * value, or the server Core's copy decoded from the wire — into an Error
   * instance. Memoized per snapshot object (see `revivedErrors`) so the
   * element-level value is identity-stable across `el.error` reads and
   * bind() deliveries.
   *
   * `name` / `message` come from the snapshot, so they are the same in both
   * modes. The snapshot has no `stack` (it is what a server sends to the
   * browser). A local Core's snapshot is revived with the stack of the
   * exception behind it (`inProcessErrorStack`): that failure happened in
   * this page. A snapshot from the wire gets none of the server's, even when
   * an older server still sends a `stack` field — the revived Error keeps
   * the stack of its own construction.
   */
  private static _reviveError(value: any): any {
    if (value == null || typeof value !== "object") return value;
    // Already an Error (Shell-level failures, or a value this method already
    // revived): pass through. Without this guard `"name" in value` would be
    // true via Error.prototype and re-wrap it, losing identity and subclass.
    if (value instanceof Error) return value;
    // AiHttpError has 'status'; it stays a plain object.
    if ("status" in value) return value;
    if ("name" in value && "message" in value) {
      const cached = revivedErrors.get(value);
      if (cached) return cached;
      const err = new Error(value.message);
      err.name = value.name;
      const stack = inProcessErrorStack(value);
      if (stack !== undefined) err.stack = stack;
      revivedErrors.set(value, err);
      return err;
    }
    return value;
  }

  /** The string `code` of an error (SPEC-extensions.md § Error envelope), if any. */
  private static _errorCode(e: unknown): string | undefined {
    if (typeof e !== "object" || e === null) return undefined;
    // A DOMException's legacy numeric `code` is not a registry code.
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }

  /**
   * Whether a rejected remote `send` invocation is a transport failure, which
   * send() reports through `error` (resolving to null) instead of rejecting.
   *
   * An error with a `code` is classified by the code alone:
   * - transport: the codes in TRANSPORT_ERROR_CODES (TERMINAL_FAILURE,
   *   DISPOSED, TIMEOUT, PRE_SYNC_QUEUE_FULL). Nothing about the call is
   *   wrong; it could not be completed over this connection.
   * - everything else is re-thrown, matching local mode, where the caller
   *   gets a rejection for something to fix: INVALID_JSON_VALUE (an argument
   *   is not JSON data — rejected before sending, or by the server on
   *   receipt), PROTOCOL_ERROR (client and server speak different protocol
   *   versions, or a wire bug: permanent, and also a code a server may send
   *   in a `throw`, so it cannot vouch for a transport failure),
   *   INVALID_ACK_OPTIONS (invalid call options), SET_ACK_UNSUPPORTED (never
   *   the result of an invoke; a `provider` ack failing with it makes send()
   *   refuse before this point), REMOTE_THROW and any code the server's Core
   *   throws with. ABORTED is handled by send() before this check.
   *
   * Server-side errors without a code (AiCore.send()'s validation) must not
   * match — not even when their message mentions "closed" or "disposed".
   * The only code-less errors classified as transport are the two that
   * @wc-bindable/remote 0.10 still builds without the registry code:
   * - A throw from the transport's send() is passed through as-is — to the
   *   call that hit it and, as the connection error, to every later call —
   *   rather than as TERMINAL_FAILURE. With the WebSocket transport that is a
   *   DOMException from WebSocket.send (a server error arrives as a plain
   *   Error, never a DOMException) or WebSocketClientTransport's own Error,
   *   which only its message prefix identifies.
   * - An AckOptions timeout is a plain Error named "TimeoutError" rather than
   *   one coded TIMEOUT (send() itself passes timeoutMs: 0).
   * (A code-less server error named "TimeoutError", or whose message carries
   * that prefix, still matches, as it always has.)
   */
  private static _isTransportError(e: unknown): boolean {
    const code = Ai._errorCode(e);
    if (code !== undefined) return TRANSPORT_ERROR_CODES.has(code);
    if (typeof DOMException !== "undefined" && e instanceof DOMException) return true;
    if (!(e instanceof Error)) return false;
    return e.name === "TimeoutError" || e.message.startsWith("WebSocketClientTransport:");
  }
}
