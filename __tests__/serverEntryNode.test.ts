// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file: string): Record<string, any> => JSON.parse(readFileSync(join(root, file), "utf8"));

/**
 * The server entry in an environment without a DOM, like a Node server. The
 * default barrel defines the custom elements (`class … extends HTMLElement`)
 * at load time, so it cannot be loaded there; `/server` must not import it.
 */
describe("/server エントリ（DOMの無い環境）", () => {
  it("HTMLElementの無い環境でも読み込め、AiCoreとwithoutThrowInternalsを使える", async () => {
    expect(typeof (globalThis as { HTMLElement?: unknown }).HTMLElement).toBe("undefined");
    const server = await import("../src/server");
    expect(typeof server.withoutThrowInternals).toBe("function");
    const core = new server.AiCore();
    core.provider = "openai";
    expect(core.provider).toBeInstanceOf(server.OpenAiProvider);
  });

  it("ブラウザ用エントリはHTMLElementの無い環境では読み込めない（/serverが要る理由）", async () => {
    await expect(import("../src/index")).rejects.toThrow(/HTMLElement/);
  });

  it("package.jsonの./serverはsrc/server.tsをtscが出力する先を指す", () => {
    const pkg = readJson("package.json");
    expect(pkg.exports["./server"]).toStrictEqual({ types: "./dist/server.d.ts", default: "./dist/server.js" });
    expect(readJson("tsconfig.json").compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist", declaration: true });
    expect(pkg.files).toContain("dist");
  });
});
