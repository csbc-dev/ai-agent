# React example

Vite + React 19 streaming chat client for `<ai-agent>` in **local mode** — `AiCore` runs in the browser, no server. Uses [`@wc-bindable/react`](https://www.npmjs.com/package/@wc-bindable/react)'s `useWcBindable` hook.

## Setup

```bash
cp .env.example .env       # then edit VITE_AI_*
npm install
npm run dev                # http://localhost:5174
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

- `useWcBindable<AiAgent, AiAgentValues>()` — a `[ref, values]` pair; `values` is a reactive snapshot of `content` / `messages` / `usage` / `loading` / `streaming` / `error`.
- Streaming `content` re-renders the component on every rAF-batched chunk.
- Commands run through the ref: `aiRef.current.prompt = "…"` then `aiRef.current.send()`.
- JSX intrinsic-element augmentation for `<ai-agent>` / `<ai-message>` in [`src/ai-agent.d.ts`](src/ai-agent.d.ts).
- No `useEffect`, no manual `fetch`, no SSE parsing — the async work lives in `AiCore`.
