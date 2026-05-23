export { bootstrapAi } from "./bootstrapAi.js";
export { getConfig, getRemoteCoreUrl, resetConfig } from "./config.js";
export { AiCore } from "./core/AiCore.js";
export { Ai as AiAgent } from "./components/Ai.js";
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
  AiAgentCoreValues, AiAgentValues,
  AiRole, AiFinishReason, AiToolCall, AiTool, AiToolChoice, AiToolCallDelta,
  AiContent, AiContentPart, AiContentTextPart, AiContentImagePart,
} from "./types.js";
