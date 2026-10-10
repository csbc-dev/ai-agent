import { test, expect } from "@playwright/test";
import { startServer } from "./server.js";

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0); // random available port
});

test.afterAll(async () => {
  await server.close();
});

test("non-streaming: send → response → state", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // sync delivered initial values
  expect(results.syncReceived).toBe(true);

  // Non-streaming send returns echoed content
  expect(results.nonStreamResult).toBe("Echo: Hello");
  expect(results.contentAfterNonStream).toBe("Echo: Hello");
  expect(results.loadingAfterNonStream).toBe(false);

  // Usage was collected
  expect(results.usageAfterNonStream).toEqual({
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  // Messages contain user + assistant
  expect(results.messagesAfterNonStream).toEqual([
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Echo: Hello" },
  ]);
});

test("streaming: send → chunked response → state", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // Streaming send returns the full accumulated content
  expect(results.streamResult).toBe("Echo: World");
  expect(results.contentAfterStream).toBe("Echo: World");
});

test("conversation accumulation: multiple sends", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // After non-stream + stream sends: 2 user + 2 assistant = 4 messages
  expect(results.messagesCount).toBe(4);
});

test("history reset via set()", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // After proxy.set("messages", []), history should be empty
  expect(results.messagesAfterReset).toEqual([]);
});

test("HTTP error propagates to error state", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  // Error send returns null
  expect(results.errorResult).toBeNull();

  // Error state should contain the HTTP status
  expect(results.errorState).not.toBeNull();
  expect(results.errorState.status).toBe(500);
});

test("non-HTTP error propagates to error state as a JSON snapshot", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);

  expect(results.networkErrorResult).toBeNull();
  // The server Core's error is a plain { name, message } object that
  // crossed the real WebSocket — not the previous HTTP error left in place by
  // a dropped update.
  expect(results.networkErrorState).not.toBeNull();
  expect(results.networkErrorState.name).toBe("TypeError");
  expect(typeof results.networkErrorState.message).toBe("string");
  expect(results.networkErrorState.status).toBeUndefined();
  // The server's stack trace is not sent to the browser (it stays on
  // core.originalError): the snapshot is exactly { name, message }.
  expect(results.networkErrorState.stack).toBeUndefined();
  expect(Object.keys(results.networkErrorState).sort()).toEqual(["message", "name"]);
});

test("bind() updates include loading transitions", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 10000 });

  const results = JSON.parse((await page.locator("#results").textContent())!);
  const updates: { name: string; value: unknown }[] = results.updates;

  // loading should have both true and false values
  const loadingValues = updates.filter((u) => u.name === "loading").map((u) => u.value);
  expect(loadingValues).toContain(true);
  expect(loadingValues).toContain(false);

  // content should have been updated
  const contentValues = updates.filter((u) => u.name === "content").map((u) => u.value);
  expect(contentValues.length).toBeGreaterThan(0);
  expect(contentValues).toContain("Echo: Hello");
});

// <ai-agent> itself (the built dist) over a real WebSocket: removing the
// element settles a pending send() as a transport failure whether the call
// still waits for the `provider` ack or already runs on the server.
test.describe("<ai-agent> removed during a remote send()", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${server.port}/element.html`);
    await expect(page.locator("#status")).toHaveText("ready");
  });

  test("while send() waits for the provider ack: resolves null with WC_BINDABLE_DISPOSED", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { createAgent, nextEvent, outcome } = (window as any).e2e;
      const el = createAgent();
      const synced = nextEvent(el, "ai-agent:messages-changed");
      document.body.append(el);
      await synced;
      el.setAttribute("provider", "openai"); // its ack is now in flight
      const result = outcome(el.send());
      el.remove();
      return { result: await result, errorCode: el.error?.code, loading: el.loading };
    });

    expect(r).toEqual({ result: { value: null }, errorCode: "WC_BINDABLE_DISPOSED", loading: false });
  });

  test("after send() was invoked: the same outcome, and loading=false reaches listeners", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { createAgent, nextEvent, outcome } = (window as any).e2e;
      const el = createAgent({ provider: "openai" });
      const loading: boolean[] = [];
      el.addEventListener("ai-agent:loading-changed", (e: CustomEvent) => loading.push(e.detail));
      const running = nextEvent(el, "ai-agent:loading-changed", (busy: boolean) => busy === true);
      document.body.append(el);
      const result = outcome(el.send());
      await running; // the server-side inference is under way
      el.remove();
      return { result: await result, errorCode: el.error?.code, loading: el.loading, lastLoadingEvent: loading.at(-1) };
    });

    expect(r).toEqual({
      result: { value: null },
      errorCode: "WC_BINDABLE_DISPOSED",
      loading: false,
      lastLoadingEvent: false,
    });
  });

  test("a provider the server refuses still makes send() reject", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { createAgent, nextEvent, outcome } = (window as any).e2e;
      const el = createAgent();
      const synced = nextEvent(el, "ai-agent:messages-changed");
      document.body.append(el);
      await synced;
      el.setAttribute("provider", "no-such-provider");
      const result = await outcome(el.send());
      const errorMessage = el.error?.message;
      el.remove();
      return { result, errorMessage };
    });

    expect(r.result.error.message).toContain('Unknown provider: "no-such-provider"');
    expect(r.errorMessage).toContain('Unknown provider: "no-such-provider"');
  });
});
