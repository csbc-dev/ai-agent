type ImportMetaEnvLike = {
  DEV?: boolean;
  PROD?: boolean;
  MODE?: string;
};

function isDevelopment(): boolean {
  const env = (import.meta as ImportMeta & { env?: ImportMetaEnvLike }).env;
  if (typeof env?.DEV === "boolean") return env.DEV;
  if (typeof env?.PROD === "boolean") return !env.PROD;

  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
  return nodeEnv !== "production";
}

export function warnStreamParseFailure(
  provider: string,
  event: string | undefined,
  data: string,
  error: unknown
): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn("[@csbc-dev/ai-agent] Failed to parse stream chunk.", {
    provider,
    event,
    data,
    error,
  });
}

// Dev-mode signal for streaming tool-call accumulators that are dropped because
// they are missing `id` or `name` by the time `_materializeToolCalls` runs. In
// a healthy stream every tool_call fragment carries both before arguments-only
// deltas begin, so a missing field usually means a provider bug, a truncated
// stream, or a parser misalignment. Silently skipping (the old behavior)
// produces a terminal assistant turn with no tool use from the consumer's
// perspective — tricky to debug without a log. Fires only in development; in
// production consumers can still observe the shape by inspecting
// `messages[*].toolCalls` on the stored turn.
export function warnMalformedToolCall(
  index: number,
  entry: { id?: string; name?: string; arguments: string }
): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn("[@csbc-dev/ai-agent] Dropped malformed tool_call accumulator (missing id or name).", {
    index,
    id: entry.id,
    name: entry.name,
    argumentsLength: entry.arguments.length,
  });
}

// Dev-mode signal for remote-mode `api-key` attribute leakage. In remote mode
// the server is expected to hold provider credentials; forwarding the
// client-side `api-key` attribute (and its siblings `base-url` / `api-version`)
// over the WebSocket leaks the secret to logs, proxies, and any other observer
// on the transport. Fired only when the caller has *opted in* via
// `forward-credentials="true"` — the default (no forwarding) silently strips
// the key. Dev-mode only because the caller has explicitly acknowledged this
// trade-off; production noise would be unhelpful.
export function warnApiKeyInRemoteMode(): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn(
    "[@csbc-dev/ai-agent] `api-key` is being forwarded over the WebSocket because `forward-credentials` is enabled on a remote-mode <ai-agent>. " +
    "Only do this if your server is a trusted transparent proxy that needs the per-request key — Case B1 deployments should hold the key server-side and leave `forward-credentials` off."
  );
}

// Production-visible (console.error) one-time warning when `api-key` is set on
// a remote-mode <ai-agent> but `forward-credentials` is *not* enabled. The key
// is silently dropped from the wire payload (the secure default), but a caller
// upgrading from 0.4.x — where the key was always forwarded — needs a loud
// signal that their request topology changed. This is intentionally an `error`
// rather than a `warn` so it shows up in default browser consoles and crash
// reporters; the alternative (silent breakage) is worse than log noise.
export function errorApiKeyDroppedInRemoteMode(): void {
  if (typeof console === "undefined" || typeof console.error !== "function") return;

  console.error(
    "[@csbc-dev/ai-agent] `api-key` is set on a remote-mode <ai-agent> but `forward-credentials` is not enabled. " +
    "The key is NOT being sent to the server (this is the secure default since 0.5). " +
    "If your server expects the client to relay the key, add `forward-credentials=\"true\"` to the element. " +
    "Otherwise, remove the `api-key` attribute and let the server hold the credentials."
  );
}

// Dev-mode signal for tool-call `arguments` JSON that fails to parse when a
// provider serializer re-hydrates it on a subsequent turn (Anthropic's
// `tool_use.input`, Google's `functionCall.args`). Silently falling back to
// `{}` (the existing behavior) is correct for wire-format integrity but hides
// upstream bugs: the model emitted partial JSON, the accumulator dropped a
// fragment, or the caller hand-built a tool message with malformed args. Fire
// only in development; production keeps the empty-object fallback so the loop
// can still proceed.
export function warnToolArgumentsParseFailure(
  provider: string,
  name: string,
  rawArguments: string,
  error: unknown
): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn("[@csbc-dev/ai-agent] Failed to parse tool_call arguments JSON; falling back to {}.", {
    provider,
    name,
    rawArguments,
    error,
  });
}

// Dev-mode signal for Anthropic requests that omit `maxTokens`. The Anthropic
// API requires `max_tokens` and the provider falls back to a hard-coded 4096
// to keep the request alive. Silently applying the default hides a real
// configuration gap: a long-form completion will be truncated mid-sentence
// without any error from the wire layer. Production keeps the 4096 fallback
// (so deployments don't break on a forgotten field), but development warns
// once per process so the author notices and sets an explicit budget.
let _warnedAnthropicDefaultMaxTokens = false;
export function warnAnthropicDefaultMaxTokens(defaultValue: number): void {
  if (!isDevelopment()) return;
  if (_warnedAnthropicDefaultMaxTokens) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;
  _warnedAnthropicDefaultMaxTokens = true;

  console.warn(
    `[@csbc-dev/ai-agent] Anthropic request omitted maxTokens; falling back to ${defaultValue}. ` +
    "Anthropic requires max_tokens on every request, and the default may truncate long completions. " +
    "Set `maxTokens` (the `max-tokens` attribute or AiRequestOptions.maxTokens) explicitly for production use."
  );
}

// Dev-mode signal for HMR / module-reload scenarios where a bundler re-executes
// the registering module and hands the registry a *different* handler reference
// for the same tool name. In production this is a bootstrap-ordering bug worth
// investigating; in development it usually just means the module was hot-reloaded.
// Either way, silent replacement has security implications (older sessions
// running the newer user's handler — see README §Remote Mode / Tool use), so we
// surface a warning once per overwrite.
export function warnToolHandlerOverwrite(name: string): void {
  if (!isDevelopment()) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  console.warn(
    `[@csbc-dev/ai-agent] registerTool("${name}") replaced an existing handler with a different function reference. ` +
    "If this is an HMR / hot-reload cycle, call unregisterTool() in your bundler's dispose hook to silence this warning. " +
    "Cross-session handler replacement is a known footgun — see README §Tool use for per-connection authorization patterns (core.registerTool)."
  );
}