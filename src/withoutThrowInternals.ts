import type { ServerMessage, ServerTransport } from "@wc-bindable/remote";

export interface WithoutThrowInternalsOptions {
  /**
   * Called with the `error` of every `throw` reply, before `stack` and
   * `cause` are removed from it, so the server can log what the browser no
   * longer receives. With `RemoteShellProxy` 0.10 it is the envelope the
   * shell built (`RemoteSerializedError`: `name`, `message`, and `stack`,
   * `cause`, `code` when present), not the thrown value itself. The reply is
   * sent even if this throws.
   */
  onThrow?: (error: unknown) => void;
}

/**
 * The `throw` reply's error without `stack` and without `cause`; `name`,
 * `message`, `code` and any other field are kept. A copy: the envelope
 * `onThrow` was given is not modified. A non-object error is left as is.
 */
function forTheBrowser(error: unknown): unknown {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return error;
  const { stack: _stack, cause: _cause, ...rest } = error as Record<string, unknown>;
  return rest;
}

/**
 * Wrap the `ServerTransport` you hand to `RemoteShellProxy` so that no
 * server stack trace or `cause` chain reaches the browser in a `throw` reply.
 *
 * ```ts
 * const shell = new RemoteShellProxy(core, withoutThrowInternals(
 *   new WebSocketServerTransport(ws),
 *   { onThrow: (error) => log.error({ error }, "command failed") },
 * ));
 * ```
 *
 * `@wc-bindable/remote` 0.10's `RemoteShellProxy` answers a command that
 * throws or rejects — and a `setWithAck` whose setter throws — with a `throw`
 * envelope that carries the thrown error's `stack` and its `cause` chain, each
 * `Error` in it with its own `stack`, and it has no option to leave them out
 * (wc-bindable-protocol#38). For `AiCore` that is every validation failure of
 * `send()` (a missing `model`, an empty prompt, …) and every refused
 * `provider` / `messages` assignment: the browser receives the server's file
 * paths and module layout, and through `cause` whatever an `Error` there
 * carries. SPEC-extensions.md § Error envelope ("Security note on `stack` and
 * `cause`") says producers SHOULD omit both on an untrusted boundary.
 *
 * Only `throw` messages are changed, and only by sending a copy of their
 * `error` without `stack` and `cause`. `name`, `message` and `code` cross
 * unchanged, so the browser's rejection keeps its message and
 * `<ai-agent>` still classifies it by `code`. `sync` / `update` / `return`
 * are passed through as they are (`AiCore.error` has no `stack` to begin
 * with). The thrown error itself is not touched. `onClose` / `dispose` are
 * forwarded when the wrapped transport has them.
 *
 * Remove it once `@wc-bindable/remote` leaves `stack` / `cause` off the wire
 * itself (wc-bindable-protocol#38); until then it is the last hop before the
 * wire, so it covers every `throw` the shell sends, whatever was thrown.
 */
export function withoutThrowInternals(
  transport: ServerTransport,
  options: WithoutThrowInternalsOptions = {},
): ServerTransport {
  const { onThrow } = options;
  const wrapped: ServerTransport = {
    send(message: ServerMessage): void {
      if (message.type !== "throw") {
        transport.send(message);
        return;
      }
      if (onThrow) {
        try {
          onThrow(message.error);
        } catch {
          // A failing logger must not cost the browser its reply.
        }
      }
      transport.send({ ...message, error: forTheBrowser(message.error) });
    },
    onMessage(handler) {
      transport.onMessage(handler);
    },
  };
  if (transport.onClose) wrapped.onClose = (handler) => transport.onClose!(handler);
  if (transport.dispose) wrapped.dispose = () => transport.dispose!();
  return wrapped;
}
