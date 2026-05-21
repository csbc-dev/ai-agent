# Local-mode examples

Four streaming-chat clients with `<ai-agent>` in **local mode** — `AiCore` runs in the browser and talks to the provider (or your proxy) directly. No server to start.

| Client | Stack | Demonstrates |
|---|---|---|
| [`vanilla/`](vanilla/) | Vite + `bind()` from `@wc-bindable/core` | Pure-JS imperative binding |
| [`react/`](react/) | Vite + React 19 + `@wc-bindable/react` | `useWcBindable` hook |
| [`vue/`](vue/) | Vite + Vue 3 + `@wc-bindable/vue` | `useWcBindable` composable |
| [`wcstack-state/`](wcstack-state/) | CDN `<wcs-state>` + `data-wcs` | Declarative HTML attribute binding |

## Run a client

```bash
# build the package once from the repo root first (see ../README.md)
cd vanilla                 # or react/, or vue/
cp .env.example .env       # then edit VITE_AI_*
npm install
npm run dev
```

`wcstack-state/` has no bundler — see its [README](wcstack-state/README.md).

## Configuration

The three bundled clients read these Vite env vars (see each example's `.env.example`):

| Variable | Required | Notes |
|---|---|---|
| `VITE_AI_PROVIDER` | — | `openai` (default) / `anthropic` / `azure-openai` / `google` |
| `VITE_AI_MODEL` | — | Model name; must match `VITE_AI_BASE_URL`. `.env.example` ships `gemma3:4b` to pair with the Ollama default (code fallback when unset is `gpt-4o-mini`) |
| `VITE_AI_BASE_URL` | recommended | Backend proxy, provider, or local model endpoint. `.env.example` defaults to `http://localhost:11434` (Ollama — no `/v1` suffix; the library appends `/v1/chat/completions`). Leave empty for official OpenAI |
| `VITE_AI_API_KEY` | — | **Dev only** — exposed in the DOM. Leave empty for a proxy or local Ollama |
| `VITE_AI_SYSTEM` | — | Optional system prompt |

The easiest zero-key setup is a local model server such as [Ollama](https://ollama.com/): `VITE_AI_BASE_URL=http://localhost:11434`, `VITE_AI_PROVIDER=openai`, `VITE_AI_MODEL=<your pulled model>`. Use the bare host with **no** `/v1` suffix — the library appends `/v1/chat/completions`, so a `/v1` here would produce a doubled `/v1/v1/...` path and a 404.

> **Usage panel + official OpenAI:** for the official OpenAI endpoint, leave `VITE_AI_BASE_URL` empty. Any explicit `base-url` makes the `stream_options` heuristic omit `include_usage`, so streamed `usage` is dropped and the panel stays blank. (To force it on against a transparent proxy, add `stream-options="always"` on `<ai-agent>` — not wired through env in these examples.)

To keep the provider API key off the client entirely, use the [`remote/`](../remote/) examples instead.

## Port assignments

| Project | Port |
|---|---|
| `vanilla` | 5173 |
| `react` | 5174 |
| `vue` | 5175 |
| `wcstack-state` | static (e.g. 5176) |
