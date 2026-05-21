# @wcstack/state example

Static HTML page that uses `data-wcs` declarative bindings to wire `<ai-agent>` into a `<wcs-state>` store. CDN-loaded — **no bundler, no install step**.

`<ai-agent>` runs in **local mode**: `AiCore` runs in the browser, no server.

> **Note (running before npm publish):** the CDN URL `https://esm.run/@csbc-dev/ai-agent/auto` resolves only once the package is published to npm. Until then, build the repo (`npm run build` in the root) and point that one `<script src>` at the local build using a **root-absolute** path: `/src/auto/auto.js`. Leave the `@wcstack/state` `<script src>` on its CDN URL — that package is already published, so only the `@csbc-dev/ai-agent` line changes.
>
> A root-absolute path is required because `src/auto/auto.js` itself does `import "../../dist/index.js"`, so both `src/auto/` and `dist/` must be reachable from the static server's root. That only works if the server is rooted at the **repo root** (see step 2), not at this directory — a relative `../../../src/auto/auto.js` gets clipped to the server root and 404s.

## Setup

1. Edit [`index.html`](index.html) — set `provider` / `model` / `base-url` on the `<ai-agent>` element for your endpoint. The committed file ships the Ollama row below (`provider="openai"`, `model="gemma3:4b"`, `base-url="http://localhost:11434"`), so it runs against a local Ollama out of the box; switch the attributes for another provider:

   | Provider | `base-url` | `provider` | `model` |
   |---|---|---|---|
   | Ollama (local) — committed default | `http://localhost:11434` | `openai` | `gemma3:4b` |
   | OpenAI | *(omit `base-url`)* | `openai` | `gpt-4o-mini` |
   | Anthropic | `https://api.anthropic.com` | `anthropic` | `claude-sonnet-4-20250514` |

   > **Ollama:** use the bare host `http://localhost:11434` with **no** `/v1` suffix — the library appends `/v1/chat/completions`, so a trailing `/v1` would produce a doubled `/v1/v1/...` path and a 404.

   For a hosted provider, add `api-key="..."` (dev only — visible in the DOM). In production point `base-url` at a backend proxy that injects the key server-side.

   > Pointing `base-url` at the official `https://api.openai.com` makes streaming `usage` drop silently (the `stream_options` heuristic omits it for any explicit base-url). To keep the usage panel populated, either **leave `base-url` unset** (the OpenAI default endpoint is used and usage is included) or add `stream-options="always"` on `<ai-agent>`.

2. Using the CDN default (after publish), serve **this directory**; for the pre-publish local build, serve the **repo root** so `/src/auto/` and `/dist/` resolve (a real `Origin` is needed for CORS-aware fetch):

   ```bash
   # CDN default — serve this directory:
   npx --yes serve -l 5176 .
   # then open http://localhost:5176

   # Pre-publish local build — serve the REPO ROOT instead:
   #   (run from the repo root, after `npm run build`)
   # npx --yes serve -l 5176 .
   # then open http://localhost:5176/examples/local/wcstack-state/
   ```

   `file://` will not work either way.

## What this example demonstrates

- **`data-wcs` directly on `<ai-agent>`** — one binding string wires the whole component: `prompt` / `trigger` are store-driven inputs; `content` / `messages` / `loading` / `streaming` / `error` / `usage` are outputs mirrored back into the store.
- **Trigger-based send** — setting `sendRequested` true flips the element's `trigger` property, which calls `send()`. `prompt` is bound before `trigger` in the `data-wcs` string so the prompt is in place when the run starts; `<ai-agent>` resets `trigger` when the run settles.
- **Streaming preview** — `showStreaming` renders the live `content` until the assistant turn settles into `messages`.
- **`for:` / `if:` templates** — conversation history is rendered with `data-wcs="for: displayMessages"` and per-role `if:` branches.
- No `fetch`, no SSE parsing, no bundler — the async work lives in `AiCore`, the wiring is declarative HTML.
