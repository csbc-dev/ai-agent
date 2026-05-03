import { config } from "./config.js";

let refCount = 0;

function handleClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const triggerElement = target.closest<Element>(`[${config.triggerAttribute}]`);
  if (!triggerElement) return;

  const aiId = triggerElement.getAttribute(config.triggerAttribute);
  if (!aiId) return;

  const aiElement = document.getElementById(aiId);
  if (!aiElement || aiElement.tagName.toLowerCase() !== config.tagNames.ai) return;

  // Custom-element upgrade is asynchronous: a click that fires before the
  // <ai-agent> definition is registered (or before the upgrade reaches a
  // particular instance) lands on a plain HTMLElement that does not yet
  // expose `send()`. Calling it would throw a TypeError that escapes
  // through the click handler. Skip silently — there is no useful error
  // channel to surface this through (the element has not finished becoming
  // an Ai instance, so `ai-agent:error` would be no different from any
  // other event on a vanilla element).
  if (typeof (aiElement as any).send !== "function") return;

  // Route early-failure rejections (e.g. AiCore's synchronous prompt/model
  // validation, "_core not initialized" throws) through the element's error
  // channel so consumers can observe them via `ai-agent:error`. Without this,
  // autoTrigger silently swallows failures that did not transit AiCore's own
  // error path.
  //
  // Guard against double-dispatch: AiCore (`_setError`) and the Shell
  // (`_setErrorState`) already fire `ai-agent:error` on their own error
  // paths, so re-dispatching here when `el.error` is already populated would
  // produce a redundant second event for the same failure. We only dispatch
  // when the rejection slipped past those channels and left `el.error` null.
  const el = aiElement as any;
  el.send().catch((e: unknown) => {
    if (el.error != null) return;
    el.dispatchEvent(new CustomEvent("ai-agent:error", {
      detail: e instanceof Error ? e : new Error(String(e)),
      bubbles: true,
    }));
  });
}

export function registerAutoTrigger(): void {
  if (refCount++ === 0) {
    document.addEventListener("click", handleClick);
  }
}

export function unregisterAutoTrigger(): void {
  if (refCount <= 0) return;
  if (--refCount === 0) {
    document.removeEventListener("click", handleClick);
  }
}
