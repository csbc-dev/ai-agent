# CLAUDE.md

This repository (`@csbc-dev/ai-agent`) is a re-package of [`@wc-bindable/ai`](https://github.com/wc-bindable-protocol/wc-bindable-protocol/tree/main/packages/ai), incorporated as a member of the csbc-dev/arch architecture family. The two documents below summarize the prerequisites for understanding the design.

---

## 1. wc-bindable-protocol overview

A framework-agnostic, minimal protocol that lets any class extending `EventTarget` declare its own reactive properties. Reactivity systems in React / Vue / Svelte / Angular / Solid and others can bind to such components without writing framework-specific glue code.

### Core idea

- The component author declares **what** is bindable
- The framework consumer decides **how** to bind it
- Neither side needs to know about the other

### How to declare

Simply write the schema in a `static wcBindable` field.

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs:   [{ name: "url" }, { name: "method" }],   // optional
    commands: [{ name: "fetch", async: true }, { name: "abort" }],  // optional
  };
}
```

| Field | Required | Role |
|---|---|---|
| `properties` | ✅ | Properties whose state changes are notified via `CustomEvent` (output) |
| `inputs` | — | Settable properties (input; declaration only — no automatic synchronization) |
| `commands` | — | Invokable methods (for remote proxies and tooling) |

### Binding mechanism

An adapter only needs to:

1. Read `target.constructor.wcBindable`
2. Verify `protocol === "wc-bindable" && version === 1`
3. For each `property`, immediately read `target[name]` to deliver the initial value, then subscribe to `event`

`bind()` is at most ~20 lines. A framework adapter can be written in a few dozen lines.

### Out of scope (intentional)

- Automatic two-way synchronization (input propagation is the caller's responsibility)
- Form integration
- SSR / hydration
- Value-type / schema validation

### Why EventTarget

By requiring `EventTarget` rather than `HTMLElement` as the minimum, the same protocol works in non-browser runtimes such as Node.js, Deno, and Cloudflare Workers. Since `HTMLElement` is a subclass of `EventTarget`, Web Components are automatically compatible.

Reference: [wc-bindable-protocol/SPEC.md](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/SPEC.md)

---

## 2. Core/Shell Bindable Component (CSBC) architecture overview

Built on top of wc-bindable-protocol, CSBC is an architecture that **moves business logic — especially asynchronous code — out of the framework layer and into the Web Component layer**, structurally eliminating framework lock-in.

### The problem it solves

The real source of framework migration cost is not UI compatibility but **async logic tightly coupled to framework-specific lifecycle APIs (`useEffect` / `onMounted` / `onMount` …)**. Templates can be rewritten mechanically, but async code requires semantic understanding, which sends porting cost soaring.

### Three-layer structure

1. **Headless Web Component layer** — encapsulates async work (fetch / WebSocket / timers, etc.) and state (`value`, `loading`, `error`, …) internally. Has no UI; behaves as a pure service layer.
2. **Protocol layer (wc-bindable-protocol)** — exposes that state outward via `static wcBindable` + `CustomEvent`.
3. **Framework layer** — connects to the protocol through a thin adapter and renders the received state. **No async code lives here.**

### Core / Shell separation

The Headless layer is further decomposed in two. **The single invariant is not "the Shell is always thin," but where decisions live**:

- **Core (`EventTarget`) — owns decisions**
  Business logic, policy, state transitions, authorization-related behavior, event emission. If kept DOM-free it can travel to Node.js / Deno / Workers.
- **Shell (`HTMLElement`) — owns only the execution that cannot be delegated**
  Framework wiring, DOM lifecycle, browser-only operations.

The key design pattern is **target injection**: the Core constructor accepts an arbitrary `EventTarget` and dispatches all events to it. When the Shell passes `this`, the Core's events fire directly from the DOM element without any re-dispatch.

### Four canonical cases

| Case | Core location | Shell role | Examples |
|---|---|---|---|
| A | Browser | Thin wrapper around a browser-bound Core | `auth0-gate` (local) |
| B1 | Server | Thin Shell as a command-mediating proxy | **`ai-agent` (remote)** |
| B2 | Server | Observation-only thin Shell (subscribes to a remote session) | `feature-flags` |
| C | Server | Shell that runs a browser-bound data plane | `s3-uploader`, `passkey-auth`, `stripe-checkout` |

Case C is **first-class**, not a deviation from CSBC. It arises whenever a data plane can only run in the browser (direct uploads, WebRTC, WebUSB, `File System Access API`, gesture-dependent actions, Stripe Elements for PCI-scope avoidance, etc.). A thicker Shell does **not** violate CSBC **as long as the decisions stay in the Core.**

> Invariant:
> **The Core owns every decision. The Shell owns only execution that cannot be delegated.**

### The three boundaries it crosses

| Boundary | Crossing actor | Mechanism |
|---|---|---|
| Runtime boundary | Core (`EventTarget`) | DOM-free; runs on Node / Deno / Workers |
| Framework boundary | Shell (`HTMLElement`) | Attribute mapping + `ref` binding |
| Network boundary | `@wc-bindable/remote` | Proxy EventTarget + JSON wire protocol |

`@wc-bindable/remote` consists of `RemoteShellProxy` (server side) and `RemoteCoreProxy` (client side), pushing the Core fully onto the server while keeping the client-side `bind()` unchanged. The default transport is WebSocket, but anything satisfying the minimal `ClientTransport` / `ServerTransport` interfaces (MessagePort, BroadcastChannel, WebTransport, …) can be substituted.

### Position of this package

`@csbc-dev/ai-agent` is **Case B1**: every AI inference decision (provider selection, streaming, tool-call loop, conversation state) lives in `AiCore` (Core, `EventTarget`), and `<ai-agent>` (Shell, `HTMLElement`) only handles local exposure of bindable state and command forwarding. In remote mode the Core is placed on the server, so API keys and authorization never leak to the client.

Reference: [csbc-dev/arch (formerly hawc)](https://github.com/csbc-dev/arch/blob/main/README.md)

---

## 3. This package (`@csbc-dev/ai-agent`) overview

A declarative AI inference component. It implements streaming and multi-provider support (OpenAI / Anthropic / Azure OpenAI / Google Gemini) **without any provider SDK** (`fetch` + `ReadableStream` + an in-house SSE parser) and exposes the result through wc-bindable-protocol. It carries no visual UI — it is an **I/O node** that connects LLM inference to reactive state.

The only runtime dependencies are [`@wc-bindable/core`](../wc-bindable-core) and [`@wc-bindable/remote`](../wc-bindable-remote).

### Directory layout

```
src/
├── index.ts                 Public API barrel
├── bootstrapAi.ts           Entry: setConfig + registerComponents
├── registerComponents.ts    Idempotent guard wrapper around customElements.define
├── config.ts                Global config (tagNames / autoTrigger / remote)
├── autoTrigger.ts           data-aitarget click delegation handler (refcounted)
├── toolRegistry.ts          Process-wide tool handler registry (used in remote mode)
├── types.ts                 Public types (AiMessage / AiTool / AiHttpError, etc.)
├── debug.ts / raiseError.ts Dev-time warnings and error formatting
├── omitUndefinedProperties.ts  Drops `undefined`-valued keys before values reach the remote wire
├── core/
│   ├── AiCore.ts            Core (EventTarget) — history, streaming, tool loop
│   ├── cloneMessage.ts      Deep-clone for AiMessage (prevents history mutation)
│   └── validateMessages.ts  Input validation for messages
├── components/
│   ├── Ai.ts                Shell (<ai-agent>) — supports both local and remote modes
│   └── AiMessage.ts         <ai-message> — thin tag for declaring history as children
├── providers/               Per-provider wire-protocol translation
│   ├── OpenAiProvider.ts
│   ├── AnthropicProvider.ts
│   ├── AzureOpenAiProvider.ts (extends OpenAI)
│   ├── GoogleProvider.ts
│   ├── contentHelpers.ts        Multimodal content normalization
│   └── validateRequestOptions.ts
├── streaming/
│   └── SseParser.ts             Provider-agnostic Server-Sent Events parser
└── auto/                    Side-effect-only entrypoints (shipped in npm artifact)
    ├── auto.js                  Calls bootstrapAi() immediately
    └── remoteEnv.js             Boots with remote.enableRemote=true + remoteSettingType=env
