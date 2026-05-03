export { bootstrapAi } from "./bootstrapAi.js";
export { getConfig, getRemoteCoreUrl, resetConfig } from "./config.js";
export { AiCore } from "./core/AiCore.js";
// Canonical names (introduced in 0.5). The `Wcs*` aliases remain exported
// below for one minor cycle so existing callers can migrate without churn;
// they will be removed in 0.6.
export { Ai as AiAgent, Ai as WcsAi } from "./components/Ai.js";
export { AiMessageElement } from "./components/AiMessage.js";
export { OpenAiProvider } from "./providers/OpenAiProvider.js";
export { AnthropicProvider } from "./providers/AnthropicProvider.js";
export { AzureOpenAiProvider } from "./providers/AzureOpenAiProvider.js";
export { GoogleProvider } from "./providers/GoogleProvider.js";
export {
  registerTool, unregisterTool, getRegisteredTool, clearToolRegistry,
} from "./toolRegistry.js";
export type { AiToolHandler } from "./toolRegistry.js";

export type {
  IConfig, ITagNames, IRemoteConfig,
  IWritableConfig, IWritableTagNames, IWritableRemoteConfig, IAiProvider,
  AiMessage, AiUsage, AiRequestOptions, AiProviderRequest, AiStreamChunkResult,
  AiHttpError,
  // Canonical (0.5+); WcsAi* aliases stay until 0.6 — see WcsAiValues below.
  AiAgentCoreValues, AiAgentValues,
  WcsAiCoreValues, WcsAiValues,
  AiRole, AiFinishReason, AiToolCall, AiTool, AiToolChoice, AiToolCallDelta,
  AiContent, AiContentPart, AiContentTextPart, AiContentImagePart,
} from "./types.js";
