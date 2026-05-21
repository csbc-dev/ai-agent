// Augment Vue's GlobalComponents so the template type-checker accepts
// <ai-agent> and <ai-message>. Vue's runtime treats them as native elements
// thanks to the `isCustomElement` rule in vite.config.ts.

import type { AiAgent, AiMessageElement } from "@csbc-dev/ai-agent";

declare module "@vue/runtime-core" {
  interface GlobalComponents {
    "ai-agent": AiAgent;
    // <ai-message kind="system|user|assistant"> declares conversation history /
    // system prompt as markup children of <ai-agent>.
    "ai-message": AiMessageElement;
  }
}
