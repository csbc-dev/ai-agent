# Vanilla example

Pure-JS streaming chat client for `<ai-agent>` running in **local mode** — `AiCore` runs in the browser, no server. Binding is done imperatively with `bind()` from [`@wc-bindable/core`](https://www.npmjs.com/package/@wc-bindable/core).

## Setup

```bash
cp .env.example .env       # then edit VITE_AI_*
npm install
npm run dev                # http://localhost:5173
```

> `@csbc-dev/ai-agent` is referenced as `file:../../..`. Run `npm install` and `npm run build` in the repo root once first so `dist/` exists.

## Configuration

Edit `.env` (see [`.env.example`](.env.example)):

| Variable | Required | Notes |
|---|---|---|
| `VITE_AI_PROVIDER` | — | `openai` (default) / `anthropic` / `azure-openai` / `google` |
| `VITE_AI_MODEL` | — | Model name; must match `VITE_AI_BASE_URL`. `.env.example` ships `gemma3:4b` to pair with the Ollama default below (code fallback when unset is `gpt-4o-mini`) |
| `VITE_AI_BASE_URL` | recommended | Backend proxy, provider, or local model endpoint. `.env.example` defaults to `http://localhost:11434` (Ollama — no `/v1` suffix; the library appends `/v1/chat/completions`). Leave empty for official OpenAI |
| `VITE_AI_API_KEY` | — | **Dev only** — exposed in the DOM. Leave empty for a proxy or local Ollama |
| `VITE_AI_SYSTEM` | — | Optional system prompt |

## Things this example demonstrates

- `import "@csbc-dev/ai-agent/auto"` — side-effect registration of `<ai-agent>` / `<ai-message>`.
- `<ai-agent>` configured imperatively from env vars via `setAttribute`.
- `bind(el, cb)` — one callback for `content` / `messages` / `usage` / `loading` / `streaming` / `error`, including rAF-batched streaming `content` updates.
- `el.prompt = "…"` + `el.send()` to run inference; errors surface through the `error` property rather than only the `send()` rejection.
- Streaming preview: the in-flight assistant turn shows `content` until it settles into `messages`.
