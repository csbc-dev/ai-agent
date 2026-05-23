import { warnAiMessageUnknownKind } from "../debug.js";

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
   * Conversation kind for this message — the `AiMessage.role` value
   * ("system" | "user" | "assistant" | "tool").
   *
   * Read from the `kind` attribute; defaults to "system" when absent. `kind` is
   * used rather than `role` because the latter collides with the W3C
   * `HTMLElement.role` ARIA reflection — values like "system" / "user" are not
   * valid ARIA roles and would pollute the accessibility tree.
   *
   * Returns the raw attribute value so consumers (Ai._collectSystem /
   * _seedMessagesFromDom) can ignore unknown kinds without losing the
   * dev-mode typo signal emitted from this getter.
   */
  get messageKind(): string {
    const kindAttr = this.getAttribute("kind");
    if (kindAttr !== null) {
      if (!KNOWN_KINDS.has(kindAttr)) warnAiMessageUnknownKind(kindAttr);
      return kindAttr;
    }
    return "system";
  }

  get messageContent(): string {
    return this.textContent?.trim() || "";
  }
}
