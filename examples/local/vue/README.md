# Vue example

Vite + Vue 3 streaming chat client for `<ai-agent>` in **local mode** — `AiCore` runs in the browser, no server. Uses [`@wc-bindable/vue`](https://www.npmjs.com/package/@wc-bindable/vue)'s `useWcBindable` composable.

## Setup

```bash
cp .env.example .env       # then edit VITE_AI_*
npm install
npm run dev                # http://localhost:5175
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

- `useWcBindable<AiAgent, AiAgentValues>()` — returns `{ ref, values }`; `values` is a reactive object mirroring `content` / `messages` / `usage` / `loading` / `streaming` / `error`.
- Streaming `content` re-renders the template on every rAF-batched chunk.
- Commands run through the ref: `binding.ref.value.prompt = "…"` then `.send()`.
- `compilerOptions.isCustomElement` (in [vite.config.ts](vite.config.ts)) keeps Vue from resolving `<ai-agent>` / `<ai-message>` as Vue components.
- `GlobalComponents` augmentation for the template type-checker in [`src/ai-agent.d.ts`](src/ai-agent.d.ts).
