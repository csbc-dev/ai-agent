import { AiMessage, AiContent } from "../types.js";
import { omitUndefinedProperties } from "../omitUndefinedProperties.js";

// Parts and tool calls are spread first so the copy never aliases the
// caller's object (even when omitUndefinedProperties hands back an object it
// declined to copy), then stripped of `undefined`-valued keys. An optional
// field set to `undefined` (`{ type: "image", url, mediaType: undefined }`)
// means "absent" everywhere in this package, but `@wc-bindable/remote` >= 0.10
// rejects it on the wire — an `ai-agent:messages-changed` update carrying one
// is dropped by the server-side RemoteShellProxy and never reaches a remote
// client. Normalizing here keeps every history read and write free of them.
function cloneContent(content: AiContent): AiContent {
  if (typeof content === "string") return content;
  return content.map(part => omitUndefinedProperties({ ...part }));
}

function isDevelopment(): boolean {
  // Mirrors src/debug.ts to avoid a cross-import for a single dev-mode
  // warning. cloneMessage is on every history-read path, so keeping it
  // standalone matters for the dependency graph.
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean; PROD?: boolean } }).env;
  if (typeof env?.DEV === "boolean") return env.DEV;
  if (typeof env?.PROD === "boolean") return !env.PROD;
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
  return nodeEnv !== "production";
}

let _warnedShallowProviderHints = false;

/**
 * Deep-enough copy of AiMessage so external callers cannot mutate the array
 * fields (`content` when it is a parts array, `toolCalls`) and silently alter
 * the owning Core's history without emitting a change event.
 */
function cloneProviderHints(hints: Record<string, any>): Record<string, any> {
  // Hints are a namespaced passthrough so shapes are provider-defined; deep
  // clone to prevent external mutation of nested fields (e.g.
  // `providerHints.anthropic.cacheControl`) from reaching back into the
  // Core's stored history. Prefer `structuredClone` (preserves Map/Set/Date
  // and tolerates wider payloads); fall back to JSON round-trip; final
  // fallback is a shallow spread so we stay best-effort rather than
  // throwing on an exotic payload (functions, BigInt, circular refs).
  if (typeof structuredClone === "function") {
    try { return structuredClone(hints); } catch { /* fall through to JSON */ }
  }
  try {
    return JSON.parse(JSON.stringify(hints));
  } catch (error) {
    if (
      isDevelopment() &&
      !_warnedShallowProviderHints &&
      typeof console !== "undefined" &&
      typeof console.warn === "function"
    ) {
      _warnedShallowProviderHints = true;
      console.warn(
        "[@csbc-dev/ai-agent] providerHints contains a non-JSON-serializable value " +
        "(function, BigInt, circular reference, etc.); falling back to a shallow clone. " +
        "External mutation of nested hint fields can now reach the Core's stored history.",
        error,
      );
    }
    return { ...hints };
  }
}

export function cloneMessage(m: AiMessage): AiMessage {
  const copy: AiMessage = { role: m.role, content: cloneContent(m.content) };
  if (m.toolCalls) copy.toolCalls = m.toolCalls.map(tc => omitUndefinedProperties({ ...tc }));
  if (m.toolCallId !== undefined) copy.toolCallId = m.toolCallId;
  if (m.finishReason !== undefined) copy.finishReason = m.finishReason;
  if (m.providerHints !== undefined) {
    // structuredClone keeps `undefined`-valued keys; strip them for the same
    // wire reason as cloneContent above (providers JSON.stringify the hints
    // into the request body, which drops them anyway, so local behavior is
    // unchanged).
    copy.providerHints = omitUndefinedProperties(cloneProviderHints(m.providerHints));
  }
  return copy;
}
