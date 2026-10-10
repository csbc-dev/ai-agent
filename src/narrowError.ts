import { AiHttpError } from "./types.js";

/**
 * The message of the `Error` that stands in for a thrown value which has no
 * string form — `String(value)` itself throws (`Object.create(null)`, an
 * object whose `toString` / `valueOf` throw, a revoked `Proxy`, …). The same
 * text `@wc-bindable/remote` uses when it canonicalises such a throw.
 */
export const UNSTRINGIFIABLE_THROWN_VALUE = "<unstringifiable thrown value>";

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
 *   `AiHttpError` (see `toAiHttpError`). Checked before the next rule, so an
 *   HTTP-shaped object that also has a `message` stays an HTTP failure.
 * - Any other object with a string `message` (a plain `{ code, message }`, a
 *   pre-serialised `{ name, message }`, an `Error` from another realm, which
 *   fails `instanceof Error`) → a new `Error` with that `message`, named after
 *   the object's `name` when that is a non-empty string (otherwise `"Error"`)
 * - Anything else → `new Error(String(value))`, or
 *   `new Error(UNSTRINGIFIABLE_THROWN_VALUE)` when `String(value)` throws
 *
 * Never throws, whatever it is given: `AiCore` calls it from the `catch` that
 * also resets `loading` / `streaming`, so an exception here would leave the
 * Core stuck busy. A value whose fields cannot be read (a throwing getter, a
 * revoked `Proxy`) gets the last rule.
 *
 * The object rule follows `normaliseError` / `toError` in
 * `@csbc-dev/s3-uploader`: only `name` and `message` are taken. `stack`,
 * `code` and any other field are not copied, and the original value is not
 * attached as `cause` — so a plain object thrown with a `message` reads the
 * same in `AiCore.error` and `AiCore.originalError` as an `Error` with that
 * `name` / `message` would, instead of `"[object Object]"`.
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
  try {
    if (error instanceof Error) return error;
    if (typeof error === "object") {
      const source = error as Record<string, unknown>;
      const status = "status" in source ? source.status : undefined;
      if (typeof status === "number" && Number.isFinite(status) && "statusText" in source) {
        return toAiHttpError(status, source);
      }
      const { message } = source;
      if (typeof message === "string") {
        const narrowed = new Error(message);
        const { name } = source;
        if (typeof name === "string" && name !== "") narrowed.name = name;
        return narrowed;
      }
    }
  } catch {
    // A field could not be read (a throwing getter, a revoked Proxy — whose
    // `instanceof` check throws too). Fall back to the value's string form.
  }
  return new Error(safeString(error));
}

/** `String(value)`, or `UNSTRINGIFIABLE_THROWN_VALUE` when that throws. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSTRINGIFIABLE_THROWN_VALUE;
  }
}

/**
 * Project an AiHttpError-shaped value onto a fresh plain object holding
 * exactly the `AiHttpError` fields, each a JsonValue, with no
 * `undefined`-valued keys — the same "snapshot, never the caller's object"
 * rule `serializeError` applies to `Error`s. What the source carries beyond
 * those fields (a `Response`'s headers / url / body stream, a class's extra
 * properties) is dropped.
 *
 * - `status`: the finite number the caller already read from `source`.
 * - `statusText` / `body`: kept when a string, otherwise `""`. `body` is the
 *   response text; a `Response`'s body is an unread stream, which cannot be
 *   turned into text synchronously.
 * - `retryAfter`: kept only when a finite, non-negative number (seconds),
 *   otherwise omitted — matching how `AiCore` itself leaves out a missing or
 *   unparseable `Retry-After`.
 */
function toAiHttpError(status: number, source: Record<string, unknown>): AiHttpError {
  const { statusText, body, retryAfter } = source;
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
