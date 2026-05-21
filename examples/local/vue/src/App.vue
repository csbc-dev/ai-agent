<script setup lang="ts">
import { computed, ref } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type { AiAgent, AiAgentValues, AiContent } from "@csbc-dev/ai-agent";

const env = import.meta.env;
const provider = env.VITE_AI_PROVIDER || "openai";
const model = env.VITE_AI_MODEL || "gpt-4o-mini";

// useWcBindable returns a `ref` to attach to the element and a reactive
// `values` object mirroring its wcBindable properties. `values.content`
// updates on every streaming chunk (rAF-batched by AiCore).
const binding = useWcBindable<AiAgent, AiAgentValues>();
const values = binding.values;

const input = ref("");

const turns = computed(() =>
  (values.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant"),
);

function textOf(content: AiContent): string {
  if (typeof content === "string") return content;
  // Multimodal prompts arrive as parts; show the text fragments.
  return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

function errorText(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  // AiHttpError = { status, statusText, body, retryAfter }. Many 401/403/429
  // responses ship an empty body, so fall back to statusText / status to avoid
  // an empty red banner (matches the vanilla / react / wcstack helpers).
  if (typeof err === "object" && err !== null && "status" in err) {
    const e = err as { status: number; statusText?: string; body?: string };
    return String(e.body || e.statusText || `HTTP ${e.status}`);
  }
  return String(err);
}

function send() {
  const text = input.value.trim();
  const el = binding.ref.value;
  if (!text || values.loading || !el) return;
  input.value = "";
  // `prompt` is a plain JS property on the element; `send()` runs the
  // inference. Failures also surface through `values.error` (rendered
  // below), so the rejection only needs to be swallowed.
  el.prompt = text;
  el.send().catch(() => {});
}

function onKeydown(e: KeyboardEvent) {
  // Ignore Enter while an IME is composing (e.g. confirming a Japanese
  // conversion) so it does not send the half-typed message. keyCode 229
  // is the older-browser fallback for "still composing".
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="app">
    <div class="hero">
      <h1>Vue — @csbc-dev/ai-agent</h1>
      <p>
        <code>useWcBindable</code> from <code>@wc-bindable/vue</code> exposes
        <code>&lt;ai-agent&gt;</code> state as a reactive object.
      </p>
    </div>

    <!-- Headless I/O node — no UI of its own. -->
    <ai-agent
      :ref="binding.ref"
      :provider="provider"
      :model="model"
      :base-url="env.VITE_AI_BASE_URL || undefined"
      :api-key="env.VITE_AI_API_KEY || undefined"
      :system="env.VITE_AI_SYSTEM || undefined"
    />

    <div class="chat">
      <div class="chat-head">
        <h2>Chat</h2>
        <span class="badge">{{ model }}</span>
      </div>

      <div class="msgs">
        <div v-if="turns.length === 0 && !values.streaming" class="empty">
          Type a message and hit Send.<br />The assistant streams its reply.
        </div>
        <div v-for="(m, i) in turns" :key="i" :class="`msg ${m.role}`">
          <div class="role">{{ m.role === "user" ? "You" : "Assistant" }}</div>
          <div>{{ textOf(m.content) }}</div>
        </div>
        <!-- During streaming the assistant turn is not in `messages` yet —
             show the live `content` until it settles. -->
        <div v-if="values.streaming && values.content" class="msg assistant">
          <div class="role">Assistant <span class="dot" /></div>
          <div>{{ values.content }}</div>
        </div>
      </div>

      <p v-if="values.error" class="err">{{ errorText(values.error) }}</p>

      <div v-if="values.usage" class="usage">
        <span>prompt {{ values.usage.promptTokens }}</span>
        <span>completion {{ values.usage.completionTokens }}</span>
        <span>total {{ values.usage.totalTokens }}</span>
      </div>

      <div class="input">
        <textarea
          rows="1"
          placeholder="Message…"
          v-model="input"
          :disabled="values.loading"
          @keydown="onKeydown"
        />
        <button :disabled="values.loading" @click="send">Send</button>
      </div>
    </div>
  </div>
</template>

<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; font: 14px/1.6 system-ui, "Segoe UI", sans-serif; color: #1a1a2e; background: #f4f5fa; }
.app { width: min(680px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 64px; }
.hero h1 { margin: 0 0 4px; font-size: 1.6rem; letter-spacing: -0.02em; }
.hero p { margin: 0 0 20px; color: #5c5c7a; }
.chat { background: #fff; border: 1px solid #e3e4ee; border-radius: 16px; box-shadow: 0 12px 36px rgba(26,26,46,.07); overflow: hidden; display: flex; flex-direction: column; min-height: 440px; }
.chat-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #eef0f6; }
.chat-head h2 { margin: 0; font-size: .95rem; }
.badge { padding: 3px 10px; border-radius: 999px; background: #eef0ff; color: #4f46e5; font-size: .78rem; font-weight: 600; }
.msgs { flex: 1; padding: 18px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.empty { margin: auto; color: #9092a8; text-align: center; }
.msg { max-width: 84%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; }
.msg.user { align-self: flex-end; background: #6366f1; color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant { align-self: flex-start; background: #f1f1fa; border-bottom-left-radius: 4px; }
.role { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; opacity: .55; margin-bottom: 3px; }
.dot::after { content: "\25CF"; margin-left: 3px; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.err { margin: 0 18px 12px; padding: 10px 14px; border-radius: 12px; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
.usage { display: flex; gap: 14px; padding: 12px 18px; border-top: 1px solid #eef0f6; font-size: .78rem; color: #5c5c7a; }
.input { display: flex; gap: 8px; padding: 14px 18px; border-top: 1px solid #eef0f6; }
.input textarea { flex: 1; resize: none; border: 1px solid #e3e4ee; border-radius: 12px; padding: 10px 12px; font: inherit; outline: none; min-height: 44px; max-height: 140px; field-sizing: content; }
.input textarea:focus { border-color: #6366f1; }
.input button { border: 0; background: #6366f1; color: #fff; border-radius: 10px; padding: 0 18px; font: inherit; font-weight: 600; cursor: pointer; }
.input button:disabled { opacity: .5; cursor: not-allowed; }
</style>
