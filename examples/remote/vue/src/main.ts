import { createApp } from "vue";
import { bootstrapAi } from "@csbc-dev/ai-agent";
import App from "./App.vue";

const remoteUrl = import.meta.env.VITE_AI_REMOTE_URL || "ws://localhost:8080/ai-agent";

// Enable remote mode before the custom elements are registered. bootstrapAi()
// applies the config and *then* runs customElements.define, so every
// <ai-agent> upgrades straight into remote mode (opens a WebSocket to the
// server-side Core instead of constructing a local AiCore).
bootstrapAi({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: remoteUrl,
  },
});

createApp(App).mount("#app");
