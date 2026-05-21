# React example (remote mode)

Vite + React 19 streaming chat client for `<ai-agent>` running in **remote mode** — `AiCore` runs on the [shared server](../server/), the browser drives it over WebSocket. Uses [`@wc-bindable/react`](https://www.npmjs.com/package/@wc-bindable/react)'s `useWcBindable` hook.

## Setup

Start the [shared server](../server/) first, then:

```bash
cp .env.example .env       # then edit VITE_AI_REMOTE_URL if needed
npm install
npm run dev                # http://localhost:5174
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

- `bootstrapAi({ remote: { ... } })` in [`src/main.tsx`](src/main.tsx) — enables remote mode before the elements register.
- `<ai-agent ref={aiRef} provider model />` — **no `base-url` / `api-key`**; the server owns provider credentials.
- `useWcBindable` and `aiRef.current.send()` are **identical to the local-mode example** — the hook does not care whether the Core is local or proxied over WebSocket.
- `content` / `messages` / `usage` / `loading` / `streaming` are synced from the server-side Core; connection/transport failures surface through the same `error` property.
