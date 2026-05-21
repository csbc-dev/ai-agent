import { useState } from "react";
import { useWcBindable } from "@wc-bindable/react";
import type { AiAgent, AiAgentValues, AiContent } from "@csbc-dev/ai-agent";

const env = import.meta.env;
const provider = env.VITE_AI_PROVIDER || "openai";
const model = env.VITE_AI_MODEL || "gpt-4o-mini";

function textOf(content: AiContent): string {
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

function errorText(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  // AiHttpError = { status, statusText, body, retryAfter }. Many 401/403/429
  // responses ship an empty body, so fall back to statusText / status to avoid
  // an empty red banner (matches the vanilla / vue / wcstack helpers).
  if (typeof err === "object" && err !== null && "status" in err) {
    const e = err as { status: number; statusText?: string; body?: string };
    return String(e.body || e.statusText || `HTTP ${e.status}`);
  }
  return String(err);
}

export default function App() {
  // Identical to the local-mode example — useWcBindable does not care
  // whether the Core behind <ai-agent> is local or proxied over WebSocket.
  const [aiRef, values] = useWcBindable<AiAgent, AiAgentValues>();
  const [input, setInput] = useState("");

  const { content, messages, usage, loading, streaming, error } = values;
  const turns = (messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");

  function send() {
    const text = input.trim();
    const el = aiRef.current;
    if (!text || loading || !el) return;
    setInput("");
    el.prompt = text;
    // Provider errors AND remote connection/transport failures both surface
    // through the `error` property (rendered below).
    el.send().catch(() => {});
  }

  return (
    <div className="app">
      <div className="hero">
        <h1>React — @csbc-dev/ai-agent (remote)</h1>
        <p>
          Remote mode. The Core runs on the WebSocket server;{" "}
          <code>useWcBindable</code> binds the proxied <code>&lt;ai-agent&gt;</code>{" "}
          exactly as in local mode.
        </p>
      </div>

      {/* Headless I/O node — proxies a server-side Core over WebSocket.
          No base-url / api-key: the server owns provider credentials. */}
      <ai-agent ref={aiRef} provider={provider} model={model} />

      <div className="chat">
        <div className="chat-head">
          <h2>Chat</h2>
          <span className="badge">{model}</span>
        </div>

        <div className="msgs">
          {turns.length === 0 && !streaming && (
            <div className="empty">
              Type a message and hit Send.
              <br />
              The assistant streams its reply.
            </div>
          )}
          {turns.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="role">{m.role === "user" ? "You" : "Assistant"}</div>
              <div>{textOf(m.content)}</div>
            </div>
          ))}
          {streaming && content && (
            <div className="msg assistant">
              <div className="role">
                Assistant <span className="dot" />
              </div>
              <div>{content}</div>
            </div>
          )}
        </div>

        {error && <p className="err">{errorText(error)}</p>}

        {usage && (
          <div className="usage">
            <span>prompt {usage.promptTokens}</span>
            <span>completion {usage.completionTokens}</span>
            <span>total {usage.totalTokens}</span>
          </div>
        )}

        <div className="input">
          <textarea
            rows={1}
            placeholder="Message…"
            value={input}
            disabled={loading}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Ignore Enter while an IME is composing (e.g. confirming a
              // Japanese conversion) so it does not send the half-typed
              // message. keyCode 229 is the older-browser fallback.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button onClick={send} disabled={loading}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
