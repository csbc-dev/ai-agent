import { AiHttpError } from "./types.js";

/**
 * Coerce an arbitrary thrown value into the public `error` contract
 * (`AiHttpError | Error | null`). Used by both `AiCore._setError` and
 * `Ai._setErrorState` so that consumers see a uniform shape regardless of
 * whether the failure originated in the Core or in the Shell-level wiring
 * (provider apply, remote transport setup, disconnected `_core`, etc.).
 *
 * - `null` / `undefined` → `null`
 * - `Error` (any subclass) → returned as-is
 * - Object that structurally matches `AiHttpError` (finite numeric `status`
 *   plus a `statusText` key, own or inherited) → projected onto a fresh plain
 *   `AiHttpError` (see `toAiHttpError`)
 * - Anything else → wrapped in `new Error(String(value))`
 *
 * The status/statusText pair is required because a lone `status` property
 * appears on many unrelated objects (custom event payloads, library result
 * objects, …), and accepting them as AiHttpError would mis-shape the public
 * `error` contract. A thrown `Response` / `XMLHttpRequest`, or an HTTP-error
 * class that does not extend `Error`, does carry the pair and is treated as
 * an HTTP failure — but only through the projection: storing the value
 * itself would hand consumers a class instance typed as the plain
 * `AiHttpError`, and a Core holding it would fail `@wc-bindable/remote`'s
 * JsonValue gate (the `update` is dropped and `sync` lists `error` in
 * `getterFailures`, so a remote client's `error` never arrives).
 *
 * Note: this helper keeps `Error` instances as `Error`s. Turning them into
 * the JSON-safe `AiSerializedError` snapshot is a Core-only concern (the
 * Core's state must pass `@wc-bindable/remote`'s JsonValue gate) and is
 * applied by `AiCore._setError` after this narrowing; Shell-level errors
 * (`Ai._setErrorState`) never cross the wire and stay `Error` instances.
 */
export function narrowError(error: unknown): AiHttpError | Error | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return error;
  if (
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number" &&
    Number.isFinite((error as { status: number }).status) &&
    "statusText" in error
  ) {
    return toAiHttpError(error as { status: number } & Record<string, unknown>);
  }
  return new Error(String(error));
}

/**
 * Project an AiHttpError-shaped value onto a fresh plain object holding
 * exactly the `AiHttpError` fields, each a JsonValue, with no
 * `undefined`-valued keys — the same "snapshot, never the caller's object"
 * rule `serializeError` applies to `Error`s. What the source carries beyond
 * those fields (a `Response`'s headers / url / body stream, a class's extra
 * properties) is dropped.
 *
 * - `status`: kept (the caller guarantees a finite number).
 * - `statusText` / `body`: kept when a string, otherwise `""`. `body` is the
 *   response text; a `Response`'s body is an unread stream, which cannot be
 *   turned into text synchronously.
 * - `retryAfter`: kept only when a finite, non-negative number (seconds),
 *   otherwise omitted — matching how `AiCore` itself leaves out a missing or
 *   unparseable `Retry-After`.
 */
function toAiHttpError(source: { status: number } & Record<string, unknown>): AiHttpError {
  const { status, statusText, body, retryAfter } = source;
  const projected: AiHttpError = {
    status,
    statusText: typeof statusText === "string" ? statusText : "",
    body: typeof body === "string" ? body : "",
  };
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    projected.retryAfter = retryAfter;
  }
  return projected;
}
