// JSX intrinsic-element augmentation for <ai-agent> / <ai-message>. Without
// this, TypeScript flags the custom elements as unknown.
//
// React 19 (@types/react@19) moved the JSX namespace under `React.JSX` and
// deprecated augmenting the *global* `namespace JSX`. With the automatic
// `react-jsx` runtime the type-checker resolves intrinsic elements from the
// `react` module's JSX namespace, so we augment that instead of `global`.

import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { AiAgent, AiMessageElement } from "@csbc-dev/ai-agent";

type AiAgentAttrs = DetailedHTMLProps<HTMLAttributes<AiAgent>, AiAgent> & {
  provider?: string;
  model?: string;
  "base-url"?: string;
  "api-key"?: string;
  system?: string;
  "no-stream"?: string | boolean;
  temperature?: string | number;
  "max-tokens"?: string | number;
  "api-version"?: string;
  // OpenAI / Azure / OpenAI-compatible knob for `stream_options: { include_usage }`.
  // Use "always" to keep streamed `usage` when an explicit base-url is set.
  "stream-options"?: "auto" | "always" | "never";
  // `forward-credentials` is a remote-mode-only attribute (the server is the
  // credential source in local mode), so it is intentionally omitted here.
};

// <ai-message kind="system|user|assistant"> declares conversation history /
// system prompt as markup children of <ai-agent>.
type AiMessageAttrs = DetailedHTMLProps<HTMLAttributes<AiMessageElement>, AiMessageElement> & {
  kind?: string;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ai-agent": AiAgentAttrs;
      "ai-message": AiMessageAttrs;
    }
  }
}
