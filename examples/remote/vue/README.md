# Vue example (remote mode)

Vite + Vue 3 streaming chat client for `<ai-agent>` running in **remote mode** — `AiCore` runs on the [shared server](../server/), the browser drives it over WebSocket. Uses [`@wc-bindable/vue`](https://www.npmjs.com/package/@wc-bindable/vue)'s `useWcBindable` composable.

## Setup

Start the [shared server](../server/) first, then:

```bash
cp .env.example .env       # then edit VITE_AI_REMOTE_URL if needed
npm install
npm run dev                # http://localhost:5175
```

> `@csbc-dev/ai-agent` is referenced as `file:../../..`. Run `npm install` and `npm run build` in the repo root once first so `dist/` exists.

## Configuration

Edit `.env` (see [`.env.example`](.env.example)):

| Variable | Notes |
|---|---|
| `VITE_AI_REMOTE_URL` | WebSocket URL of the server. Default `ws://localhost:8080/ai-agent` |
| `VITE_AI_PROVIDER` | Provider the element advertises (server pins it when configured) |
| `VITE_AI_MODEL` | Model the element advertises (server pins it when configured) |

There is **no API key** here — the provider key lives only in [`../server/.env`](../server/.env.example).

## Things this example demonstrates

- `bootstrapAi({ remote: { ... } })` in [`src/main.ts`](src/main.ts) — enables remote mode before the elements register.
- `<ai-agent :ref="binding.ref" :provider :model />` — **no `base-url` / `api-key`**; the server owns provider credentials.
- `useWcBindable` and `binding.ref.value.send()` are **identical to the local-mode example** — the composable does not care whether the Core is local or proxied over WebSocket.
- `content` / `messages` / `usage` / `loading` / `streaming` are synced from the server-side Core; connection/transport failures surface through the same `error` property.
