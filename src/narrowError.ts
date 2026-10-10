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
 * - Plain object that structurally matches `AiHttpError` (numeric `status`
 *   plus `statusText`) → treated as `AiHttpError`
 * - Anything else → wrapped in `new Error(String(value))`
 *
 * The status/statusText pair is required because lone `status` properties
 * appear on unrelated DOM types (`Response`, `XMLHttpRequest`,
 * `MediaKeySession`, custom event payloads), and accepting them as
 * AiHttpError would mis-shape the public `error` contract.
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
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number" &&
    "statusText" in error
  ) {
    return error as AiHttpError;
  }
  return new Error(String(error));
}
