const KNOWN_ROLES = new Set(["system", "user", "assistant", "tool"]);
let _warnedRoleTypos: Set<string> | undefined;

function isDevelopment(): boolean {
  // Mirror the resolution order used in src/debug.ts; kept inline here so the
  // standalone <ai-message> module does not pull in the rest of debug.ts.
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean; PROD?: boolean } }).env;
  if (typeof env?.DEV === "boolean") return env.DEV;
  if (typeof env?.PROD === "boolean") return !env.PROD;
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
  return nodeEnv !== "production";
}

export class AiMessageElement extends HTMLElement {
  constructor() {
    super();
    // Empty Shadow DOM (no slot) suppresses light-DOM rendering of the message
    // text so the host page never displays the prompt / system instructions
    // while still keeping textContent readable from `messageContent`.
    this.attachShadow({ mode: "open" });
  }

  override get role(): string {
    const raw = this.getAttribute("role") || "system";
    // The role attribute is the only steering signal Ai.ts uses to bucket a
    // message into system / user / assistant; a typo (e.g. role="users") is
    // silently dropped from the seed and the prompt looks "off" with no
    // diagnostic. Warn once per typo in development so authors notice.
    if (isDevelopment() && !KNOWN_ROLES.has(raw) && typeof console !== "undefined" && typeof console.warn === "function") {
      _warnedRoleTypos ??= new Set();
      if (!_warnedRoleTypos.has(raw)) {
        _warnedRoleTypos.add(raw);
        console.warn(
          `[@csbc-dev/ai-agent] <ai-message role="${raw}"> uses an unknown role. ` +
          "Expected one of \"system\", \"user\", \"assistant\", \"tool\". The element will be ignored by <ai-agent> seeding."
        );
      }
    }
    return raw;
  }

  get messageContent(): string {
    return this.textContent?.trim() || "";
  }
}
