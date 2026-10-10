# Remote-mode server

Shared WebSocket server for the four `remote/` clients. Runs `AiCore` server-side (CSBC **Case B1**) and exposes it to browser-side `<ai-agent>` elements through `RemoteShellProxy` + `WebSocketServerTransport` from `@wc-bindable/remote`.

The provider API key lives only in this process's environment — it is never sent to the browser.

## Setup

```bash
cp .env.example .env       # then edit AI_*
npm install
npm run dev                # ws://localhost:8080/ai-agent
```

> `@csbc-dev/ai-agent` is referenced as `file:../../..`. Run `npm install` and `npm run build` in the repo root once first so `dist/` exists.

Requires Node 20.12+ (uses `node --env-file-if-exists`).

> The `.env` step is optional. The scripts use `--env-file-if-exists`, and `server.js` falls back to empty strings for every `AI_*` var, so a zero-config startup works for a no-key endpoint such as local Ollama (`AI_BASE_URL` is read from the shell env or defaults inside the provider). Create `.env` when you need to supply `AI_API_KEY` or override defaults.

## Configuration

Edit `.env` (see [`.env.example`](.env.example)):

| Variable | Required | Notes |
|---|---|---|
| `AI_PROVIDER` | — | `openai` (default) / `anthropic` / `azure-openai` / `google` |
| `AI_MODEL` | — | Model pinned for every request. When set, clients cannot override it |
| `AI_BASE_URL` | — | Provider endpoint. Empty = provider default. Use `http://localhost:11434` for Ollama (no `/v1` suffix; the library appends `/v1/chat/completions`) |
| `AI_API_KEY` | — (warn only) | Provider API key — **stays on the server**. Not needed for local Ollama. If neither `AI_API_KEY` nor `AI_BASE_URL` is set the server only logs a warning at startup (no hard validation), so requests to the default OpenAI endpoint will then fail with 401 |
| `AI_SYSTEM` | — | Optional system prompt applied to every conversation |
| `PORT` | — | WebSocket port. Default `8080` |

The easiest zero-key setup is a local model server such as [Ollama](https://ollama.com/): `AI_BASE_URL=http://localhost:11434`, `AI_PROVIDER=openai`, `AI_MODEL=<your pulled model>`. Use the bare host with **no** `/v1` suffix — the library appends `/v1/chat/completions`, so a `/v1` here would produce a doubled `/v1/v1/...` path and a 404.

## How it works

- **One `AiCore` per WebSocket connection.** `AiCore` owns conversation history, the in-flight `AbortController`, and streaming state — it must not be shared across sessions. `ws.on("close")` calls `core.abort()` + `shell.dispose()`.
- **`ServerAiCore extends AiCore`** overrides `send()` to inject `apiKey` / `baseUrl` from server env. In remote mode `<ai-agent>` drops `api-key` / `base-url` from the wire payload by default, so the browser literally cannot supply them — the server is the source of truth.
- **`provider` is pinned server-side too.** `provider` is a wcBindable *input*, so the client's `<ai-agent provider=...>` is mirrored to the server-side Core. `ServerAiCore` overrides the `provider` setter to ignore the client value and keep `AI_PROVIDER` — otherwise a client could switch providers while the single server-held `AI_API_KEY` (issued for one provider) is still sent, breaking authorization.
- **`model` / `system` are pinned server-side** when configured, so an untrusted client value cannot pick a costlier model or swap the system prompt.
- **Server code imports `@csbc-dev/ai-agent/server`.** The default entry also defines `<ai-agent>` / `<ai-message>`, which extend `HTMLElement` and cannot load in Node.
- **No server stack trace reaches the browser.** `@wc-bindable/remote` 0.10's `RemoteShellProxy` puts the server's `stack` and `cause` chain on every `throw` reply (a `send()` the server's `AiCore` refuses, a refused `messages` assignment, …; wc-bindable-protocol#38). The transport is wrapped with `withoutThrowInternals`, which sends those replies with only `name` / `message` / `code` and hands the full error to `onThrow`, which logs it here. Drop the wrapper once upstream fixes #38. See [Keeping server stack traces out of `throw` replies](../../../README.md#keeping-server-stack-traces-out-of-throw-replies-withoutthrowinternals).
- **Failures are logged with the original exception.** An `ai-agent:error` listener on the Core logs `core.originalError` — the exception itself (class, stack, `cause`), or for a provider HTTP error an `AiHttpError` whose `cause` holds the status and body. The browser only receives the JSON-safe `core.error`; `originalError` is not declared in `wcBindable` and is never sent. See [Logging the original exception](../../../README.md#logging-the-original-exception-coreoriginalerror).
- The four `remote/` clients all connect to this one server. See [`../README.md`](../README.md).
