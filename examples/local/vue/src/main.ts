import { createApp } from "vue";
import { bootstrapAi } from "@csbc-dev/ai-agent";
import App from "./App.vue";

// Registers <ai-agent> + <ai-message>. Idempotent — HMR-safe.
bootstrapAi();

createApp(App).mount("#app");
