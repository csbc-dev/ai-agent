import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [
    vue({
      template: {
        // Treat <ai-agent> / <ai-message> as native custom elements so Vue
        // does not try to resolve them as Vue components.
        compilerOptions: {
          isCustomElement: (tag) => tag === "ai-agent" || tag === "ai-message",
        },
      },
    }),
  ],
  server: { port: 5175 },
});
