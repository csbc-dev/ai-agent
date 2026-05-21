# @wcstack/state example (remote mode)

Static HTML page that uses `data-wcs` declarative bindings to wire `<ai-agent>` into a `<wcs-state>` store, with `<ai-agent>` running in **remote mode** — `AiCore` runs on the [shared server](../server/), the browser drives it over WebSocket. CDN-loaded — **no bundler, no install step**.

> **Note (running before npm publish):** the CDN URL `https://esm.run/@csbc-dev/ai-agent/auto/remoteEnv` resolves only once the package is published to npm. Until then, build the repo (`npm run build` in the root) and point that one `<script src>` at the local build using a **root-absolute** path: `/src/auto/remoteEnv.js`. Leave the `@wcstack/state` `<script src>` on its CDN URL — that package is already published, so only the `@csbc-dev/ai-agent` line changes.
>
> A root-absolute path is required because `src/auto/remoteEnv.js` itself does `import "../../dist/index.js"`, so both `src/auto/` and `dist/` must be reachable from the static server's root. That only works if the server is rooted at the **repo root** (see step 3), not at this directory — a relative `../../../src/auto/remoteEnv.js` gets clipped to the server root and 404s.

## Setup

1. Start the [shared server](../server/) first:

   ```bash
   cd ../server
   cp .env.example .env       # edit AI_* (provider key lives here)
   npm install
   npm run dev                # ws://localhost:8080/ai-agent
   ```

2. Open [`index.html`](index.html) and set `window.AI_REMOTE_CORE_URL` to your server's WebSocket URL. `remoteSettingType: "env"` resolves the URL *only* from this global, so it is **required** — there is no implicit fallback. The committed file already sets the default `ws://localhost:8080/ai-agent`, so you can skip this step **only** when your server runs on that exact host/port; change it whenever the server is on a different host or port.

3. Using the CDN default (after publish), serve **this directory**; for the pre-publish local build, serve the **repo root** so `/src/auto/` and `/dist/` resolve:

   ```bash
   # CDN default — serve this directory:
   npx --yes serve -l 5176 .
   # then open http://localhost:5176

   # Pre-publish local build — serve the REPO ROOT instead:
   #   (run from the repo root, after `npm run build`)
   # npx --yes serve -l 5176 .
   # then open http://localhost:5176/examples/remote/wcstack-state/
   ```

   `file://` will not work either way.

## How remote mode is enabled here

- A classic inline `<script>` sets `window.AI_REMOTE_CORE_URL` during parse, before the deferred module scripts run.
- `@csbc-dev/ai-agent/auto/remoteEnv` is the side-effect entrypoint that calls `bootstrapAi()` with `remoteSettingType: "env"`. When `<ai-agent>` connects, it resolves `globalThis.AI_REMOTE_CORE_URL` and opens the WebSocket to the server-side Core.

## What this example demonstrates

- **`auto/remoteEnv` + `window.AI_REMOTE_CORE_URL`** — remote mode with zero bundler config; the URL comes from a global instead of a `bootstrapAi()` call.
- **`data-wcs` directly on `<ai-agent>`** — the binding string is *identical* to the local-mode example: `prompt` / `trigger` are store-driven inputs; `content` / `messages` / `loading` / `streaming` / `error` / `usage` are outputs mirrored back. The Shell exposes the same surface whether the Core is local or remote.
- **No `base-url` / `api-key`** on the element — the server owns provider credentials.
- `for:` / `if:` templates render the conversation history; `showStreaming` shows the live `content` until the assistant turn settles.
