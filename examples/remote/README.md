# Remote-mode examples

Four streaming-chat clients with `<ai-agent>` in **remote mode** — the canonical CSBC **Case B1** shape. `AiCore` runs on a WebSocket server; the browser-side `<ai-agent>` drives it through `RemoteCoreProxy`. The provider API key lives only in the server's environment and never reaches the browser.

All four clients connect to one shared [`server/`](server/).

| Project | Stack | Demonstrates |
|---|---|---|
| [`server/`](server/) | Node + `ws` + `@wc-bindable/remote` | `AiCore` + `RemoteShellProxy`, server-side key injection |
| [`vanilla/`](vanilla/) | Vite + `bind()` from `@wc-bindable/core` | Pure-JS imperative binding |
| [`react/`](react/) | Vite + React 19 + `@wc-bindable/react` | `useWcBindable` hook |
| [`vue/`](vue/) | Vite + Vue 3 + `@wc-bindable/vue` | `useWcBindable` composable |
| [`wcstack-state/`](wcstack-state/) | CDN `<wcs-state>` + `data-wcs` | Declarative HTML attribute binding |

## Run order

Build the package once from the repo root first (see [`../README.md`](../README.md)).

**1. Start the shared server:**

```bash
cd server
cp .env.example .env       # edit AI_* — the provider key lives here
npm install
npm run dev                # ws://localhost:8080/ai-agent
```

**2. Start any client (in another terminal):**

```bash
cd vanilla                 # or react/, or vue/
cp .env.example .env       # edit VITE_AI_REMOTE_URL if the server is elsewhere
npm install
npm run dev
```

`wcstack-state/` has no bundler — see its [README](wcstack-state/README.md).

## What all four clients demonstrate

- **Remote mode: the API key never reaches the browser.** Clients have no `api-key` / `base-url` — `<ai-agent>` drops those from the wire payload by default. The server's `ServerAiCore` injects credentials from its own environment.
- **Identical browser-facing surface.** `prompt`, `model`, `content`, `messages`, `error`, `send()` behave the same as in [local mode](../local/) — only the bootstrap differs (`bootstrapAi({ remote: {...} })`, or `auto/remoteEnv` for the no-bundler client).
- **The binding code is unchanged.** `bind()` / `useWcBindable` / `data-wcs` work against the proxied element exactly as against a local one — the Core being on a server is transparent to the framework layer.
- **One `AiCore` per connection** on the server, owning conversation history and streaming state; `content` / `messages` / `usage` / `loading` / `streaming` are synced back over WebSocket.
- Connection and transport failures surface through the same `error` property as provider errors.

## Port assignments

| Project | Port |
|---|---|
| `server` | 8080 (WebSocket) |
| `vanilla` | 5173 |
| `react` | 5174 |
| `vue` | 5175 |
| `wcstack-state` | static (e.g. 5176) |

## See also

- [`server/README.md`](server/README.md) — server internals: `ServerAiCore`, per-connection lifecycle, credential injection.
- [`../../README.md` §Remote Mode](../../README.md#remote-mode) — wire protocol, configuration order constraint, `forward-credentials`, tool registration.
