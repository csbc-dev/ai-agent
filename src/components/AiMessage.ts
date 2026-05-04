import { warnAiMessageRoleAttribute, warnAiMessageUnknownKind } from "../debug.js";

const KNOWN_KINDS = new Set(["system", "user", "assistant", "tool"]);

export class AiMessageElement extends HTMLElement {
  constructor() {
    super();
    // Empty Shadow DOM (no slot) suppresses light-DOM rendering of the message
    // text so the host page never displays the prompt / system instructions
    // while still keeping textContent readable from `messageContent`.
    this.attachShadow({ mode: "open" });
  }

  /**
   * Conversation role for this message ("system" | "user" | "assistant" | "tool").
   *
   * Reads the `kind` attribute primarily; falls back to the legacy `role`
   * attribute (with a one-shot dev warning) for one deprecation cycle. The
   * `role` attribute collides with the W3C `HTMLElement.role` ARIA reflection,
   * so 0.5 introduces `kind` as the canonical name and 0.6 will remove the
   * `role` fallback.
   *
   * Returns the raw attribute value so consumers (Ai._collectSystem /
   * _seedMessagesFromDom) can ignore unknown kinds without losing the
   * dev-mode typo signal emitted from this getter.
   */
  get messageKind(): string {
    const kindAttr = this.getAttribute("kind");
    if (kindAttr !== null) {
      if (!KNOWN_KINDS.has(kindAttr)) warnAiMessageUnknownKind(kindAttr, "kind");
      return kindAttr;
    }
    const roleAttr = this.getAttribute("role");
    if (roleAttr !== null) {
      warnAiMessageRoleAttribute();
      if (!KNOWN_KINDS.has(roleAttr)) warnAiMessageUnknownKind(roleAttr, "role");
      return roleAttr;
    }
    return "system";
  }

  get messageContent(): string {
    return this.textContent?.trim() || "";
  }
}
