import { describe, it, expect } from "vitest";
import { describeNonJsonValue } from "@wc-bindable/remote";
import { omitUndefinedProperties } from "../src/omitUndefinedProperties";

describe("omitUndefinedProperties", () => {
  it("プリミティブとnullはそのまま返す", () => {
    expect(omitUndefinedProperties("x")).toBe("x");
    expect(omitUndefinedProperties(1)).toBe(1);
    expect(omitUndefinedProperties(null)).toBeNull();
    expect(omitUndefinedProperties(undefined)).toBeUndefined();
  });

  it("入れ子のplain object/配列からundefined値のキーだけを除き、入力はmutateしない", () => {
    const input = {
      a: 1,
      b: undefined,
      nested: { c: "x", d: undefined, e: [{ f: undefined, g: null }] },
    };
    const out = omitUndefinedProperties(input);

    expect(out).toStrictEqual({ a: 1, nested: { c: "x", e: [{ g: null }] } });
    expect(describeNonJsonValue(out)).toBeNull();
    // コピーであり、元の値は変わらない
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
    expect("b" in input).toBe(true);
    expect("d" in input.nested).toBe(true);
  });

  it("配列のundefined要素は「欠落」ではないので残し、validatorに拒否させる", () => {
    const out = omitUndefinedProperties([1, undefined, 3]);
    expect(out).toStrictEqual([1, undefined, 3]);
    expect(describeNonJsonValue(out)).toMatch(/\[1\] is undefined/);
  });

  it("疎配列の穴（末尾含む）は保持する", () => {
    const sparse: unknown[] = [1];
    sparse.length = 3;
    const out = omitUndefinedProperties(sparse);
    expect(out).toHaveLength(3);
    expect(1 in out).toBe(false);
    expect(describeNonJsonValue(out)).toMatch(/sparse/);
  });

  it("配列の非indexプロパティもコピーしてvalidatorに拒否させる", () => {
    const arr: any = [1];
    arr.extra = "x";
    const out: any = omitUndefinedProperties(arr);
    expect(out.extra).toBe("x");
    expect(describeNonJsonValue(out)).toMatch(/non-index property/);
  });

  it("Date/Map/クラスインスタンス/Array subclassは変換せずそのまま返す", () => {
    class Foo { a = undefined; }
    class MyArray extends Array {}
    const date = new Date(0);
    const map = new Map();
    const foo = new Foo();
    const myArray = new MyArray();
    expect(omitUndefinedProperties(date)).toBe(date);
    expect(omitUndefinedProperties(map)).toBe(map);
    expect(omitUndefinedProperties(foo)).toBe(foo);
    expect(omitUndefinedProperties(myArray)).toBe(myArray);
    // 入れ子でも同様（NaN もそのまま）
    const out = omitUndefinedProperties({ when: date, n: NaN, gone: undefined });
    expect(out).toStrictEqual({ when: date, n: NaN });
    expect(describeNonJsonValue(out)).toMatch(/\$\.when is Date/);
  });

  it("accessor・symbolキー・非列挙プロパティを持つobjectはコピーせずそのまま返す", () => {
    const withAccessor = { get x() { return 1; }, y: undefined };
    expect(omitUndefinedProperties(withAccessor)).toBe(withAccessor);

    const withSymbol = { [Symbol("meta")]: 1, y: undefined };
    expect(omitUndefinedProperties(withSymbol)).toBe(withSymbol);

    const withHidden = { y: undefined };
    Object.defineProperty(withHidden, "hidden", { value: 1, enumerable: false });
    expect(omitUndefinedProperties(withHidden)).toBe(withHidden);
  });

  it("循環参照でもスタックオーバーフローせず、循環点は元の参照のまま残す", () => {
    const cyclic: any = { a: undefined, child: {} };
    cyclic.child.parent = cyclic;
    const out: any = omitUndefinedProperties(cyclic);
    expect(out).not.toBe(cyclic);
    expect("a" in out).toBe(false);
    expect(out.child.parent).toBe(cyclic);
    // 循環を含む値はvalidatorに拒否されるまま（ここでは黙って直さない）
    expect(describeNonJsonValue(out)).not.toBeNull();
    const selfRef: any = { x: 1 };
    selfRef.self = selfRef;
    expect(describeNonJsonValue(omitUndefinedProperties(selfRef))).toMatch(/cyclic/);
  });

  it("null prototypeのobjectとown __proto__キーを保つ", () => {
    const nullProto = Object.assign(Object.create(null), { a: 1, b: undefined });
    const out = omitUndefinedProperties(nullProto);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.keys(out)).toEqual(["a"]);

    const parsed = JSON.parse('{"__proto__": {"x": 1}, "y": 2}');
    const copied = omitUndefinedProperties(parsed);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(copied, "__proto__")).toBe(true);
    expect(describeNonJsonValue(copied)).toBeNull();
  });
});
