import { describe, it, expect } from "vitest";
import * as server from "../src/server";
import * as browser from "../src/index";
import { withoutThrowInternals } from "../src/withoutThrowInternals";

/**
 * `@csbc-dev/ai-agent/server` against the default (browser) barrel. That the
 * server entry loads without a DOM, and the `exports` map, are checked in
 * serverEntryNode.test.ts.
 */
describe("/server エントリ", () => {
  it("withoutThrowInternalsは/serverだけが公開し、ブラウザ用エントリには無い", () => {
    expect(server.withoutThrowInternals).toBe(withoutThrowInternals);
    expect("withoutThrowInternals" in browser).toBe(false);
  });

  it("Core・provider・toolレジストリはブラウザ用エントリと同じものを公開する", () => {
    for (const name of [
      "AiCore", "OpenAiProvider", "AnthropicProvider", "AzureOpenAiProvider", "GoogleProvider",
      "registerTool", "unregisterTool", "getRegisteredTool", "clearToolRegistry",
    ] as const) {
      expect(server[name]).toBe(browser[name]);
    }
  });

  it("Shell・bootstrap・要素の設定は/serverに無い", () => {
    for (const name of ["AiAgent", "AiMessageElement", "bootstrapAi", "getConfig", "getRemoteCoreUrl", "resetConfig"]) {
      expect(name in browser).toBe(true);
      expect(name in server).toBe(false);
    }
  });
});
