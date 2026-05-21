# `@csbc-dev/ai-agent` examples

The same streaming-chat surface, built four ways — once per framework binding style — and shipped in **two deployment modes**:

| Directory | Mode | Core runs… | API key… |
|---|---|---|---|
| [`local/`](local/) | local | in the browser | in the browser (dev) or behind a proxy `base-url` |
| [`remote/`](remote/) | remote (Case B1) | on a WebSocket server | never leaves the server |

Both trees contain the same four clients — `vanilla` / `react` / `vue` / `wcstack-state` — rendering an identical chat UI: a message list from `messages`, a live streaming preview from `content`, token counts from `usage`, and an error banner from `error`. They differ only in *how* the framework layer subscribes to `<ai-agent>`'s reactive state, and (local vs. remote) in *where* `AiCore` runs.

| Client | Stack | Demonstrates |
|---|---|---|
| `vanilla/` | Vite + `bind()` from `@wc-bindable/core` | Pure-JS imperative binding |
| `react/` | Vite + React 19 + `@wc-bindable/react` | `useWcBindable` hook |
| `vue/` | Vite + Vue 3 + `@wc-bindable/vue` | `useWcBindable` composable |
| `wcstack-state/` | CDN `<wcs-state>` + `data-wcs` | Declarative HTML attribute binding |

## Local vs. remote

- **[`local/`](local/)** — the simplest, fully self-contained shape: `AiCore` runs in the browser and talks to the provider (or your proxy) directly. No server to start.
- **[`remote/`](remote/)** — the canonical CSBC **Case B1** shape: `AiCore` runs on a server, and the browser-side `<ai-agent>` drives it over WebSocket through `RemoteCoreProxy`. The provider API key lives only in the server's environment. One shared [`remote/server/`](remote/server/) backs all four remote clients.

The browser-facing surface — `prompt`, `model`, `content`, `messages`, `error`, `send()` — is identical in both modes; only the bootstrap differs.

> **Production / API keys.** The `local/` examples are for development. Their `api-key` attribute is visible in the DOM and network panel — **never ship it.** For production pick one of:
> - **Use [`remote/`](remote/)** (recommended): the key never leaves the server. This is the safest path and needs no client-side key handling.
> - **Point `base-url` at your own backend proxy** that injects the provider key server-side and forwards the request (leave `api-key` empty on the client). The proxy is your code, not part of this repo — `local/` only shows the client side of that arrangement.

## Prerequisites

Every example references `@csbc-dev/ai-agent` from the repo via a `file:` dependency. Build the package once from the repo root so `dist/` exists:

```bash
# in the repo root
npm install
npm run build
```

## Quick start

```bash
# Local mode — no server
cd examples/local/vanilla      # or react/, vue/
cp .env.example .env           # then edit VITE_AI_*
npm install && npm run dev

# Remote mode — start the shared server first
cd examples/remote/server
cp .env.example .env           # then edit AI_* (provider key lives here)
npm install && npm run dev     # ws://localhost:8080/ai-agent
# then, in another terminal:
cd examples/remote/vanilla     # or react/, vue/
cp .env.example .env
npm install && npm run dev
```

`wcstack-state/` has no bundler — see its README in each tree.

## Port assignments

| Project | Local | Remote |
|---|---|---|
| `server` (WebSocket) | — | 8080 |
| `vanilla` | 5173 | 5173 |
| `react` | 5174 | 5174 |
| `vue` | 5175 | 5175 |
| `wcstack-state` | static (e.g. 5176) | static (e.g. 5176) |

Run only one mode at a time — the local and remote clients reuse the same dev-server ports.

## See also

- [`local/README.md`](local/README.md) / [`remote/README.md`](remote/README.md) — per-mode setup and what each client demonstrates.
- [`../README.md`](../README.md) — full component documentation, including [§Remote Mode](../README.md#remote-mode).
- [`../CLAUDE.md`](../CLAUDE.md) — CSBC architecture context.
