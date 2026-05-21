// Vanilla example — remote mode.
//
// Same chat UI and same bind() code as examples/local/vanilla. The only
// difference is the bootstrap: bootstrapAi() is called with remote config
// instead of the side-effect `/auto` import. bootstrapAi() applies the
// config and *then* registers the custom elements, so the <ai-agent> in
// index.html upgrades straight into remote mode — it opens a WebSocket to
// the server-side Core instead of constructing a local AiCore.
import { bootstrapAi } from "@csbc-dev/ai-agent";
import { bind } from "@wc-bindable/core";

const env = import.meta.env;
const remoteUrl = env.VITE_AI_REMOTE_URL || "ws://localhost:8080/ai-agent";
const model = env.VITE_AI_MODEL || "gpt-4o-mini";

// `error` is `AiHttpError | Error | null`. An HTTP error is a plain object
// `{ status, statusText, body, retryAfter }` with no `message` field, so the
// readable text lives in `body`. Many 401/403/429 responses ship an empty
// body, so fall back to statusText / status to avoid an empty red banner.
// Mirror the helper used in the react / vue / wcstack examples so an
// AiHttpError never stringifies to "[object Object]" or "".
function errorText(err) {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "status" in err) {
    return String(err.body || err.statusText || `HTTP ${err.status}`);
  }
  return String(err);
}

bootstrapAi({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: remoteUrl,
  },
});

const ai = document.getElementById("ai");
ai.setAttribute("provider", env.VITE_AI_PROVIDER || "openai");
ai.setAttribute("model", model);
// No base-url / api-key — in remote mode the server owns provider
// credentials and <ai-agent> drops those attributes from the wire payload.

const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const emptyEl = document.getElementById("empty");
const listEl = document.getElementById("msglist");
const streamingEl = document.getElementById("streaming");
const streamingText = document.getElementById("streamingText");
const errorEl = document.getElementById("error");
const usageEl = document.getElementById("usage");
document.getElementById("model").textContent = model;

// Mirror of <ai-agent>'s reactive state, kept in sync by bind(). In remote
// mode these values are synced from the server-side Core over WebSocket —
// the binding code is identical to local mode.
const state = { messages: [], content: "", loading: false, streaming: false };

bind(ai, (name, value) => {
  if (name in state) state[name] = value;

  if (name === "error") {
    errorEl.hidden = !value;
    errorEl.textContent = errorText(value);
  }
  if (name === "usage" && value) {
    usageEl.hidden = false;
    usageEl.textContent =
      `prompt ${value.promptTokens} · completion ${value.completionTokens} · total ${value.totalTokens}`;
  }
  render();
});

function textOf(content) {
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

function render() {
  const turns = state.messages.filter((m) => m.role === "user" || m.role === "assistant");
  emptyEl.hidden = turns.length > 0 || state.streaming;

  listEl.replaceChildren(
    ...turns.map((m) => {
      const wrap = document.createElement("div");
      wrap.className = `msg ${m.role}`;
      const role = document.createElement("div");
      role.className = "role";
      role.textContent = m.role === "user" ? "You" : "Assistant";
      const body = document.createElement("div");
      body.textContent = textOf(m.content);
      wrap.append(role, body);
      return wrap;
    }),
  );

  streamingEl.hidden = !(state.streaming && state.content);
  streamingText.textContent = state.content;

  sendBtn.disabled = state.loading;
  input.disabled = state.loading;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.loading) return;
  input.value = "";
  // `prompt` is a plain JS property; `send()` forwards it to the server-side
  // Core. Connection / transport failures surface through `ai-agent:error`
  // (observed via bind above) just like provider errors.
  ai.prompt = text;
  ai.send().catch(() => {});
});

input.addEventListener("keydown", (e) => {
  // Ignore Enter while an IME is composing (e.g. confirming a Japanese
  // conversion) so it does not submit the half-typed message. keyCode 229
  // is the older-browser fallback for "still composing".
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
