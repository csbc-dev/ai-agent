/**
 * Return a copy of `value` with every object property whose value is
 * `undefined` removed, recursively through plain objects and plain arrays.
 * Nothing else is changed.
 *
 * Why this exists: throughout this package an optional field set to
 * `undefined` means "absent" — `cloneMessage`, `validateMessages`, `AiCore`
 * and every provider test `!== undefined`, and provider request bodies go
 * through `JSON.stringify`, which drops such keys. `@wc-bindable/remote`
 * >= 0.10 instead rejects the whole value (`WC_BINDABLE_INVALID_JSON_VALUE`
 * on the sender, a dropped `update` / `getterFailures` entry on the
 * producer — SPEC-extensions.md § Design invariants, invariant 3), so a
 * history or request that works in local mode would fail in remote mode only
 * because of an idiomatic `{ mediaType: maybeType }`. Omitting those keys
 * before the value reaches the wire keeps local and remote observably equal,
 * and is exactly what 0.8-era transports did implicitly.
 *
 * Deliberately NOT a JSON coercion: `Date`, `NaN` / `±Infinity`, `Map`,
 * class instances, functions, symbol keys, accessors, non-enumerable keys,
 * sparse holes and `undefined` array *elements* (a hole is not an absent
 * key) are left exactly as they are — when one is found, the containing
 * object or array is returned uncopied — so the wire validator still rejects
 * them with a path instead of this helper silently reshaping them. Cycles
 * are likewise returned uncopied rather than overflowing the stack here.
 */
export function omitUndefinedProperties<T>(value: T): T {
  return copy(value, new Set()) as T;
}

function copy(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (isArray ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null)) {
    return value;
  }
  if (ancestors.has(value)) return value;
  const out: Record<PropertyKey, unknown> = isArray ? [] as unknown as Record<PropertyKey, unknown> : Object.create(proto);
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key === "symbol" ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return value;
      }
      if (descriptor.value === undefined && !isArray) continue;
      // defineProperty (not assignment) so an own "__proto__" key stays an
      // own data property instead of replacing the copy's prototype.
      Object.defineProperty(out, key, {
        value: copy(descriptor.value, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    // Preserve trailing holes so the validator still sees a sparse array.
    if (isArray) (out as unknown as unknown[]).length = (value as unknown[]).length;
    return out;
  } finally {
    ancestors.delete(value);
  }
}