```

### Public API (`src/index.ts`)

- **Bootstrap**: `bootstrapAi(config?)` / subpaths `@csbc-dev/ai-agent/auto`, `@csbc-dev/ai-agent/auto/remoteEnv`
- **Core class**: `AiCore` (extends `EventTarget`, supports `target` injection)
- **Shell class**: `AiAgent` (alias of `Ai`, the implementation behind `<ai-agent>`)
- **Element class**: `AiMessageElement` (the implementation behind `<ai-message>`)
- **Providers**: `OpenAiProvider` / `AnthropicProvider` / `AzureOpenAiProvider` / `GoogleProvider`
- **Tool registry**: `registerTool` / `unregisterTool` / `getRegisteredTool` / `clearToolRegistry` (process-wide)
- **Config readers**: `getConfig()` / `getRemoteCoreUrl()` / `resetConfig()`
- **Types**: `AiMessage` / `AiTool` / `AiToolCall` / `AiContent(*)Part` / `AiHttpError` / `AiUsage` / `AiRequestOptions` / `AiAgentCoreValues` / `AiAgentValues` and more

### Bindable surface

`AiCore.wcBindable` (exposed by the Core directly):

| Kind | Names | Events |
|---|---|---|
| properties (output) | `content` / `messages` / `usage` / `loading` / `streaming` / `error` | `ai-agent:*-changed` / `ai-agent:error` |
| inputs | `provider` / `messages` | — |
| commands | `send` (async) / `abort` | — |

The Shell (`Ai.wcBindable`) adds a `trigger` property (`ai-agent:trigger-changed`) on top of the above.

### Responsibilities by layer

- **`AiCore`** ([src/core/AiCore.ts](src/core/AiCore.ts)) — `Retry-After` header parsing, storing non-HTTP errors as a frozen JSON-safe `AiSerializedError` snapshot (`{ name, message, stack? }`, never an `Error` instance — see Remote mode below), `requestAnimationFrame`-batched streaming content updates, the tool-call loop (`maxToolRoundtrips` defaults to 10), `responseSchema` structured output, and an instance-scoped tool handler registry (`registerTool`/`unregisterTool`). Uses `target` injection so events fire directly from the Shell's DOM node.
- **`<ai-agent>`** ([src/components/Ai.ts](src/components/Ai.ts)) — In local mode constructs `new AiCore(this)`; in remote mode connects to the server-side Core through `RemoteCoreProxy` + `WebSocketClientTransport` from `@wc-bindable/remote`. Holds `prompt` / `tools` / `toolChoice` / `maxToolRoundtrips` / `responseSchema` and assembles them into `AiRequestOptions` on `send()`.
- **Provider layer** — Translates each vendor's request/response shape to and from `AiMessage` ⇄ `AiProviderRequest` / `AiStreamChunkResult`. `AiFinishReason` (`stop|length|tool_use|safety|other`) and `toolCallDeltas` (parallel tool calls) are normalized to a unified vocabulary as well.

### Remote mode

`RemoteShellProxy` (server) / `RemoteCoreProxy` (client) from `@wc-bindable/remote` push the Core onto the server. The client-side `<ai-agent>` is unchanged; tool handlers registered via `registerTool()` on the server are invoked by the Core there, so API keys and authorization logic never reach the browser. Setting `remote.remoteSettingType` to `"env"` resolves the WebSocket URL from `process.env.AI_REMOTE_CORE_URL` or `globalThis.AI_REMOTE_CORE_URL`.

The package pins `@wc-bindable/core` / `@wc-bindable/remote ^0.10.0`. The remote layer adds a **declaration fingerprint** on every sync — the client compares the server's `AiCore.wcBindable` surface to its own and warns on version skew before it surfaces as a per-message rejection — plus capabilities negotiation. `<ai-agent>` defaults `preSyncBehavior` to the spec-conformant `"queue"` (`config.remote.preSyncBehavior`), overriding the library default, which is still the non-conformant `"eager"`; see the comment in `Ai._connectRemote`. `<ai-agent>` injects a dev-gated `logger` (`remoteLogger` in [src/debug.ts](src/debug.ts)) into `createRemoteCoreProxy` so these remote-layer diagnostics carry the package prefix and respect the same `isDevelopment()` gate as the rest of the warnings. The protocol identifier is still `wc-bindable` v1; the `version` field in [src/types.ts](src/types.ts) is typed `number` (not the literal `1`) to match the protocol's forward-compatibility policy.

Since 0.10 both proxies validate every value they **send** as a strict `JsonValue` (SPEC-extensions.md § Design invariants, invariant 3): `undefined` anywhere inside a value, `Date`, `NaN`, class instances (including `Error`, even with `toJSON`) are rejected, never coerced. This drives several deliberate shapes that look unusual — do not "simplify" them:

- **`AiCore.error` holds a frozen plain `AiSerializedError`, not an `Error`.** `RemoteShellProxy` reads `core.error` directly for `sync` and the event `detail` for `update`, so both must be JSON-safe; an `Error` there means a dropped update / `getterFailures` and a remote `el.error` stuck at `null`. Do not add a getter to `AiCore.wcBindable` instead — the server builds its updates from that declaration and `Ai.wcBindable` spreads it.
- **`Ai.wcBindable`'s `error` descriptor has a getter** that revives the snapshot (memoized per snapshot in `Ai._reviveError`), and `el.error` revives it in local mode too, so the element still exposes `Error` instances to `el.error` and `bind()` consumers in both modes.
- **Remote `send()` omits unset options with conditional spreads** (mirroring the local path). Never substitute `null`: `AiCore.send` rejects `null` for `temperature` / `maxTokens` / `maxToolRoundtrips` / `responseSchema` / `streamOptions`.
- **`undefined`-valued properties are omitted, everything else is left for the wire validator** ([src/omitUndefinedProperties.ts](src/omitUndefinedProperties.ts)). `cloneMessage` applies it to parts / tool calls / `providerHints`, the remote `messages` setter sends `value.map(cloneMessage)`, and remote `send()` applies it to the prompt, tools, `toolChoice` and `responseSchema`. It must not coerce `Date` / `NaN` / class instances — that would reintroduce the silent reshaping 0.10 removed.
- **`Ai._isTransportError` classifies by `error.code`, not by message.** Transport = `TERMINAL_FAILURE` / `DISPOSED` / `TIMEOUT` / `PRE_SYNC_QUEUE_FULL`. These are consumer-only codes, which the proxy re-codes to `REMOTE_THROW` when a server sends them, so a server error can never pass for a transport failure. `PROTOCOL_ERROR`, `INVALID_JSON_VALUE` and everything else is re-thrown; `ABORTED` resolves `null` without an error. The code-less fallbacks (a raw `DOMException`, the `WebSocketClientTransport:` message prefix, the `TimeoutError` name) exist only because 0.10 does not code raw transport-send failures or timeouts (upstream wc-bindable-protocol#39). Do not add message matches back.
- **`abort()` cancels a remote `send()` still waiting for the `provider` ack on the client** (`_sendAbort`, replaced on every abort). Sending only the `abort` command is not enough: it reaches the server ahead of the `send` and is a no-op there.

### Configuration (`config.ts`)

| Key | Default | Purpose |
|---|---|---|
| `autoTrigger` | `true` | Enables `data-aitarget` click delegation |
| `triggerAttribute` | `"data-aitarget"` | Delegation attribute name |
| `tagNames.ai` | `"ai-agent"` | Custom element name (validated) |
| `tagNames.aiMessage` | `"ai-message"` | Element name for declaring history |
| `remote.enableRemote` | `false` | Toggles remote mode |
| `remote.remoteSettingType` | `"config"` | URL resolution method (`"config"` or `"env"`) |
| `remote.remoteCoreUrl` | `""` | WS URL when `remoteSettingType="config"` |
| `remote.preSyncBehavior` | `"queue"` | Calls made before the initial sync: `"queue"` (spec-conformant) or `"eager"` |

`setConfig` validates the custom element name grammar (`/^[a-z][a-z0-9\-_.]*-[a-z0-9\-_.]*$/`) and the `remoteSettingType` enum at the boundary. `getConfig()` returns a deeply frozen clone.

### Build and test

```bash
npm run build          # tsc → dist/
npm run dev            # tsc --watch
npm test               # vitest run __tests__   (unit, happy-dom)
npm run test:watch
npm run test:coverage  # v8 coverage
npm run test:integration # build → playwright (tests/, browser integration)
```

- Unit tests: [`__tests__/`](__tests__/) (vitest + happy-dom)
- Integration tests: [`tests/`](tests/) ([playwright.config.ts](playwright.config.ts))
- TypeScript: [`tsconfig.json`](tsconfig.json)

### Important invariants

- **The Core owns every decision; the Shell owns only execution that cannot be delegated** (DOM lifecycle, attribute observation, remote transport setup). When adding a feature, first check whether it can live in `AiCore`.
- **Do not add a provider SDK as a dependency.** The design is to stay self-contained on `fetch` + `ReadableStream` + `SseParser` (see `keywords: ["no-provider-sdk"]` in [package.json](package.json)).
- **A tool declaration requires `AiRequestOptions.tools`; the registry only fills in the function body.** A model that calls a tool present in the registry but not declared on the request is refused (see the "Capability boundary" comment in `toolRegistry.ts`).
- **`AiMessage` is always deep-cloned via `cloneMessage` on read.** This prevents external mutation of history from corrupting internal state.
