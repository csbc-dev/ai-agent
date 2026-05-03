import { AiMessage, AiContent } from "../types.js";

function cloneContent(content: AiContent): AiContent {
  if (typeof content === "string") return content;
  return content.map(part => ({ ...part }));
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
  // clone via JSON round-trip to prevent external mutation of nested fields
  // (e.g. `providerHints.anthropic.cacheControl`) from reaching back into
  // the Core's stored history. Fall back to a shallow spread if a hint
  // carries a non-JSON value (functions, BigInt) so we stay best-effort
  // rather than throwing on an exotic payload.
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
  if (m.toolCalls) copy.toolCalls = m.toolCalls.map(tc => ({ ...tc }));
  if (m.toolCallId !== undefined) copy.toolCallId = m.toolCallId;
  if (m.finishReason !== undefined) copy.finishReason = m.finishReason;
  if (m.providerHints !== undefined) copy.providerHints = cloneProviderHints(m.providerHints);
  return copy;
}
