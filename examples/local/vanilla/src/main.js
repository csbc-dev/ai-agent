// Vanilla example — local mode.
//
// `@csbc-dev/ai-agent/auto` registers <ai-agent> + <ai-message> on import
// (a side-effect bundle that calls bootstrapAi()). Because it is a static
// import, the custom elements are defined — and the <ai-agent> in index.html
// is upgraded — before this module body runs.
import "@csbc-dev/ai-agent/auto";
import { bind } from "@wc-bindable/core";

const env = import.meta.env;
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

const ai = document.getElementById("ai");
ai.setAttribute("provider", env.VITE_AI_PROVIDER || "openai");
ai.setAttribute("model", model);
if (env.VITE_AI_BASE_URL) ai.setAttribute("base-url", env.VITE_AI_BASE_URL);
if (env.VITE_AI_API_KEY) ai.setAttribute("api-key", env.VITE_AI_API_KEY);
if (env.VITE_AI_SYSTEM) ai.setAttribute("system", env.VITE_AI_SYSTEM);

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

// Mirror of <ai-agent>'s reactive state, kept in sync by bind().
const state = { messages: [], content: "", loading: false, streaming: false };

// bind() reads each declared property once for the initial value, then
// subscribes to its change event. The callback fires for every update,
// including streaming `content` chunks (~60fps, rAF-batched by AiCore).
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
  // Multimodal prompts arrive as parts; show the text fragments.
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

  // During streaming the assistant turn is not in `messages` yet — show the
  // live `content` instead. Once the turn settles it moves into `messages`.
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
  // `prompt` is a plain JS property; `send()` resolves on completion and
  // rejects on failure, but failures also surface through `ai-agent:error`
  // (observed via bind above), so the UI does not need the rejection here.
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
