# Vanilla example (remote mode)

Pure-JS streaming chat client for `<ai-agent>` running in **remote mode** — `AiCore` runs on the [shared server](../server/), the browser drives it over WebSocket. Binding is done imperatively with `bind()` from [`@wc-bindable/core`](https://www.npmjs.com/package/@wc-bindable/core).

## Setup

Start the [shared server](../server/) first, then:

```bash
cp .env.example .env       # then edit VITE_AI_REMOTE_URL if needed
npm install
npm run dev                # http://localhost:5173
```

> `@csbc-dev/ai-agent` is referenced as `file:../../..`. Run `npm install` and `npm run build` in the repo root once first so `dist/` exists.

## Configuration

Edit `.env` (see [`.env.example`](.env.example)):

| Variable | Notes |
|---|---|
| `VITE_AI_REMOTE_URL` | WebSocket URL of the server. Default `ws://localhost:8080/ai-agent` |
| `VITE_AI_PROVIDER` | Provider the element advertises (server pins it when configured) |
| `VITE_AI_MODEL` | Model the element advertises (server pins it when configured) |

There is **no API key** here — that is the point of remote mode. The provider key lives only in [`../server/.env`](../server/.env.example).

## Things this example demonstrates

- `bootstrapAi({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl } })` — applies the config, then registers the elements, so `<ai-agent>` upgrades straight into remote mode.
- `<ai-agent>` has **no `base-url` / `api-key`** — in remote mode those are dropped from the wire payload; the server owns provider credentials.
- `bind(el, cb)` and `el.prompt = "…"` + `el.send()` are **identical to local mode** — the Shell exposes the same surface whether the Core is local or remote.
- `content` / `messages` / `usage` / `loading` / `streaming` are synced from the server-side Core over WebSocket.
- Connection and transport failures surface through the same `error` property as provider errors.
