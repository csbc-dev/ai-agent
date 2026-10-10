import { describe, it, expect } from "vitest";
import { narrowError, UNSTRINGIFIABLE_THROWN_VALUE } from "../src/narrowError";

describe("narrowError", () => {
  it("null / undefinedはnull", () => {
    expect(narrowError(null)).toBeNull();
    expect(narrowError(undefined)).toBeNull();
  });

  it("Error（サブクラス含む）は同じインスタンスのまま返す", () => {
    const error = new RangeError("out of range");
    expect(narrowError(error)).toBe(error);
  });

  it("status / statusTextを持つobjectはAiHttpErrorに射影する（messageを持っていても）", () => {
    const thrown = { status: 429, statusText: "Too Many Requests", body: "slow down", retryAfter: 7, message: "rate limited" };
    expect(narrowError(thrown)).toStrictEqual({ status: 429, statusText: "Too Many Requests", body: "slow down", retryAfter: 7 });
  });

  it("statusが有限数でなければHTTP形とみなさない", () => {
    const narrowed = narrowError({ status: Number.NaN, statusText: "?", message: "not http" });
    expect(narrowed).toBeInstanceOf(Error);
    expect((narrowed as Error).message).toBe("not http");
  });

  describe("文字列のmessageを持つobject", () => {
    it("{ code, message } → messageのError（nameは\"Error\"、causeもcodeも付けない）", () => {
      const narrowed = narrowError({ code: "E_UPSTREAM", message: "upstream refused" }) as Error;
      expect(narrowed).toBeInstanceOf(Error);
      expect(narrowed.name).toBe("Error");
      expect(narrowed.message).toBe("upstream refused");
      expect("cause" in narrowed).toBe(false);
      expect((narrowed as Error & { code?: unknown }).code).toBeUndefined();
    });

    it("{ name, message } → そのname / messageのError", () => {
      const narrowed = narrowError({ name: "AccessDenied", message: "denied" }) as Error;
      expect(narrowed).toBeInstanceOf(Error);
      expect(narrowed.name).toBe("AccessDenied");
      expect(narrowed.message).toBe("denied");
    });

    it("空のmessageも文字列なのでそのまま使う", () => {
      const narrowed = narrowError({ name: "Empty", message: "" }) as Error;
      expect(narrowed.name).toBe("Empty");
      expect(narrowed.message).toBe("");
    });

    it.each([
      ["空文字", ""],
      ["数値", 42],
      ["null", null],
    ])("nameが%sならname \"Error\"", (_label, name) => {
      const narrowed = narrowError({ name, message: "boom" }) as Error;
      expect(narrowed.name).toBe("Error");
      expect(narrowed.message).toBe("boom");
    });

    it("継承したmessage / nameも使う（Errorを継承しない別realmのError相当）", () => {
      const foreign = Object.create({ name: "TypeError", message: "inherited" });
      const narrowed = narrowError(foreign) as Error;
      expect(narrowed.name).toBe("TypeError");
      expect(narrowed.message).toBe("inherited");
    });
  });

  describe("それ以外はString(value)のError", () => {
    it.each([
      ["文字列", "boom", "boom"],
      ["数値", 42, "42"],
      ["Symbol", Symbol("sym"), "Symbol(sym)"],
      ["messageを持たないobject", { reason: "x" }, "[object Object]"],
      ["messageが文字列でないobject", { message: 42 }, "[object Object]"],
      ["配列", [1, 2], "1,2"],
    ])("%s", (_label, thrown, message) => {
      const narrowed = narrowError(thrown) as Error;
      expect(narrowed).toBeInstanceOf(Error);
      expect(narrowed.name).toBe("Error");
      expect(narrowed.message).toBe(message);
    });

    it("messageのgetterが例外を投げるobjectはString(value)にフォールバック", () => {
      const hostile = { get message(): string { throw new Error("message getter"); } };
      expect((narrowError(hostile) as Error).message).toBe("[object Object]");
    });
  });

  describe("String(value)自体が例外を投げる値でも例外を漏らさず固定のmessageにする", () => {
    const revoked = (): object => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    it.each([
      ["Object.create(null)", () => Object.create(null)],
      ["toStringが例外を投げるobject", () => ({ toString() { throw new Error("no string form"); } })],
      ["revokeされたProxy（instanceofも例外を投げる）", revoked],
      ["statusのgetterが例外を投げるnull-prototype object", () => Object.create(null, {
        status: { get() { throw new Error("status getter"); }, enumerable: true },
      })],
    ])("%s", (_label, makeThrown) => {
      let narrowed: unknown;
      expect(() => { narrowed = narrowError(makeThrown()); }).not.toThrow();
      expect(narrowed).toBeInstanceOf(Error);
      expect((narrowed as Error).name).toBe("Error");
      expect((narrowed as Error).message).toBe(UNSTRINGIFIABLE_THROWN_VALUE);
    });

    it("固定のmessageは@wc-bindable/remoteと同じ文言", () => {
      expect(UNSTRINGIFIABLE_THROWN_VALUE).toBe("<unstringifiable thrown value>");
    });
  });
});
