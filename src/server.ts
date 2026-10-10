/**
 * Server-side entry point (`@csbc-dev/ai-agent/server`).
 *
 * The default barrel (`@csbc-dev/ai-agent`) re-exports `<ai-agent>` and
 * `<ai-message>`, which extend `HTMLElement`; loading it from Node throws
 * `ReferenceError: HTMLElement is not defined`. This entry exports only the
 * headless pieces a server needs to run the Core behind `RemoteShellProxy`:
 *   - `AiCore` and the providers
 *   - the process-wide tool registry (`registerTool`, …)
 *   - `withoutThrowInternals`, which keeps the server's stack traces out of
 *     the `throw` replies `RemoteShellProxy` sends (server-only on purpose,
 *     not in the default barrel)
 *   - types
 *
 * The Shell, `bootstrapAi` and the element config stay in the default barrel.
 */
export { AiCore } from "./core/AiCore.js";
export { OpenAiProvider } from "./providers/OpenAiProvider.js";
export { AnthropicProvider } from "./providers/AnthropicProvider.js";
export { AzureOpenAiProvider } from "./providers/AzureOpenAiProvider.js";
export { GoogleProvider } from "./providers/GoogleProvider.js";
export {
  registerTool, unregisterTool, getRegisteredTool, clearToolRegistry,
} from "./toolRegistry.js";
export type { AiToolHandler } from "./toolRegistry.js";
export { withoutThrowInternals } from "./withoutThrowInternals.js";
export type { WithoutThrowInternalsOptions } from "./withoutThrowInternals.js";

// `AiAgentValues` is intentionally NOT re-exported here: it adds `trigger`, a
// Shell-only property. Server code binds against the Core (`AiAgentCoreValues`).
// The element config types (`IConfig`, …) configure `<ai-agent>` and have no
// meaning server-side either.
export type {
  IAiProvider,
  AiMessage, AiUsage, AiRequestOptions, AiProviderRequest, AiStreamChunkResult,
  AiHttpError, AiSerializedError,
  AiAgentCoreValues,
  AiRole, AiFinishReason, AiToolCall, AiTool, AiToolChoice, AiToolCallDelta,
  AiContent, AiContentPart, AiContentTextPart, AiContentImagePart,
} from "./types.js";
